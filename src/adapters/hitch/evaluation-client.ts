import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HitchConfig } from '../../config.js'
import { EvaluationCleanupError } from '../../evaluator/cleanup.js'
import { digestDatasetRef } from '../../state/dataset.js'
import { digestJson } from '../../state/digest.js'
import type {
  EvaluationRequest,
  EvaluationRerunReservation,
  EvaluationRerunResult,
  EvaluationRerunSelector,
  EvaluationReservation,
  EvaluationSubmissionIntent,
  HitchCapabilities,
  HitchEvaluationEvidence,
  HitchVerifierEvidence,
  RoundEvaluationAttempt,
} from '../../types.js'
import type { HitchExecutionContext } from './contracts.js'
import { HitchEvaluationError, type HitchEvaluationIdentity, type JsonRecord, type ProcessResult } from './contracts.js'
import { HitchExecutionContract } from './execution-contract.js'
import { parseResult } from './result-wire.js'
import { runHitch } from './transport.js'
import { HitchVerifierEvidenceReader } from './verifier-reader.js'
import {
  digest,
  excerpt,
  integer,
  record,
  sha256,
  string,
  stringArray,
  trialSlots,
  validMemorySize,
} from './wire-primitives.js'

export interface HitchEvaluationClientOptions extends HitchConfig {
  repositoryPath: string
}

/** Durable Hitch execution and recovery, independent of legacy refinement state or diagnostic paging. */
export class HitchEvaluationClient {
  readonly repositoryPath: string

  private readonly execution: HitchExecutionContract

  private executablePathPromise?: Promise<string>

  constructor(readonly options: HitchEvaluationClientOptions) {
    this.repositoryPath = resolve(options.repositoryPath)
    this.execution = new HitchExecutionContract(options, this.repositoryPath)
    if (options.executable.length === 0) throw new TypeError('hitch.executable must not be empty')
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(options.harnessId)) throw new TypeError('hitch.harnessId is invalid')
    if (!Number.isSafeInteger(options.attempts) || options.attempts <= 0)
      throw new TypeError('hitch.attempts must be a positive integer')
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0)
      throw new TypeError('hitch.maxConcurrent must be a positive integer')
    if (!Number.isSafeInteger(options.setupTimeoutMs) || options.setupTimeoutMs < 0)
      throw new TypeError('hitch.setupTimeoutMs must be non-negative')
    if (!Number.isSafeInteger(options.terminationGraceMs) || options.terminationGraceMs < 0)
      throw new TypeError('hitch.terminationGraceMs must be non-negative')
    if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)
      throw new TypeError('hitch.maxOutputBytes must be positive')
    if (!Number.isSafeInteger(options.maxTrajectoryOutputBytes) || options.maxTrajectoryOutputBytes <= 0) {
      throw new TypeError('hitch.maxTrajectoryOutputBytes must be positive')
    }
    if (
      options.maxTrajectoryAnalysisBytes !== undefined &&
      (!Number.isSafeInteger(options.maxTrajectoryAnalysisBytes) || options.maxTrajectoryAnalysisBytes <= 0)
    ) {
      throw new TypeError('hitch.maxTrajectoryAnalysisBytes must be positive')
    }
    if (
      options.maxTrajectoryEventsBytes !== undefined &&
      (!Number.isSafeInteger(options.maxTrajectoryEventsBytes) || options.maxTrajectoryEventsBytes <= 0)
    ) {
      throw new TypeError('hitch.maxTrajectoryEventsBytes must be positive')
    }
    if (
      options.trajectoryCacheEntries !== undefined &&
      (!Number.isSafeInteger(options.trajectoryCacheEntries) || options.trajectoryCacheEntries <= 0)
    ) {
      throw new TypeError('hitch.trajectoryCacheEntries must be positive')
    }
    if (
      options.trajectoryCacheBytes !== undefined &&
      (!Number.isSafeInteger(options.trajectoryCacheBytes) || options.trajectoryCacheBytes <= 0)
    ) {
      throw new TypeError('hitch.trajectoryCacheBytes must be positive')
    }
    if (options.passEnv.some((name) => !/^[A-Z_][A-Z0-9_]*$/u.test(name)))
      throw new TypeError('hitch.passEnv contains an invalid environment variable name')
    const controlPlane = this.execution.controlPlane
    if (controlPlane.mode !== 'direct' && controlPlane.mode !== 'daemon')
      throw new TypeError('hitch.controlPlane.mode is invalid')
    if (
      controlPlane.provider !== undefined &&
      (!controlPlane.provider.trim() || /[\0\r\n]/u.test(controlPlane.provider))
    ) {
      throw new TypeError('hitch.controlPlane.provider is invalid')
    }
    if (
      controlPlane.cpuPerTrial !== undefined &&
      (!Number.isSafeInteger(controlPlane.cpuPerTrial) || controlPlane.cpuPerTrial <= 0)
    ) {
      throw new TypeError('hitch.controlPlane.cpuPerTrial must be a positive integer')
    }
    if (controlPlane.memoryPerTrial !== undefined && !validMemorySize(controlPlane.memoryPerTrial)) {
      throw new TypeError(
        'hitch.controlPlane.memoryPerTrial must be a positive whole number of MiB using B, KiB, MiB, or GiB',
      )
    }
    if (
      controlPlane.buildMode !== undefined &&
      !new Set(['backend', 'prebuild-preferred', 'prebuild-required']).has(controlPlane.buildMode)
    ) {
      throw new TypeError('hitch.controlPlane.buildMode is invalid')
    }
    if (
      controlPlane.modelCapture !== undefined &&
      !new Set(['off', 'native', 'proxy', 'hybrid']).has(controlPlane.modelCapture)
    ) {
      throw new TypeError('hitch.controlPlane.modelCapture is invalid')
    }
    if (controlPlane.modelCapture === 'off' && controlPlane.requireModelCapture) {
      throw new TypeError('hitch.controlPlane.modelCapture=off cannot be required')
    }
    if (controlPlane.mode === 'direct' && this.execution.controlPlanePolicyIsExplicit()) {
      throw new TypeError('hitch.controlPlane execution policy requires mode=daemon')
    }
  }

  async preflight(): Promise<void> {
    await this.checkVersion()
    if (this.execution.daemonMode) await this.checkDaemon()
    await this.inspectCapabilities(new AbortController().signal)
  }

  inspectVerifierEvidence(runId: string, signal: AbortSignal): Promise<HitchVerifierEvidence> {
    return new HitchVerifierEvidenceReader(
      this.options,
      this.repositoryPath,
      this.run.bind(this),
    ).inspectVerifierEvidence(runId, signal)
  }

  private async checkVersion(signal?: AbortSignal): Promise<string> {
    await this.executablePath()
    const controller = new AbortController()
    const abortFromCaller = (): void => controller.abort(signal?.reason)
    if (signal?.aborted === true) abortFromCaller()
    else signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(
      () =>
        controller.abort(
          new HitchEvaluationError(
            `Hitch version check timed out for ${this.options.executable}; Gear requires agent-hitch >= 0.2.5`,
            'hitch_version_check_failed',
          ),
        ),
      5_000,
    )
    let result: ProcessResult
    try {
      result = await this.run(['--version'], this.repositoryPath, controller.signal, 16_384)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch version check failed: ${output.slice(-4000)}`, 'hitch_version_check_failed')
    }
    const match = output.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\D|$)/u)
    if (match === null) {
      throw new HitchEvaluationError(`unsupported Hitch CLI version output: ${output}`, 'unsupported_hitch_version')
    }
    const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number]
    const minimumPatch = this.execution.daemonMode ? 6 : 5
    const coreAboveMinimum = major > 0 || (major === 0 && (minor > 2 || (minor === 2 && patch > minimumPatch)))
    const coreAtMinimum = major === 0 && minor === 2 && patch === minimumPatch
    const supported = coreAboveMinimum || (coreAtMinimum && match[4] === undefined)
    if (!supported) {
      const minimum = `0.2.${minimumPatch}`
      throw new HitchEvaluationError(
        `unsupported Hitch CLI ${match[0].trim()}; Gear requires agent-hitch >= ${minimum}${this.execution.daemonMode ? ' for daemon eval control-plane support' : ' for stable eval identity and multi-attempt rerun'}`,
        'unsupported_hitch_version',
      )
    }
    return sha256(output)
  }

  private async checkDaemon(): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(
      () =>
        controller.abort(
          new HitchEvaluationError(
            `Hitch daemon status check timed out for root ${this.options.root || '<default>'}`,
            'hitch_daemon_check_failed',
          ),
        ),
      5_000,
    )
    let result: ProcessResult
    try {
      result = await this.run(
        [...this.rootArgs(), 'daemon', 'status', '--json'],
        this.repositoryPath,
        controller.signal,
        64 * 1024,
      )
    } finally {
      clearTimeout(timeout)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch (error) {
      throw new HitchEvaluationError(
        `Hitch emitted invalid daemon status JSON (${String(error)})`,
        'invalid_hitch_json',
      )
    }
    const health = record(parsed, 'Hitch daemon health')
    if (result.exitCode !== 0 || health.schema_version !== '1' || health.status !== 'running') {
      throw new HitchEvaluationError(
        `Hitch daemon is not running for root ${this.options.root || '<default>'}: ${result.stderr.slice(-4000)}`,
        'hitch_daemon_unavailable',
      )
    }
    const policy = record(health.resource_policy, 'Hitch daemon resource policy')
    this.execution.parseResourceVector(policy.eval_trial, 'Hitch daemon eval trial policy')
  }

  prepareSubmission(
    round: Readonly<HitchExecutionContext>,
    request: Readonly<EvaluationRequest>,
  ): EvaluationSubmissionIntent | undefined {
    if (!this.execution.daemonMode) return undefined
    this.execution.assertEvaluationRequest(round, request)
    return {
      provider: 'hitch-cli',
      idempotencyKey: this.execution.daemonIdempotencyKey(round, request),
      parameters: {
        root: this.options.root,
        args: [...this.execution.controlPlaneArgs(), ...this.evalRequestArgs(round, request)],
      },
    }
  }

  async reserve(
    round: Readonly<HitchExecutionContext>,
    _request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<EvaluationReservation> {
    signal?.throwIfAborted()
    // A stored intent must remain recoverable even if the configured mode changed.
    if (intent !== undefined) return this.reserveDaemonEvaluation(round, intent, signal)
    if (this.execution.daemonMode) throw new TypeError('Hitch daemon submission requires a persisted submission intent')
    return { provider: 'hitch-cli', evalId: `eval_${randomUUID().replaceAll('-', '')}` }
  }

  private async reserveDaemonEvaluation(
    round: Readonly<HitchExecutionContext>,
    intent: Readonly<EvaluationSubmissionIntent>,
    signal?: AbortSignal,
  ): Promise<EvaluationReservation> {
    const parameters = this.submissionParameters(intent)
    const args = [
      ...(parameters.root.length === 0 ? [] : ['--root', parameters.root]),
      'eval',
      'submit',
      '--idempotency-key',
      intent.idempotencyKey,
      ...parameters.args,
    ]
    const timeout = AbortSignal.timeout(30_000)
    const result = await this.run(
      args,
      round.workspaceRoot,
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      64 * 1024,
    )
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(
        `Hitch daemon eval submission failed: ${result.stderr.slice(-4000)}`,
        'hitch_eval_submit_failed',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch (error) {
      throw new HitchEvaluationError(
        `Hitch emitted invalid eval submission JSON (${String(error)})`,
        'invalid_hitch_json',
      )
    }
    const accepted = record(parsed, 'Hitch eval submission')
    const evalId = string(accepted.eval_id, 'eval submission eval_id')
    if (
      accepted.schema_version !== '1' ||
      !/^eval_[0-9a-f]{32}$/u.test(evalId) ||
      !new Set(['queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed']).has(accepted.status as string)
    ) {
      throw new HitchEvaluationError('Hitch eval submission identity/status is invalid', 'invalid_hitch_result')
    }
    return { provider: 'hitch-cli', evalId }
  }

  private submissionParameters(intent: Readonly<EvaluationSubmissionIntent>): { root: string; args: string[] } {
    if (intent.provider !== 'hitch-cli' || !/^gear-eval-v1-[0-9a-f]{64}$/u.test(intent.idempotencyKey)) {
      throw new TypeError('Hitch submission intent identity is invalid')
    }
    const parameters = record(intent.parameters, 'Hitch submission parameters')
    if (typeof parameters.root !== 'string') throw new TypeError('Hitch submission root is invalid')
    return { root: parameters.root, args: stringArray(parameters.args, 'Hitch submission arguments') }
  }

  async recoverReservation(
    round: Readonly<HitchExecutionContext>,
    _request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
    intent: Readonly<EvaluationSubmissionIntent>,
  ): Promise<EvaluationReservation> {
    this.submissionParameters(intent)
    try {
      return await this.reserveDaemonEvaluation(round, intent, signal)
    } catch (submissionError) {
      // Hitch resolves daemon defaults before checking the idempotency index.
      // Changed defaults or unavailable execution capacity can reject a replay
      // even though the original evaluation still exists. Locate its frozen key
      // through the public read-only CLI so it can still be cancelled.
      signal.throwIfAborted()
      const found = await this.lookupReservation(intent, signal)
      if (found) return found
      throw submissionError
    }
  }

  /** Find a possibly accepted intent without creating or restarting any evaluation. */
  async lookupReservation(
    intent: Readonly<EvaluationSubmissionIntent>,
    signal: AbortSignal,
  ): Promise<EvaluationReservation | undefined> {
    signal.throwIfAborted()
    const parameters = this.submissionParameters(intent)
    const rootArgs = parameters.root.length === 0 ? [] : ['--root', parameters.root]
    const listed = await this.run([...rootArgs, 'eval', 'list', '--json'], this.repositoryPath, signal)
    if (listed.exitCode !== 0)
      throw new HitchEvaluationError(
        'Could not inspect pending Hitch submissions',
        'hitch_eval_recovery_inspect_failed',
      )
    const list = record(JSON.parse(listed.stdout), 'Hitch evaluation list')
    if (list.schema_version !== '1' || !Array.isArray(list.evals))
      throw new HitchEvaluationError('Invalid Hitch evaluation listing', 'invalid_hitch_result')
    for (const value of list.evals) {
      const entry = record(value, 'Hitch listed evaluation')
      const evalId = string(entry.eval_id, 'Hitch listed eval_id')
      if (!/^eval_[0-9a-f]{32}$/u.test(evalId))
        throw new HitchEvaluationError('Invalid Hitch evaluation ID', 'invalid_hitch_result')
      const inspection = await this.inspectEvaluation(
        evalId,
        this.repositoryPath,
        signal,
        'hitch_eval_recovery_inspect_failed',
        parameters.root,
      )
      if (inspection.submission === undefined) continue
      const submission = record(inspection.submission, 'Hitch persisted submission')
      if (
        submission.schema_version === '1' &&
        submission.eval_id === evalId &&
        submission.idempotency_key_hash === sha256(intent.idempotencyKey)
      ) {
        return { provider: 'hitch-cli', evalId }
      }
    }
    return undefined
  }

  async cancelReservation(
    reservation: Readonly<EvaluationReservation>,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<void> {
    if (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId)) {
      throw new TypeError('Hitch cancellation reservation is invalid')
    }
    const root = intent === undefined ? this.options.root : this.submissionParameters(intent).root
    await this.cancelDaemonEvaluation(reservation.evalId, this.repositoryPath, root)
  }

  private rootArgs(): string[] {
    return this.options.root.length === 0 ? [] : ['--root', this.options.root]
  }

  private evalRequestArgs(round: Readonly<HitchExecutionContext>, request: Readonly<EvaluationRequest>): string[] {
    const source = `git+${pathToFileURL(this.repositoryPath).href}#${request.harnessRef}`
    return [
      '--backend',
      'harbor',
      '--dataset',
      request.dataset,
      '--harness',
      `${this.options.harnessId}@${source}`,
      ...(request.condition.model.length === 0 ? [] : ['--model', request.condition.model]),
      '--attempts',
      String(request.condition.repetitions),
      '--max-concurrent',
      String(this.options.maxConcurrent),
      '--timeout',
      `${round.taskBudgetMs}ms`,
      '--setup-timeout',
      `${this.options.setupTimeoutMs}ms`,
      ...this.options.agentArgs.flatMap((value) => ['--agent-arg', value]),
      ...this.options.passEnv.flatMap((value) => ['--pass-env', value]),
    ]
  }

  async evaluationIdentity(
    round: Readonly<HitchExecutionContext>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
  ): Promise<HitchEvaluationIdentity | undefined> {
    signal?.throwIfAborted()
    // Daemon defaults are frozen at submission; prior evidence cannot be reused
    // until the current execution policy can be resolved before submission.
    if (this.execution.daemonMode) return undefined
    // Settled evidence has already passed Hitch planning. Verify that the whole
    // compiled dataset, including its adapter/scoring manifest, is unchanged.
    // Unknown legacy identities stay unresolved; the service must block reuse
    // rather than treating that uncertainty as permission to run more trials.
    const fileSelection = await lstat(resolve(round.workspaceRoot, request.dataset))
      .then((s) => s.isFile())
      .catch((error) => {
        if (error.code !== 'ENOENT') throw error
        return false
      })
    if (fileSelection || (await this.hasStandardBenchmarkManifest(round, request))) {
      const datasetDigest = await digestDatasetRef(request.dataset, round.workspaceRoot)
      signal?.throwIfAborted()
      if (datasetDigest !== request.condition.dataset.digest) return undefined
    }
    return this.resolveEvaluationIdentity(round, request, signal)
  }

  async resourcePreflight(
    input: { ref: string; owner: string; generation: number },
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{
    protocol: 'hitch-resource-preflight@1'
    inputDigest: string
    planDigest: string
    plans: import('../../state/resource-contract.js').ResourcePlan[]
  }> {
    const temp = await mkdtemp(join(tmpdir(), 'gear-resource-preflight-'))
    try {
      const file = join(temp, 'request.json')
      await writeFile(file, JSON.stringify(input), { mode: 0o600 })
      const result = await this.run(
        [...this.rootArgs(), 'resources', 'request', 'preflight', '--input', file],
        this.repositoryPath,
        signal,
      )
      if (result.exitCode !== 0) throw new Error(`Hitch resource preflight failed: ${result.stderr}`)
      const value = JSON.parse(result.stdout)
      if (value?.protocol !== 'hitch-resource-preflight@1' || !Array.isArray(value.plans))
        throw new Error('Hitch lacks the required resource preflight capability')
      digest(value.inputDigest, 'resource input digest')
      digest(value.planDigest, 'resource plan digest')
      return value
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }

  /** Reads the existing Hitch submission record; this adds no Hitch CLI command or protocol. */
  async submittedEvaluationIdentity(
    round: Readonly<HitchExecutionContext>,
    request: Readonly<EvaluationRequest>,
    reservation: Readonly<EvaluationReservation>,
    signal: AbortSignal,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<(HitchEvaluationIdentity & { cohortDigest: string }) | undefined> {
    if (!this.execution.daemonMode) return undefined
    this.execution.assertEvaluationRequest(round, request)
    if (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId))
      throw new TypeError('invalid evaluation reservation')
    const inspection = await this.inspectEvaluation(
      reservation.evalId,
      round.workspaceRoot,
      signal,
      'hitch_eval_inspect_failed',
      intent === undefined ? this.options.root : this.submissionParameters(intent).root,
    )
    const identity = this.execution.daemonEvaluationIdentity(
      round,
      request,
      inspection,
      await this.resolveEvaluationIdentity(round, request, signal),
    )
    const submission = record(inspection.submission, 'Hitch eval submission')
    // Task projections and candidate commits vary within one paired cohort.
    // All other submitted execution parameters (including daemon defaults) must agree.
    const {
      dataset: _dataset,
      harness_ref: _harness,
      attempts: _attempts,
      benchmark_id: _benchmark,
      benchmark_revision: _revision,
      ...submittedConfig
    } = record(submission.request, 'Hitch eval submitted request')
    const {
      conditionId: _condition,
      dataset: _projection,
      attempts: _repetitions,
      ...invocation
    } = this.execution.baseParity(round, request)
    const runtime = await this.runtimeIdentity(signal)
    // Also bind Gear's invocation controls, such as setup timeout and output limits,
    // without including the per-batch conditionId in the common identity.
    return {
      ...identity,
      cohortDigest: digestJson({
        provider: identity.provider,
        executionMode: 'daemon',
        execution: submission.execution,
        request: submittedConfig,
        scoringContract: 'benchmark-scores-v1',
        invocationFingerprint: this.execution.invocationFingerprint(digestJson(invocation), runtime),
      }),
    }
  }

  private async hasStandardBenchmarkManifest(
    round: Readonly<HitchExecutionContext>,
    request: Readonly<EvaluationRequest>,
  ): Promise<boolean> {
    try {
      await readFile(resolve(round.workspaceRoot, request.dataset, 'benchmark.adapter.json'))
      return true
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
      throw error
    }
  }

  private async resolveEvaluationIdentity(
    round: Readonly<HitchExecutionContext>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
  ): Promise<HitchEvaluationIdentity> {
    signal?.throwIfAborted()
    const hitchRuntimeIdentity = await this.runtimeIdentity(signal)
    signal?.throwIfAborted()
    const effectiveConfigDigest = this.execution.effectiveConfigDigest(round, request)
    const invocationFingerprint = this.execution.invocationFingerprint(effectiveConfigDigest, hitchRuntimeIdentity)
    return {
      provider: 'hitch-cli',
      effectiveConfigDigest,
      invocationFingerprint,
    }
  }

  async inspectCapabilities(signal: AbortSignal): Promise<HitchCapabilities> {
    signal.throwIfAborted()
    const processResult = await this.run(['capabilities', '--json'], this.repositoryPath, signal, 16_384)
    if (processResult.exitCode !== 0) {
      const output = `${processResult.stderr}\n${processResult.stdout}`.trim()
      throw new HitchEvaluationError(
        `Hitch bounded trajectory capabilities are unavailable: ${excerpt(output, 1_000)}`,
        'hitch_trajectory_capabilities_unavailable',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(processResult.stdout)
    } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid capabilities JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const value = record(parsed, 'Hitch capabilities')
    if (value.schema_version !== '1' || value.trajectory_analysis !== '1' || value.trajectory_events_page !== '1') {
      throw new HitchEvaluationError(
        'Hitch must provide trajectory_analysis=1 and trajectory_events_page=1',
        'hitch_trajectory_capabilities_unavailable',
      )
    }
    if (value.verifier_evidence !== undefined && value.verifier_evidence !== '1') {
      throw new HitchEvaluationError('Hitch verifier_evidence capability is invalid', 'invalid_hitch_result')
    }
    return {
      schemaVersion: 1,
      trajectoryAnalysis: 1,
      trajectoryEventsPage: 1,
      ...(value.verifier_evidence === '1' ? { verifierEvidence: 1 as const } : {}),
    }
  }

  async evaluate(
    round: Readonly<HitchExecutionContext>,
    request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
    reservation?: Readonly<EvaluationReservation>,
  ): Promise<HitchEvaluationEvidence> {
    try {
      this.execution.assertEvaluationRequest(round, request)
      if (
        reservation !== undefined &&
        (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId))
      ) {
        throw new TypeError('Hitch evaluation reservation is invalid')
      }
      if (this.execution.daemonMode && reservation === undefined) {
        throw new TypeError('Hitch daemon evaluation requires a durable reservation')
      }
      const args = [
        ...this.rootArgs(),
        ...(this.execution.daemonMode
          ? ['eval', 'watch', (reservation as EvaluationReservation).evalId]
          : [
              'eval',
              'run',
              ...(reservation === undefined ? [] : ['--eval-id', reservation.evalId]),
              ...this.evalRequestArgs(round, request),
            ]),
        '--output',
        'json',
      ]
      let identity = await this.resolveEvaluationIdentity(round, request, signal)
      const processResult = await this.run(args, round.workspaceRoot, signal)
      let parsed: unknown
      try {
        parsed = JSON.parse(processResult.stdout)
      } catch (error) {
        throw new HitchEvaluationError(
          `Hitch emitted invalid JSON (${String(error)}); stderr: ${processResult.stderr.slice(-4000)}`,
          'invalid_hitch_json',
        )
      }
      let inspection: JsonRecord | undefined
      if (this.execution.daemonMode) {
        inspection = await this.inspectEvaluation(
          (reservation as EvaluationReservation).evalId,
          round.workspaceRoot,
          signal,
          'hitch_eval_inspect_failed',
        )
        identity = this.execution.daemonEvaluationIdentity(round, request, inspection, identity)
      }
      const evidence = parseResult(this.options.harnessId, parsed, processResult, request, identity, true)
      if (
        reservation !== undefined &&
        (evidence.provider !== reservation.provider || evidence.evalId !== reservation.evalId)
      ) {
        throw new HitchEvaluationError(
          'Hitch result does not match the reserved evaluation identity',
          'hitch_eval_identity_mismatch',
        )
      }
      inspection ??= await this.inspectEvaluation(
        evidence.evalId,
        round.workspaceRoot,
        signal,
        'hitch_eval_inspect_failed',
      )
      const benchmark = this.execution.assertCompleteTrialSlots(inspection, evidence, request)
      return { ...evidence, benchmark }
    } catch (error) {
      if (this.execution.daemonMode && reservation !== undefined) {
        try {
          await this.cancelReservation(reservation)
        } catch (cancelError) {
          throw new EvaluationCleanupError(error, cancelError)
        }
      }
      throw error
    }
  }

  async inspectResult(
    round: Readonly<HitchExecutionContext>,
    request: Readonly<EvaluationRequest>,
    reservation: Readonly<EvaluationReservation>,
    signal: AbortSignal,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<import('../../types.js').EvaluationInspection> {
    this.execution.assertEvaluationRequest(round, request)
    if (reservation.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId))
      throw new TypeError('invalid evaluation reservation')
    const inspection = await this.inspectEvaluation(
      reservation.evalId,
      round.workspaceRoot,
      signal,
      'hitch_eval_recovery_inspect_failed',
      intent === undefined ? this.options.root : this.submissionParameters(intent).root,
    )
    const control = inspection.control == null ? undefined : record(inspection.control, 'Hitch eval control')
    if (control && (control.schema_version !== '1' || control.eval_id !== reservation.evalId))
      throw new HitchEvaluationError('Hitch eval control identity changed', 'invalid_hitch_result')
    const state = control?.state
    if (!inspection.result) {
      if (['queued', 'planning', 'preparing', 'running', 'finalizing', 'cancelling'].includes(String(state)))
        return { status: 'running' }
      return ['failed', 'cancelled'].includes(String(state))
        ? {
            status: 'failed',
            code: 'hitch_eval_terminal_failure',
            message: `Evaluation ${reservation.evalId} is ${String(state)}`,
          }
        : { status: 'unknown', reason: 'existing evaluation has no durable result' }
    }
    // Hitch persists its terminal result before updating control/progress projections.
    // A durable result takes precedence, but must belong to this reservation.
    const result = record(inspection.result, 'Hitch existing eval result')
    if (result.schema_version !== '1' || result.eval_id !== reservation.evalId) {
      throw new HitchEvaluationError('Hitch eval result identity changed', 'invalid_hitch_result')
    }
    if (
      result.status === 'cancelled' ||
      (result.status === 'failed' && (!Array.isArray(result.trials) || result.trials.length === 0))
    ) {
      return {
        status: 'failed',
        code: 'hitch_eval_terminal_failure',
        message: `Evaluation ${reservation.evalId} is ${String(result.status)}`,
      }
    }
    const identity = await this.resolveEvaluationIdentity(round, request, signal)
    const evidence = parseResult(
      this.options.harnessId,
      result,
      { stdout: JSON.stringify(result), stderr: '', exitCode: integer(result.exit_code, 'exit_code') },
      request,
      this.execution.daemonMode
        ? this.execution.daemonEvaluationIdentity(round, request, inspection, identity)
        : identity,
      true,
    )
    if (evidence.evalId !== reservation.evalId)
      throw new HitchEvaluationError('recovered evaluation identity changed', 'hitch_eval_identity_mismatch')
    return {
      status: 'complete',
      evidence: { ...evidence, benchmark: this.execution.assertCompleteTrialSlots(inspection, evidence, request) },
    }
  }

  prepareRerun(
    _round: Readonly<HitchExecutionContext>,
    _request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    _selector: Readonly<EvaluationRerunSelector>,
  ): EvaluationRerunReservation | undefined {
    if (!this.execution.daemonMode) return undefined
    return {
      provider: 'hitch-cli',
      evalId: attempt.evalId,
      rerunId: `rerun_${randomUUID().replaceAll('-', '')}`,
      parameters: {
        root:
          attempt.submissionIntent === undefined
            ? this.options.root
            : this.submissionParameters(attempt.submissionIntent).root,
      },
    }
  }

  private rerunRoot(reservation: Readonly<EvaluationRerunReservation>): string {
    if (
      reservation.provider !== 'hitch-cli' ||
      !/^eval_[0-9a-f]{32}$/u.test(reservation.evalId) ||
      !/^rerun_[0-9a-f]{32}$/u.test(reservation.rerunId)
    )
      throw new TypeError('Hitch rerun reservation is invalid')
    const parameters = record(reservation.parameters, 'Hitch rerun parameters')
    if (typeof parameters.root !== 'string') throw new TypeError('Hitch rerun root is invalid')
    return parameters.root
  }

  async cancelRerun(reservation: Readonly<EvaluationRerunReservation>): Promise<void> {
    const root = this.rerunRoot(reservation)
    const result = await this.run(
      [...(root.length === 0 ? [] : ['--root', root]), 'eval', 'rerun-cancel', reservation.evalId, reservation.rerunId],
      this.repositoryPath,
      AbortSignal.timeout(30_000),
      64 * 1024,
    )
    if (result.exitCode !== 0)
      throw new HitchEvaluationError(
        `Hitch rerun cancellation failed: ${result.stderr.slice(-4000)}`,
        'hitch_rerun_cancel_failed',
      )
    const cancelled = record(JSON.parse(result.stdout), 'Hitch rerun cancellation')
    if (
      cancelled.schema_version !== '1' ||
      cancelled.eval_id !== reservation.evalId ||
      cancelled.rerun_id !== reservation.rerunId ||
      !['cancelled', 'completed', 'failed'].includes(cancelled.status as string)
    ) {
      throw new HitchEvaluationError(
        'Hitch rerun cancellation did not confirm a stopped operation',
        'hitch_rerun_cancel_failed',
      )
    }
  }

  async rerun(
    round: Readonly<HitchExecutionContext>,
    request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    selector: Readonly<EvaluationRerunSelector>,
    signal: AbortSignal,
    reservation?: Readonly<EvaluationRerunReservation>,
  ): Promise<EvaluationRerunResult> {
    if (attempt.provider !== 'hitch-cli' || !/^eval_[0-9a-f]{32}$/u.test(attempt.evalId)) {
      throw new TypeError('Hitch evaluation rerun requires an owned Hitch eval id')
    }
    if (
      attempt.phase !== request.phase ||
      attempt.dataset !== request.dataset ||
      attempt.conditionId !== request.condition.conditionId ||
      attempt.requestedCommit !== request.harnessRef ||
      attempt.requestedModelId !== request.condition.model
    ) {
      throw new TypeError('Hitch evaluation rerun request does not match the original attempt')
    }
    if (this.execution.daemonMode && reservation === undefined)
      throw new TypeError('Hitch daemon rerun requires a persisted rerun reservation')
    const root = reservation === undefined ? this.options.root : this.rerunRoot(reservation)
    if (reservation !== undefined && reservation.evalId !== attempt.evalId)
      throw new TypeError('Hitch rerun reservation does not match its source eval')
    try {
      const identity = await this.resolveEvaluationIdentity(round, request, signal)
      const args = [
        ...(root.length === 0 ? [] : ['--root', root]),
        'eval',
        'rerun',
        attempt.evalId,
        ...(selector.mode === 'invalid' ? ['--invalid'] : selector.taskNames.flatMap((task) => ['--task', task])),
        '--type',
        'candidate-restart',
        ...(reservation === undefined ? [] : ['--daemon', '--rerun-id', reservation.rerunId]),
        '--output',
        'json',
      ]
      const processResult = await this.run(args, round.workspaceRoot, signal)
      if (processResult.exitCode !== 0) {
        throw new HitchEvaluationError(
          `Hitch eval rerun failed for ${attempt.evalId}: ${processResult.stderr.slice(-4000)}`,
          'hitch_eval_rerun_failed',
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(processResult.stdout)
      } catch (error) {
        throw new HitchEvaluationError(`Hitch emitted invalid rerun JSON (${String(error)})`, 'invalid_hitch_json')
      }
      const envelope = record(parsed, 'Hitch rerun result')
      if (
        envelope.schema_version !== '1' ||
        envelope.kind !== 'eval-rerun' ||
        envelope.eval_id !== attempt.evalId ||
        (reservation !== undefined && envelope.rerun_id !== reservation.rerunId) ||
        envelope.status !== 'completed' ||
        (envelope.eval_status !== 'succeeded' && envelope.eval_status !== 'failed')
      ) {
        throw new HitchEvaluationError('Hitch rerun result identity/status is invalid', 'invalid_hitch_result')
      }
      const selectedTasks = stringArray(envelope.selected_tasks, 'selected_tasks')
      const repairedTasks = stringArray(envelope.repaired_tasks, 'repaired_tasks')
      const remainingInvalidTasks = stringArray(envelope.remaining_invalid_tasks, 'remaining_invalid_tasks')
      const selectedTrials =
        envelope.selected_trials === undefined ? undefined : trialSlots(envelope.selected_trials, 'selected_trials')
      const repairedTrials =
        envelope.repaired_trials === undefined ? undefined : trialSlots(envelope.repaired_trials, 'repaired_trials')
      const remainingInvalidTrials =
        envelope.remaining_invalid_trials === undefined
          ? undefined
          : trialSlots(envelope.remaining_invalid_trials, 'remaining_invalid_trials')
      if (
        envelope.eval_status === 'succeeded' &&
        (remainingInvalidTasks.length > 0 || (remainingInvalidTrials?.length ?? 0) > 0)
      ) {
        throw new HitchEvaluationError('Hitch rerun succeeded with remaining invalid slots', 'invalid_hitch_result')
      }
      const inspection = await this.inspectEvaluation(
        attempt.evalId,
        round.workspaceRoot,
        signal,
        'hitch_eval_rerun_inspect_failed',
        root,
      )
      const result = record(inspection.result, 'Hitch repaired eval result')
      const evidence = parseResult(
        this.options.harnessId,
        result,
        { stdout: JSON.stringify(result), stderr: '', exitCode: integer(result.exit_code, 'exit_code') },
        request,
        this.execution.daemonMode
          ? this.execution.daemonEvaluationIdentity(round, request, inspection, identity)
          : identity,
        true,
      )
      if (evidence.evalId !== attempt.evalId)
        throw new HitchEvaluationError('repaired evidence eval id changed', 'hitch_eval_identity_mismatch')
      if ((envelope.eval_status === 'succeeded') !== (evidence.completeness === 'complete')) {
        throw new HitchEvaluationError(
          'Hitch rerun status does not match repaired evidence completeness',
          'invalid_hitch_result',
        )
      }
      const benchmark = this.execution.assertCompleteTrialSlots(inspection, evidence, request)
      return {
        provider: 'hitch-cli',
        evalId: attempt.evalId,
        selectedTasks,
        repairedTasks,
        remainingInvalidTasks,
        ...(selectedTrials === undefined ? {} : { selectedTrials }),
        ...(repairedTrials === undefined ? {} : { repairedTrials }),
        ...(remainingInvalidTrials === undefined ? {} : { remainingInvalidTrials }),
        evalStatus: envelope.eval_status,
        evidence: { ...evidence, benchmark },
      }
    } catch (error) {
      if (reservation !== undefined) {
        try {
          await this.cancelRerun(reservation)
        } catch (cleanupError) {
          throw new EvaluationCleanupError(error, cleanupError)
        }
      }
      throw error
    }
  }

  private async inspectEvaluation(
    evalId: string,
    cwd: string,
    signal: AbortSignal,
    failureCode: string,
    root = this.options.root,
  ): Promise<JsonRecord> {
    const inspect = await this.run(
      [...(root.length === 0 ? [] : ['--root', root]), 'eval', 'inspect', evalId, '--json'],
      cwd,
      signal,
    )
    if (inspect.exitCode !== 0) {
      throw new HitchEvaluationError(`Hitch could not inspect eval ${evalId}`, failureCode)
    }
    let inspectionValue: unknown
    try {
      inspectionValue = JSON.parse(inspect.stdout)
    } catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid inspect JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const inspection = record(inspectionValue, 'Hitch eval inspection')
    if (inspection.schema_version !== '1' || inspection.eval_id !== evalId) {
      throw new HitchEvaluationError('Hitch inspection identity is invalid', 'invalid_hitch_result')
    }
    return inspection
  }

  private async cancelDaemonEvaluation(evalId: string, cwd: string, root: string): Promise<void> {
    const result = await this.run(
      [...(root.length === 0 ? [] : ['--root', root]), 'eval', 'cancel', evalId],
      cwd,
      AbortSignal.timeout(Math.max(5_000, this.options.terminationGraceMs)),
      64 * 1024,
    )
    if (result.exitCode !== 0) {
      throw new HitchEvaluationError(
        `Hitch could not cancel daemon eval ${evalId}: ${result.stderr.slice(-4000)}`,
        'hitch_eval_cancel_failed',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch (error) {
      throw new HitchEvaluationError(
        `Hitch emitted invalid eval cancellation JSON (${String(error)})`,
        'invalid_hitch_json',
      )
    }
    const cancelled = record(parsed, 'Hitch eval cancellation')
    if (
      cancelled.schema_version !== '1' ||
      cancelled.eval_id !== evalId ||
      !new Set(['cancelling', 'cancelled', 'succeeded', 'failed']).has(cancelled.status as string)
    ) {
      throw new HitchEvaluationError('Hitch eval cancellation identity/status is invalid', 'invalid_hitch_result')
    }
  }

  private executablePath(): Promise<string> {
    this.executablePathPromise ??= this.resolveExecutablePath()
    return this.executablePathPromise
  }

  private async runtimeIdentity(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const executablePath = await this.executablePath()
    const readExecutable = async (): Promise<Uint8Array> =>
      readFile(executablePath).catch((error) => {
        throw new HitchEvaluationError(
          `cannot fingerprint Hitch executable ${executablePath}: ${String(error)}`,
          'hitch_version_check_failed',
        )
      })
    const executableDigestBefore = sha256(await readExecutable())
    signal?.throwIfAborted()
    const versionOutputDigest = await this.checkVersion(signal)
    signal?.throwIfAborted()
    const executableDigest = sha256(await readExecutable())
    if (executableDigest !== executableDigestBefore) {
      throw new HitchEvaluationError(
        `Hitch executable changed while its runtime identity was being validated: ${executablePath}`,
        'hitch_version_check_failed',
      )
    }
    return sha256(
      JSON.stringify({
        versionOutputDigest,
        executableDigest,
      }),
    )
  }

  private async resolveExecutablePath(): Promise<string> {
    const candidates = this.options.executable.includes('/')
      ? [resolve(this.repositoryPath, this.options.executable)]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .filter((path) => path.length > 0)
          .map((path) => resolve(path, this.options.executable))
    for (const candidate of candidates) {
      try {
        return await realpath(candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new HitchEvaluationError(
            `cannot resolve Hitch executable ${candidate}: ${String(error)}`,
            'hitch_version_check_failed',
          )
        }
      }
    }
    throw new HitchEvaluationError(
      `cannot resolve Hitch executable for runtime fingerprint: ${this.options.executable}`,
      'hitch_version_check_failed',
    )
  }

  protected async run(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    maxOutputBytes = this.options.maxOutputBytes,
  ): Promise<ProcessResult> {
    signal.throwIfAborted()
    return runHitch(await this.executablePath(), this.options.terminationGraceMs, args, cwd, signal, maxOutputBytes)
  }
}
