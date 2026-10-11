import type { AlgorithmDecision, AlgorithmOperation, AlgorithmWorker, SearchView } from '../domain/algorithm.js'
import { algorithmProtocol } from '../domain/algorithm-protocol.js'
import type { BenchmarkSpec, BenchmarkTask, Split } from '../domain/benchmark.js'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError, GenerationFailed } from '../domain/errors.js'
import { MutationValidationError } from '../domain/harness.js'
import { type ProjectGate, passRateGate, passRatePromotion } from '../domain/promotion.js'
import { scoreOutput } from '../domain/scoring.js'
import type { EvidenceCache } from '../ports/evidence-cache.js'
import type { ProjectProvider, TargetSnapshot, TrialResult } from '../ports/project.js'
import type { RunStore } from '../ports/run-store.js'
import { projectView } from './project-view.js'

export interface RunPlan {
  promotion?: typeof passRatePromotion
  runtimeIdentity?: string
  kind: 'evaluate' | 'refine'
  binding?: {
    adapter: 'dsh' | 'pi'
    targetProfile: string
    metaProfile: string
    algorithm: 'gepa' | { source: string; entrypoint: string }
  }
  benchmark: BenchmarkSpec
  target: TargetSnapshot
  providerIdentity: string
  algorithmIdentity: string
  validation: 'holdout' | 'research'
  maxEvaluations: number
  maxCandidates: number
  split: Split
  taskIds: string[]
}
interface Trial {
  taskId: string
  candidate: string
  split: Split
  result: TrialResult
  score: number | null
  reusedFrom?: { runId: string; operationId: string }
}
interface PendingOperation {
  id: string
  kind: 'evaluation' | 'generation'
  candidate: string
  parent?: string
  diagnosisId?: string
  taskId?: string
  status: 'reserved' | 'complete'
}
export interface ProjectRun {
  version: 1
  id: string
  plan: RunPlan
  planDigest: string
  status: 'running' | 'complete' | 'cancelled'
  algorithmState: Record<string, unknown>
  decisions: Array<{ step: number; inputDigest: string; decision: AlgorithmDecision; done: boolean }>
  completed?: Record<string, Record<string, unknown>>
  operations: PendingOperation[]
  candidates: TargetSnapshot[]
  trials: Trial[]
  champion: string
  nominee?: string
  gate?: ProjectGate
}

function fault(code: string, message: string, runId: string, operationId?: string): never {
  throw new GearError({
    code,
    message,
    run_id: runId,
    ...(operationId ? { operation_id: operationId } : {}),
    retryable: code === 'operation-pending',
    next_action:
      code === 'operation-pending'
        ? `Inspect the provider, then gear resume ${runId}.`
        : 'Review the run report; use a new run for changed inputs.',
  })
}
function validTrial(result: TrialResult): void {
  if (
    !result ||
    !['completed', 'task-failed', 'scorer-failed', 'infrastructure-failed'].includes(result.status) ||
    !Number.isSafeInteger(result.physicalAttempts) ||
    result.physicalAttempts < 0 ||
    result.physicalAttempts > 1 ||
    (result.output !== undefined && typeof result.output !== 'string')
  )
    throw new TypeError('invalid-provider-result')
}
function validateDecision(decision: AlgorithmDecision, view: SearchView): void {
  canonicalDigest(decision)
  if (
    !decision ||
    typeof decision.reason !== 'string' ||
    !decision.reason ||
    !decision.state ||
    typeof decision.state !== 'object' ||
    Array.isArray(decision.state) ||
    !Array.isArray(decision.operations) ||
    decision.operations.length < 1 ||
    decision.operations.length > 64
  )
    throw new TypeError('invalid-algorithm-decision')
  const candidates = view.candidates.map((c) => c.id)
  for (const [index, op] of decision.operations.entries()) {
    if (
      !op ||
      !algorithmProtocol.operations.includes(op.kind) ||
      typeof op.candidate !== 'string' ||
      typeof op.parent !== 'string' ||
      !Array.isArray(op.tasks) ||
      new Set(op.tasks).size !== op.tasks.length ||
      op.tasks.some((id) => !view.seed_tasks.includes(id))
    )
      throw new TypeError('invalid-algorithm-operation')
    if (op.kind === 'generate') {
      if (
        !/^[a-zA-Z0-9_-]+$/u.test(op.candidate) ||
        candidates.includes(op.candidate) ||
        !candidates.includes(op.parent) ||
        candidates.length - 1 >= view.max_candidates
      )
        throw new TypeError('invalid-candidate-generation')
      candidates.push(op.candidate)
    } else if (!['stop'].includes(op.kind) && !candidates.includes(op.candidate))
      throw new TypeError('unknown-candidate')
    if (op.diagnosis_id != null) {
      const source = typeof op.diagnosis_id === 'string' ? view.completed[op.diagnosis_id] : undefined
      if (op.kind !== 'generate' || source?.kind !== 'diagnose_seed' || source.candidate !== op.parent)
        throw new TypeError('invalid-generation-diagnosis-binding')
    }
    if ((op.kind === 'stop' || op.kind === 'nominate') && index !== decision.operations.length - 1)
      throw new TypeError('terminal-operation-must-be-last')
    if (op.kind === 'evaluate_seed' && !op.tasks.length) throw new TypeError('empty-seed-evaluation')
  }
}

/** Sole writer of the project journal. No concrete provider or Python imports. */
export class ProjectRuntime {
  constructor(
    readonly store: RunStore,
    readonly provider: ProjectProvider,
    readonly algorithm: AlgorithmWorker,
    readonly validateCandidate: (files: Record<string, string>) => Promise<void>,
    readonly sealTarget?: (snapshot: TargetSnapshot, parent?: TargetSnapshot) => Promise<TargetSnapshot>,
    readonly evidenceCache?: EvidenceCache,
    readonly identity?: string,
  ) {}

  async start(plan: RunPlan, signal: AbortSignal): Promise<ProjectRun> {
    plan = { ...plan, promotion: passRatePromotion }
    if (this.identity) plan = { ...plan, runtimeIdentity: this.identity }
    const capabilities = this.provider.capabilities
    if (
      !capabilities?.meteredAttempts ||
      !capabilities.recovery ||
      !capabilities.isolatedMeta ||
      !capabilities.isolatedTarget
    )
      throw new Error('Provider lacks required accounting, recovery or isolation capabilities')
    if (plan.providerIdentity !== this.provider.identity || plan.algorithmIdentity !== this.algorithm.identity)
      throw new Error('admission-identity-mismatch')
    if (
      !Number.isSafeInteger(plan.maxEvaluations) ||
      plan.maxEvaluations < 1 ||
      !Number.isSafeInteger(plan.maxCandidates) ||
      plan.maxCandidates < 0
    )
      throw new Error('invalid-run-budget')
    if (plan.validation === 'holdout' && !plan.benchmark.tasks.some((t) => t.split === 'held_out'))
      throw new Error('independent-holdout-required')
    if (this.sealTarget) plan = { ...plan, target: await this.sealTarget(plan.target) }
    const id = crypto.randomUUID()
    const state: ProjectRun = {
      version: 1,
      id,
      plan,
      planDigest: canonicalDigest(plan),
      status: 'running',
      algorithmState: {},
      decisions: [],
      operations: [],
      candidates: [plan.target],
      trials: [],
      champion: plan.target.id,
    }
    await this.store.locked(id, () => this.store.write(id, state))
    try {
      return await this.resume(id, signal)
    } catch (error) {
      if (error instanceof GearError) throw error
      throw new GearError({
        code: 'run-interrupted',
        message: error instanceof Error ? error.message : 'Run interrupted',
        run_id: id,
        retryable: true,
        next_action: `gear resume ${id}`,
      })
    }
  }

  async resume(id: string, signal: AbortSignal): Promise<ProjectRun> {
    return this.store.locked(id, async () => {
      const run = await this.store.read<ProjectRun>(id)
      if (run?.version !== 1) fault('run-not-found', 'Run not found or requires its compatibility runtime', id)
      if (
        canonicalDigest(run.plan) !== run.planDigest ||
        run.plan.runtimeIdentity !== this.identity ||
        run.plan.providerIdentity !== this.provider.identity ||
        run.plan.algorithmIdentity !== this.algorithm.identity
      )
        fault('identity-mismatch', 'Frozen configuration, provider or algorithm changed', id)
      if (run.status !== 'running') return run
      if (run.plan.promotion !== passRatePromotion)
        fault('identity-mismatch', 'Promotion policy changed; use the original runtime', id)
      if (run.plan.kind === 'evaluate') {
        for (const task of run.plan.benchmark.tasks.filter(
          (t) => run.plan.taskIds.includes(t.id) && t.split === run.plan.split,
        ))
          await this.evaluate(run, run.plan.target.id, task, signal)
      } else {
        const seed = run.plan.benchmark.tasks.filter((t) => t.split === 'seed')
        await this.ensureBudget(run, [run.plan.target.id], seed)
        for (const task of seed) await this.evaluate(run, run.plan.target.id, task, signal)
        this.completeScores(run, run.plan.target.id, seed)
        for (let steps = 0; steps < 1000 && run.status === 'running'; steps++) {
          await this.checkCancellation(run, signal)
          let saved = run.decisions.find((d) => !d.done)
          if (!saved) {
            const view = this.view(run)
            const decision = structuredClone(
              await this.algorithm.step(
                structuredClone(view),
                structuredClone(run.algorithmState),
                { runId: id, stepId: run.decisions.length },
                signal,
              ),
            )
            validateDecision(decision, view)
            saved = { step: run.decisions.length, inputDigest: canonicalDigest(view), decision, done: false }
            run.decisions.push(saved)
            run.algorithmState = decision.state
            // Commit decision and state together, before any side effect.
            await this.store.write(id, run)
          }
          for (const [index, op] of saved.decision.operations.entries())
            await this.operation(run, saved.step, index, op, signal)
          saved.done = true
          await this.store.write(id, run)
          if (run.gate || saved.decision.operations.some((op) => op.kind === 'stop')) break
          if (steps === 999) fault('algorithm-step-limit', 'Algorithm did not terminate in 1000 steps', id)
        }
      }
      if (run.status === 'running') {
        await this.checkCancellation(run, signal)
        run.status = 'complete'
        await this.store.write(id, run)
      }
      return run
    })
  }

  private view(run: ProjectRun): SearchView {
    return projectView(run, this.evidenceCache !== undefined)
  }

  private async checkCancellation(run: ProjectRun, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (await this.store.cancelRequested(run.id)) {
      for (const operation of run.operations.filter((op) => op.status === 'reserved'))
        await this.provider.cancel(operation.id, signal)
      run.status = 'cancelled'
      await this.store.write(run.id, run)
      fault('run-cancelled', 'Cancellation recorded; pending reservations remain accounted', run.id)
    }
  }

  private evidenceIdentity(run: ProjectRun, candidate: string, task: BenchmarkTask): string {
    return canonicalDigest({
      version: 1,
      runtime: this.identity ?? null,
      provider: this.provider.identity,
      benchmark: run.plan.benchmark.digest,
      task,
      target: run.candidates.find((c) => c.id === candidate)!.digest,
      repetition: 0,
    })
  }

  private async ensureBudget(run: ProjectRun, candidates: string[], tasks: BenchmarkTask[]): Promise<void> {
    const missing = new Set<string>()
    for (const candidate of new Set(candidates))
      for (const task of tasks) {
        if (
          run.trials.some((t) => t.candidate === candidate && t.taskId === task.id) ||
          run.operations.some((o) => o.kind === 'evaluation' && o.candidate === candidate && o.taskId === task.id)
        )
          continue
        const identity = this.evidenceIdentity(run, candidate, task)
        if (!(await this.evidenceCache?.find(identity))) {
          // Without a cache the provider owns each candidate's separate attempt.
          missing.add(this.evidenceCache ? identity : canonicalDigest([identity, candidate]))
        }
      }
    if (missing.size + run.operations.filter((o) => o.kind === 'evaluation').length > run.plan.maxEvaluations)
      fault('budget-exhausted', 'Remaining budget cannot complete the comparable evaluation scope', run.id)
  }

  private async evaluate(run: ProjectRun, candidate: string, task: BenchmarkTask, signal: AbortSignal): Promise<void> {
    await this.checkCancellation(run, signal)
    if (run.trials.some((t) => t.candidate === candidate && t.taskId === task.id)) return
    const id = canonicalDigest([run.id, 'evaluation', candidate, task.id])
    let pending = run.operations.find((op) => op.id === id)
    let result: TrialResult | undefined
    const evidenceIdentity = this.evidenceIdentity(run, candidate, task)
    const cached = pending ? undefined : await this.evidenceCache?.find(evidenceIdentity)
    if (cached) result = cached.result
    else if (pending) {
      result = await this.provider.inspectEvaluation(id, signal)
      if (!result)
        fault('operation-pending', 'Previous evaluation may have executed; it will not be resubmitted', run.id, id)
    } else {
      if (run.operations.filter((op) => op.kind === 'evaluation').length >= run.plan.maxEvaluations)
        fault('budget-exhausted', 'Physical evaluation attempt budget exhausted', run.id)
      pending = { id, kind: 'evaluation', candidate, taskId: task.id, status: 'reserved' }
      run.operations.push(pending)
      await this.store.write(run.id, run)
      result = await this.provider.evaluate(
        {
          operationId: id,
          task: {
            id: task.id,
            instruction: task.instruction,
            ...(task.inputs ? { inputs: task.inputs } : {}),
            outputPath: task.scorer.kind === 'file' ? task.scorer.path : '/app/answer.txt',
          },
          target: run.candidates.find((c) => c.id === candidate)!,
        },
        signal,
      )
    }
    validTrial(result)
    const score =
      result.status === 'completed'
        ? (scoreOutput(task.scorer, result.output).value ?? null)
        : result.status === 'task-failed'
          ? 0
          : null
    run.trials.push({
      taskId: task.id,
      candidate,
      split: task.split,
      result,
      score,
      ...(cached ? { reusedFrom: { runId: cached.runId, operationId: cached.operationId } } : {}),
    })
    if (pending) pending.status = 'complete'
    await this.store.write(run.id, run)
    if (!cached && score !== null)
      await this.evidenceCache?.save({ identity: evidenceIdentity, runId: run.id, operationId: id, result })
  }

  private completeScores(run: ProjectRun, candidate: string, tasks: BenchmarkTask[]): number {
    const values = tasks.map((task) => run.trials.find((t) => t.candidate === candidate && t.taskId === task.id)?.score)
    if (!values.length || values.some((v) => v === undefined || v === null))
      fault(
        'incomplete-evidence',
        'Ranking requires complete comparable evidence; missing observations are not zero',
        run.id,
      )
    return (values as number[]).reduce((a, b) => a + b, 0) / values.length
  }

  private async operation(
    run: ProjectRun,
    step: number,
    index: number,
    op: AlgorithmOperation,
    signal: AbortSignal,
  ): Promise<void> {
    await this.checkCancellation(run, signal)
    if (op.kind === 'stop') return
    const receiptId = canonicalDigest([run.id, step, index, op.kind])
    run.completed ??= {}
    if (run.completed[receiptId]) return
    const prerequisite = op.kind === 'generate' ? op.parent : op.candidate
    if (!run.candidates.some((c) => c.id === prerequisite)) {
      run.completed[receiptId] = { kind: op.kind, candidate: op.candidate, status: 'prerequisite-failed' }
      await this.store.write(run.id, run)
      return
    }
    if (op.kind === 'diagnose_seed') {
      // This recipe uses deterministic diagnosis. A model-based diagnosis must
      // be a separate provider operation with its own request/token accounting.
      const ids = op.tasks.length
        ? op.tasks
        : run.plan.benchmark.tasks.filter((t) => t.split === 'seed').map((t) => t.id)
      const tasks = ids.map((id) => {
        const task = run.plan.benchmark.tasks.find((t) => t.id === id && t.split === 'seed')!
        const trial = run.trials.find((t) => t.candidate === op.candidate && t.taskId === id)
        return {
          id,
          family: task.family,
          score: trial?.score ?? null,
          status:
            trial?.score === undefined || trial.score === null
              ? 'unavailable'
              : trial.score < 1
                ? 'failure'
                : 'success',
        }
      })
      run.completed[receiptId] = {
        kind: 'diagnose_seed',
        candidate: op.candidate,
        method: 'seed-score-projection-v1',
        tasks,
      }
      await this.store.write(run.id, run)
      return
    }
    if (op.kind === 'generate') {
      if (run.candidates.some((c) => c.id === op.candidate)) return
      const id = canonicalDigest([run.id, step, index, 'generation'])
      let pending = run.operations.find((o) => o.id === id)
      let files: Record<string, string> | undefined
      try {
        if (pending) {
          files = await this.provider.inspectGeneration(id, signal)
          if (!files) fault('operation-pending', 'Previous generation may still be running', run.id, id)
        } else {
          if (run.operations.filter((o) => o.kind === 'generation').length >= run.plan.maxCandidates)
            fault('budget-exhausted', 'Candidate generation attempt budget exhausted', run.id)
          const diagnosisId =
            op.diagnosis_id ??
            Object.entries(run.completed).findLast(
              ([, result]) => result.kind === 'diagnose_seed' && result.candidate === op.parent,
            )?.[0]
          pending = {
            id,
            kind: 'generation',
            candidate: op.candidate,
            parent: op.parent,
            status: 'reserved',
            ...(diagnosisId ? { diagnosisId } : {}),
          }
          run.operations.push(pending)
          await this.store.write(run.id, run)
          files = await this.provider.generate(
            {
              operationId: id,
              parent: run.candidates.find((c) => c.id === op.parent)!,
              ...(() => {
                const diagnosisId = pending!.diagnosisId
                return diagnosisId ? { diagnosisId, diagnosis: run.completed![diagnosisId]! } : {}
              })(),
              seed: run.plan.benchmark.tasks
                .filter((t) => t.split === 'seed')
                .map((t) => ({
                  id: t.id,
                  instruction: t.instruction,
                  score: run.trials.find((x) => x.taskId === t.id && x.candidate === op.parent)?.score ?? null,
                })),
            },
            signal,
          )
        }
        await this.validateCandidate(files)
      } catch (error) {
        if (!(error instanceof GenerationFailed) && !(error instanceof MutationValidationError)) throw error
        if (pending) pending.status = 'complete'
        run.completed[receiptId] = {
          kind: 'generate',
          candidate: op.candidate,
          status: 'invalid-candidate',
          ...(pending?.diagnosisId ? { diagnosis_id: pending.diagnosisId } : {}),
          ...(error instanceof GenerationFailed ? { reason: error.reason } : {}),
        }
        await this.store.write(run.id, run)
        return
      }
      const snapshot = { id: op.candidate, digest: canonicalDigest(files!), files: files! }
      run.candidates.push(
        this.sealTarget
          ? await this.sealTarget(
              snapshot,
              run.candidates.find((c) => c.id === op.parent),
            )
          : snapshot,
      )
      pending!.status = 'complete'
      run.completed[receiptId] = {
        kind: 'generate',
        candidate: op.candidate,
        status: 'complete',
        digest: snapshot.digest,
        ...(pending!.diagnosisId ? { diagnosis_id: pending!.diagnosisId } : {}),
      }
      await this.store.write(run.id, run)
    } else if (op.kind === 'evaluate_seed') {
      const tasks = run.plan.benchmark.tasks.filter((t) => t.split === 'seed' && op.tasks.includes(t.id))
      await this.ensureBudget(run, [op.candidate], tasks)
      for (const task of tasks) await this.evaluate(run, op.candidate, task, signal)
      run.completed[receiptId] = {
        kind: 'evaluate_seed',
        candidate: op.candidate,
        tasks: op.tasks.map((id) => ({
          id,
          score: run.trials.find((t) => t.candidate === op.candidate && t.taskId === id)?.score ?? null,
        })),
      }
      await this.store.write(run.id, run)
    } else if (op.kind === 'nominate') {
      if (run.gate) return
      const seed = run.plan.benchmark.tasks.filter((t) => t.split === 'seed')
      const seedPair = {
        before: this.completeScores(run, run.champion, seed),
        after: this.completeScores(run, op.candidate, seed),
      }
      if (run.nominee && run.nominee !== op.candidate)
        fault('nomination-frozen', 'The final nominee cannot change', run.id)
      run.nominee = op.candidate
      await this.store.write(run.id, run)
      const mode = run.plan.validation === 'holdout' ? 'independent-held-out' : 'shared-set-research'
      // Reject on seed before requesting any held-out evidence, including when
      // a custom algorithm nominates a worse candidate or the unchanged anchor.
      if (seedPair.after <= seedPair.before || mode === 'shared-set-research') {
        await this.checkCancellation(run, signal)
        run.gate = passRateGate(seedPair, mode)
        if (run.gate.accepted) run.champion = op.candidate
        await this.store.write(run.id, run)
        return
      }
      const tasks =
        run.plan.validation === 'holdout' ? run.plan.benchmark.tasks.filter((t) => t.split === 'held_out') : seed
      await this.ensureBudget(run, [run.champion, op.candidate], tasks)
      for (const candidate of new Set([run.champion, op.candidate]))
        for (const task of tasks) await this.evaluate(run, candidate, task, signal)
      await this.checkCancellation(run, signal)
      const before = this.completeScores(run, run.champion, tasks),
        after = this.completeScores(run, op.candidate, tasks)
      run.gate = passRateGate(seedPair, mode, { before, after })
      if (run.gate.accepted) run.champion = op.candidate
      await this.store.write(run.id, run)
    }
  }
}
