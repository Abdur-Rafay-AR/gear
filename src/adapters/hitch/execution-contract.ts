import { isDeepStrictEqual } from 'node:util'
import type { HitchConfig } from '../../config.js'
import { digestJson } from '../../state/digest.js'
import type { EvaluationRequest, HitchEvaluationEvidence } from '../../types.js'
import { isExactGitCommit } from '../../types.js'
import {
  HitchEvaluationError,
  type HitchEvaluationIdentity,
  type HitchExecutionContext,
  type JsonRecord,
} from './contracts.js'
import { integer, memorySizeBytes, record, sha256, string, stringArray } from './wire-primitives.js'

type HitchControlPlaneOptions = NonNullable<HitchConfig['controlPlane']>

/** Pure admission and evidence checks for the frozen Hitch execution condition.
 * Transport and durable reservation ownership remain in the evaluator/runtime.
 * Keep the historical digest field order and formulas unchanged.
 */
export class HitchExecutionContract {
  constructor(
    readonly options: HitchConfig,
    readonly repositoryPath: string,
  ) {}

  get controlPlane(): HitchControlPlaneOptions {
    return { mode: 'direct', requireModelCapture: false, ...this.options.controlPlane }
  }

  get daemonMode(): boolean {
    return this.controlPlane.mode === 'daemon'
  }

  controlPlanePolicyIsExplicit(): boolean {
    const policy = this.controlPlane
    return (
      policy.provider !== undefined ||
      policy.cpuPerTrial !== undefined ||
      policy.memoryPerTrial !== undefined ||
      policy.buildMode !== undefined ||
      policy.modelCapture !== undefined ||
      policy.requireModelCapture
    )
  }

  controlPlaneArgs(): string[] {
    const policy = this.controlPlane
    return [
      ...(policy.provider === undefined ? [] : ['--provider', policy.provider]),
      ...(policy.cpuPerTrial === undefined ? [] : ['--cpu-per-trial', String(policy.cpuPerTrial)]),
      ...(policy.memoryPerTrial === undefined ? [] : ['--memory-per-trial', policy.memoryPerTrial]),
      ...(policy.buildMode === undefined ? [] : ['--build-mode', policy.buildMode]),
      ...(policy.modelCapture === undefined ? [] : ['--model-capture', policy.modelCapture]),
      ...(policy.requireModelCapture ? ['--require-model-capture'] : []),
    ]
  }

  assertEvaluationRequest(round: Readonly<HitchExecutionContext>, request: Readonly<EvaluationRequest>): void {
    if (!isExactGitCommit(request.harnessRef)) throw new TypeError('Hitch evaluation requires a full Git commit OID')
    if (request.dataset.length === 0) throw new TypeError('Hitch evaluation dataset must not be empty')
    if (request.condition.dataset.ref !== request.dataset || request.condition.timeoutMs !== round.taskBudgetMs) {
      throw new TypeError('Hitch evaluation request does not match its resolved condition')
    }
    if (request.condition.seeds !== undefined)
      throw new TypeError('Hitch CLI adapter does not support typed rollout seeds')
    if (request.condition.sampling.temperature !== undefined) {
      throw new TypeError('Hitch CLI adapter does not support typed rollout temperature')
    }
  }

  daemonIdempotencyKey(round: Readonly<HitchExecutionContext>, request: Readonly<EvaluationRequest>): string {
    return `gear-eval-v1-${sha256(
      JSON.stringify({
        evolutionId: round.evolutionId,
        roundId: round.roundId,
        phase: request.phase,
        conditionId: request.condition.conditionId,
        dataset: request.dataset,
        harnessRef: request.harnessRef,
        model: request.condition.model,
        repetitions: request.condition.repetitions,
        invocation: this.baseParity(round, request),
      }),
    ).slice('sha256:'.length)}`
  }

  baseParity(round: Readonly<HitchExecutionContext>, request: Readonly<EvaluationRequest>): JsonRecord {
    return {
      conditionId: request.condition.conditionId,
      executable: this.options.executable,
      hitchRoot: this.options.root,
      repositoryPath: this.repositoryPath,
      backend: 'harbor',
      dataset: request.dataset,
      harnessId: this.options.harnessId,
      model: request.condition.model,
      attempts: request.condition.repetitions,
      ...(this.options.infrastructureRetries === undefined
        ? {}
        : { infrastructureRetries: this.options.infrastructureRetries }),
      maxConcurrent: this.options.maxConcurrent,
      timeoutMs: round.taskBudgetMs,
      setupTimeoutMs: this.options.setupTimeoutMs,
      agentArgs: this.options.agentArgs,
      passEnv: this.options.passEnv,
      sandboxProfileRef: round.sandboxProfileRef,
      ...(this.daemonMode ? { executionMode: 'daemon' } : {}),
    }
  }

  parseResourceVector(value: unknown, label: string): JsonRecord {
    const resources = record(value, label)
    for (const field of ['cpu_millis', 'memory_bytes', 'container_slots', 'build_slots']) {
      integer(resources[field], `${label}.${field}`)
    }
    for (const field of ['gpu_count', 'ephemeral_disk_bytes']) {
      if (resources[field] !== undefined) integer(resources[field], `${label}.${field}`)
    }
    return resources
  }

  daemonEvaluationIdentity(
    round: Readonly<HitchExecutionContext>,
    request: Readonly<EvaluationRequest>,
    inspection: JsonRecord,
    identity: HitchEvaluationIdentity,
  ): HitchEvaluationIdentity {
    const evalId = string(inspection.eval_id, 'Hitch eval inspection eval_id')
    const submission = record(inspection.submission, 'Hitch eval submission record')
    if (submission.schema_version !== '1' || submission.eval_id !== evalId) {
      throw new HitchEvaluationError('Hitch eval submission identity is invalid', 'invalid_hitch_result')
    }
    const inspectedRequest = record(inspection.request, 'Hitch eval request')
    const submittedRequest = record(submission.request, 'Hitch eval submitted request')
    if (!isDeepStrictEqual(submittedRequest, inspectedRequest)) {
      throw new HitchEvaluationError('Hitch submitted request differs from the eval request', 'invalid_hitch_result')
    }
    if (
      this.options.infrastructureRetries !== undefined &&
      submittedRequest.infrastructure_retries !== this.options.infrastructureRetries
    ) {
      throw new HitchEvaluationError('Hitch retry policy differs from the frozen condition', 'invalid_hitch_result')
    }
    const idempotencyKeyHash = string(submission.idempotency_key_hash, 'Hitch eval idempotency key hash')
    if (idempotencyKeyHash !== sha256(this.daemonIdempotencyKey(round, request))) {
      throw new HitchEvaluationError(
        'Hitch eval idempotency identity differs from the Gear reservation',
        'invalid_hitch_result',
      )
    }
    const execution = this.assertDaemonExecutionPolicy(submission.execution)
    const submissionDigest = string(submission.submission_digest, 'Hitch eval submission digest')
    if (submissionDigest !== digestJson({ request: submittedRequest, execution })) {
      throw new HitchEvaluationError(
        'Hitch eval submission digest does not match its frozen request and execution policy',
        'invalid_hitch_result',
      )
    }
    const submittedAt = string(submission.submitted_at, 'Hitch eval submission timestamp')
    if (!Number.isFinite(Date.parse(submittedAt))) {
      throw new HitchEvaluationError('Hitch eval submission timestamp is invalid', 'invalid_hitch_result')
    }
    const effectiveConfigDigest = digestJson({
      effectiveConfigDigest: identity.effectiveConfigDigest,
      executionMode: 'daemon',
      execution,
    })
    return {
      provider: 'hitch-cli',
      effectiveConfigDigest,
      invocationFingerprint: this.daemonInvocationFingerprint(effectiveConfigDigest, identity.invocationFingerprint),
    }
  }

  assertDaemonExecutionPolicy(value: unknown): JsonRecord {
    const execution = record(value, 'Hitch eval execution policy')
    const provider = string(execution.provider, 'Hitch eval execution policy provider')
    const maxParallelism = integer(execution.max_parallelism, 'Hitch eval execution policy max_parallelism')
    if (maxParallelism !== this.options.maxConcurrent) {
      throw new HitchEvaluationError(
        'Hitch eval execution parallelism differs from the Gear condition',
        'invalid_hitch_result',
      )
    }
    if (this.controlPlane.provider !== undefined && provider !== this.controlPlane.provider) {
      throw new HitchEvaluationError(
        'Hitch eval execution provider differs from Gear configuration',
        'invalid_hitch_result',
      )
    }
    const resources = record(execution.resources, 'Hitch eval execution resources')
    const trial = this.parseResourceVector(resources.default_trial, 'Hitch eval default trial resources')
    if (this.controlPlane.cpuPerTrial !== undefined && trial.cpu_millis !== this.controlPlane.cpuPerTrial * 1_000) {
      throw new HitchEvaluationError(
        'Hitch eval CPU reservation differs from Gear configuration',
        'invalid_hitch_result',
      )
    }
    if (
      this.controlPlane.memoryPerTrial !== undefined &&
      trial.memory_bytes !== memorySizeBytes(this.controlPlane.memoryPerTrial)
    ) {
      throw new HitchEvaluationError(
        'Hitch eval memory reservation differs from Gear configuration',
        'invalid_hitch_result',
      )
    }
    if (resources.setup !== undefined) this.parseResourceVector(resources.setup, 'Hitch eval setup resources')
    const build = record(execution.build, 'Hitch eval build policy')
    const buildMode = string(build.mode, 'Hitch eval build mode')
    if (
      !new Set(['backend', 'prebuild-preferred', 'prebuild-required']).has(buildMode) ||
      (this.controlPlane.buildMode !== undefined && buildMode !== this.controlPlane.buildMode)
    ) {
      throw new HitchEvaluationError('Hitch eval build policy differs from Gear configuration', 'invalid_hitch_result')
    }
    const capture = record(execution.model_capture, 'Hitch eval model capture policy')
    const captureMode = string(capture.mode, 'Hitch eval model capture mode')
    if (
      !new Set(['off', 'native', 'proxy', 'hybrid']).has(captureMode) ||
      typeof capture.required !== 'boolean' ||
      (this.controlPlane.modelCapture !== undefined && captureMode !== this.controlPlane.modelCapture) ||
      capture.required !== this.controlPlane.requireModelCapture
    ) {
      throw new HitchEvaluationError(
        'Hitch eval model capture policy differs from Gear configuration',
        'invalid_hitch_result',
      )
    }
    return execution
  }

  assertCompleteTrialSlots(
    inspection: JsonRecord,
    evidence: HitchEvaluationEvidence,
    request: Readonly<EvaluationRequest>,
  ): { id: string; revision: string } {
    const plan = record(inspection.plan, 'Hitch eval plan')
    if (plan.schema_version !== '1' || plan.eval_id !== evidence.evalId) {
      throw new HitchEvaluationError('Hitch eval plan identity is invalid', 'invalid_hitch_result')
    }
    const inspectedRequest = record(inspection.request, 'Hitch eval request')
    if (
      inspectedRequest.schema_version !== '1' ||
      inspectedRequest.backend !== 'harbor' ||
      inspectedRequest.dataset !== request.dataset ||
      inspectedRequest.model !== request.condition.model
    ) {
      throw new HitchEvaluationError(
        'Hitch eval request does not match the frozen Gear condition',
        'invalid_hitch_result',
      )
    }
    const attempts = integer(plan.attempts, 'plan.attempts')
    const requestedAttempts = integer(inspectedRequest.attempts, 'request.attempts')
    if (
      this.options.infrastructureRetries !== undefined &&
      inspectedRequest.infrastructure_retries !== this.options.infrastructureRetries
    ) {
      throw new HitchEvaluationError('Hitch retry policy differs from the frozen condition', 'invalid_hitch_result')
    }
    if (attempts <= 0 || attempts !== request.condition.repetitions || requestedAttempts !== attempts) {
      throw new HitchEvaluationError(
        'Hitch eval plan attempts do not match the frozen condition',
        'invalid_hitch_result',
      )
    }
    const attemptExecution = plan.attempt_execution
    const stableAttemptExecution =
      attemptExecution === 'harbor-attempt-shards-v1' || attemptExecution === 'harbor-task-slots-v1'
    if ((attemptExecution !== undefined && !stableAttemptExecution) || (attempts > 1 && !stableAttemptExecution)) {
      throw new HitchEvaluationError('Hitch eval plan has no stable logical-attempt identity', 'invalid_hitch_result')
    }
    const benchmarkId = string(inspectedRequest.benchmark_id, 'request.benchmark_id')
    const benchmarkRevision = string(inspectedRequest.benchmark_revision, 'request.benchmark_revision')
    if (
      plan.backend !== 'harbor' ||
      plan.dataset !== inspectedRequest.dataset ||
      plan.benchmark_id !== benchmarkId ||
      plan.benchmark_revision !== benchmarkRevision
    ) {
      throw new HitchEvaluationError('Hitch eval request and plan dataset identity differ', 'invalid_hitch_result')
    }
    const candidate = record(plan.candidate, 'plan.candidate')
    const requestedHarnessRef = string(inspectedRequest.harness_ref, 'request.harness_ref')
    if (
      candidate.requested_harness_ref !== requestedHarnessRef ||
      candidate.harness_id !== this.options.harnessId ||
      candidate.revision_identity !== evidence.revisionIdentity
    ) {
      throw new HitchEvaluationError(
        'Hitch eval plan candidate identity differs from the result',
        'invalid_hitch_result',
      )
    }
    const lockedHarnessRef = string(candidate.harness_ref, 'plan.candidate.harness_ref')
    const lockedCommit = lockedHarnessRef.match(/@commit:([0-9a-f]{40}|[0-9a-f]{64})$/u)?.[1]
    if (
      lockedCommit !== request.harnessRef ||
      lockedCommit !== evidence.actualCommit ||
      lockedHarnessRef !== `${this.options.harnessId}@commit:${lockedCommit}`
    ) {
      throw new HitchEvaluationError(
        'Hitch eval plan candidate commit differs from the request',
        'invalid_hitch_result',
      )
    }
    const tasks = stringArray(plan.tasks, 'plan.tasks')
    const plannedTasks = new Set(tasks)
    if (tasks.length === 0 || plannedTasks.size !== tasks.length) {
      throw new HitchEvaluationError('Hitch eval plan tasks must be non-empty and unique', 'invalid_hitch_result')
    }
    const expectedTrials = tasks.length * attempts
    if (!Number.isSafeInteger(expectedTrials)) {
      throw new HitchEvaluationError(
        'Hitch eval plan trial count exceeds the safe integer range',
        'invalid_hitch_result',
      )
    }
    const slots = new Set<string>()
    for (const trial of [...evidence.trials, ...evidence.invalidTrials]) {
      if (!plannedTasks.has(trial.taskName)) {
        throw new HitchEvaluationError(
          `Hitch evidence contains task outside the frozen plan: ${trial.taskName}`,
          'invalid_hitch_result',
        )
      }
      const logicalAttempt = trial.attempt ?? (attempts === 1 ? 1 : undefined)
      if (
        logicalAttempt === undefined ||
        !Number.isSafeInteger(logicalAttempt) ||
        logicalAttempt < 1 ||
        logicalAttempt > attempts
      ) {
        throw new HitchEvaluationError(
          `Hitch evidence attempt is outside frozen range 1..${attempts}: ${trial.taskName}#${String(trial.attempt)}`,
          'invalid_hitch_result',
        )
      }
      const slot = `${trial.taskName}\0${logicalAttempt}`
      if (slots.has(slot)) {
        throw new HitchEvaluationError(
          `Hitch evidence contains duplicate logical slot: ${trial.taskName}#${logicalAttempt}`,
          'invalid_hitch_result',
        )
      }
      slots.add(slot)
    }
    if (slots.size !== expectedTrials) {
      const missing: string[] = []
      for (const task of tasks) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (!slots.has(`${task}\0${attempt}`)) missing.push(`${task}#${attempt}`)
        }
      }
      throw new HitchEvaluationError(
        `Hitch evidence is missing frozen logical slots: ${missing.join(', ')}`,
        'invalid_hitch_result',
      )
    }
    return { id: benchmarkId, revision: benchmarkRevision }
  }

  effectiveConfigDigest(round: Readonly<HitchExecutionContext>, request: Readonly<EvaluationRequest>): string {
    return sha256(
      JSON.stringify({
        provider: 'hitch-cli',
        // Evidence collected before this contract lacks benchmark identity and
        // cannot be paired with current scores, even for legacy datasets.
        scoringContract: 'benchmark-scores-v1',
        conditionId: request.condition.conditionId,
        backend: 'harbor',
        harnessId: this.options.harnessId,
        sandboxProfileRef: round.sandboxProfileRef,
        ...(this.options.infrastructureRetries === undefined
          ? {}
          : { infrastructureRetries: this.options.infrastructureRetries }),
      }),
    )
  }

  invocationFingerprint(effectiveConfigDigest: string, hitchRuntimeIdentity: string): string {
    return sha256(
      JSON.stringify({
        effectiveConfigDigest,
        hitchRuntimeIdentity,
        maxConcurrent: this.options.maxConcurrent,
        setupTimeoutMs: this.options.setupTimeoutMs,
        terminationGraceMs: this.options.terminationGraceMs,
        maxOutputBytes: this.options.maxOutputBytes,
        maxTrajectoryOutputBytes: this.options.maxTrajectoryOutputBytes,
        maxTrajectoryAnalysisBytes: this.options.maxTrajectoryAnalysisBytes ?? 16 * 1024 * 1024,
        maxTrajectoryEventsBytes: this.options.maxTrajectoryEventsBytes ?? 4 * 1024 * 1024,
      }),
    )
  }

  daemonInvocationFingerprint(effectiveConfigDigest: string, directInvocationFingerprint: string): string {
    return sha256(JSON.stringify({ effectiveConfigDigest, directInvocationFingerprint }))
  }
}
