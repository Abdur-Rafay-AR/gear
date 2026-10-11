import { describe, expect, it } from 'vitest'
import { projectReport } from '../../src/application/project-report.js'
import type { AlgorithmDecision, AlgorithmWorker, SearchView } from '../../src/domain/algorithm.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { GenerationFailed } from '../../src/domain/errors.js'
import { MutationValidationError } from '../../src/domain/harness.js'
import type { ProjectProvider, TrialResult } from '../../src/ports/project.js'
import type { RunStore } from '../../src/ports/run-store.js'
import { type ProjectRun, ProjectRuntime, type RunPlan } from '../../src/runtime/project.js'
import { decideFinal } from '../../src/search/promotion.js'
import { evaluatedFixture, scopeFixture, settings, snapshot, universe } from '../../src/search/testing.js'

class MemoryStore implements RunStore {
  values = new Map<string, ProjectRun>()
  cancelled = false
  beforeWrite: ((state: ProjectRun) => void) | undefined
  async read<T>(id: string): Promise<T | undefined> {
    return structuredClone(this.values.get(id)) as T | undefined
  }
  async write(id: string, state: unknown) {
    this.beforeWrite?.(state as ProjectRun)
    this.values.set(id, structuredClone(state) as ProjectRun)
  }
  async locked<T>(_id: string, operation: () => Promise<T>): Promise<T> {
    return operation()
  }
  async cancelRequested() {
    return this.cancelled
  }
  async requestCancel() {
    this.cancelled = true
  }
  get run() {
    return [...this.values.values()][0]!
  }
}
function fixture() {
  const store = new MemoryStore(),
    results = new Map<string, TrialResult>(),
    generations = new Map<string, Record<string, string>>()
  const views: SearchView[] = [],
    submissions: string[] = [],
    cancelled: string[] = []
  const provider: ProjectProvider = {
    identity: 'provider-v1',
    capabilities: { meteredAttempts: true, recovery: true, isolatedMeta: true, isolatedTarget: true },
    async evaluate(input) {
      submissions.push(input.operationId)
      expect(JSON.stringify(input)).not.toContain('expected')
      const result: TrialResult = {
        status: 'completed',
        physicalAttempts: 1,
        output: input.target.id === 'initial' ? 'wrong' : 'correct',
      }
      results.set(input.operationId, result)
      return result
    },
    async inspectEvaluation(id) {
      return results.get(id)
    },
    async generate(input) {
      expect(JSON.stringify(input)).not.toContain('PRIVATE-HOLDOUT')
      const files = { 'AGENTS.md': 'improved' }
      generations.set(input.operationId, files)
      return files
    },
    async inspectGeneration(id) {
      return generations.get(id)
    },
    async cancel(id) {
      cancelled.push(id)
    },
  }
  const algorithm: AlgorithmWorker = {
    identity: 'algorithm-v1',
    async step(view, state) {
      views.push(view)
      const step = Number(state.step ?? 0)
      const operations: AlgorithmDecision['operations'] = [
        { kind: 'generate', candidate: 'next', parent: 'initial', tasks: [] },
        { kind: 'evaluate_seed', candidate: 'next', parent: '', tasks: ['seed'] },
        { kind: 'nominate', candidate: 'next', parent: '', tasks: [] },
      ]
      return { state: { step: step + 1 }, reason: 'test public algorithm', operations: [operations[step]!] }
    },
  }
  const target = { id: 'initial', files: { 'AGENTS.md': 'initial' }, digest: 'target-v1' }
  const plan: RunPlan = {
    kind: 'refine',
    target,
    providerIdentity: provider.identity,
    algorithmIdentity: algorithm.identity,
    validation: 'holdout',
    maxEvaluations: 4,
    maxCandidates: 1,
    split: 'seed',
    taskIds: ['seed'],
    benchmark: {
      version: 1,
      sourceDigest: 'source-v1',
      digest: 'benchmark-v1',
      metric: { name: 'pass_rate', direction: 'maximize', range: [0, 1], missing: 'invalid' },
      tasks: ['seed', 'held_out'].map((split) => ({
        id: split,
        instruction: split === 'seed' ? 'Produce correct' : 'PRIVATE-HOLDOUT',
        family: split,
        split: split as 'seed' | 'held_out',
        scorer: { kind: 'text', expected: 'correct', normalization: 'exact' },
        fixtures: { positive: 'correct', negative: 'wrong' },
      })),
    },
  }
  const runtime = new ProjectRuntime(store, provider, algorithm, async () => {})
  return { store, runtime, provider, algorithm, plan, views, submissions, results, cancelled }
}
const signal = () => new AbortController().signal

describe('durable project runtime', () => {
  it.each(
    [0, 1].flatMap((seedBefore) =>
      [0, 1].flatMap((seedAfter) =>
        [0, 1].flatMap((heldBefore) => [0, 1].map((heldAfter) => ({ seedBefore, seedAfter, heldBefore, heldAfter }))),
      ),
    ),
  )('matches historical pass-rate gates for %j', async ({ seedBefore, seedAfter, heldBefore, heldAfter }) => {
    const anchor = snapshot('initial'),
      candidate = snapshot('next')
    const pair = (partition: 'seed' | 'held-out', before: number, after: number) => {
      const u = universe(1, partition),
        scope = scopeFixture(u, ['task-0'])
      const options = {
        stage: partition === 'seed' ? ('global-seed' as const) : ('held-out' as const),
        participants: ['initial', 'next'],
      }
      const baseline = evaluatedFixture(u, scope, anchor, () => ({ outcome: before }), options)
      const result = evaluatedFixture(u, scope, candidate, () => ({ outcome: after }), options)
      return { universe: u, plan: baseline.plan, anchor, candidate, baseline: baseline.result, result: result.result }
    }
    const historical = decideFinal(
      pair('seed', seedBefore, seedAfter),
      pair('held-out', heldBefore, heldAfter),
      settings().promotion,
    )
    const f = fixture()
    const evaluate = f.provider.evaluate.bind(f.provider)
    f.provider.evaluate = async (input, signal) => {
      const result = await evaluate(input, signal)
      const score =
        input.task.id === 'seed'
          ? input.target.id === 'initial'
            ? seedBefore
            : seedAfter
          : input.target.id === 'initial'
            ? heldBefore
            : heldAfter
      result.output = score ? 'correct' : 'wrong'
      return result
    }
    const run = await f.runtime.start(f.plan, signal())
    expect(run.plan.promotion).toBe('paired-pass-rate-v1')
    expect(run.gate?.accepted).toBe(historical.outcome === 'accepted')
    expect(run.champion).toBe(historical.outcome === 'accepted' ? 'next' : 'initial')
    expect(run.gate?.seed).toEqual({ before: seedBefore, after: seedAfter })
    expect(f.submissions).toHaveLength(seedAfter > seedBefore ? 4 : 2)
    if (seedAfter <= seedBefore) {
      expect(run.gate).toMatchObject({ reason: 'seed-not-improved', heldOut: null, before: null, after: null })
      for (const candidate of projectReport(run).candidates)
        expect(candidate.partitions.find((p) => p.split === 'held_out')).toMatchObject({
          planned: 0,
          missing: 0,
          passRate: null,
        })
    }
    expect((await f.runtime.resume(run.id, signal())).gate).toEqual(run.gate)
    expect(JSON.stringify(projectReport(run, 'meta').gate)).not.toContain('heldOut')
  })
  it('runs a common-scope final gate, accounts physical trials and isolates held-out from algorithms/Meta', async () => {
    const f = fixture(),
      run = await f.runtime.start(f.plan, signal())
    expect(run.champion).toBe('next')
    expect(run.gate).toMatchObject({ accepted: true, before: 0, after: 1 })
    expect(JSON.stringify(f.views)).not.toContain('PRIVATE-HOLDOUT')
    expect(JSON.stringify(f.views)).not.toContain('held_out')
    expect(projectReport(run)).toMatchObject({ physicalAttempts: 4, reservedAttempts: 0 })
    const meta = projectReport(run, 'meta')
    expect(JSON.stringify(meta)).not.toContain('"held_out"')
    expect(meta.gate).not.toHaveProperty('before')
    expect(meta.gate).not.toHaveProperty('after')
    expect((await f.runtime.resume(run.id, signal())).champion).toBe('next')
    expect(f.submissions).toHaveLength(4)
  })
  it('reuses the original valid zero and exact slots without counting them as new physical trials', async () => {
    const f = fixture()
    const cache = new Map<string, import('../../src/ports/evidence-cache.js').CachedTrial>()
    const runtime = new ProjectRuntime(f.store, f.provider, f.algorithm, async () => {}, undefined, {
      async find(id) {
        return cache.get(id)
      },
      async save(trial) {
        if (!cache.has(trial.identity)) cache.set(trial.identity, structuredClone(trial))
      },
    })
    const first = await runtime.start(f.plan, signal())
    const second = await runtime.start(f.plan, signal())
    expect(first.trials[0]?.score).toBe(0)
    expect(second.trials[0]?.score).toBe(0)
    expect(second.champion).toBe(first.champion)
    expect(second.trials.every((t) => t.reusedFrom?.runId === first.id)).toBe(true)
    expect(f.submissions).toHaveLength(4)
    expect(projectReport(second).physicalAttempts).toBe(0)
    expect(JSON.stringify(projectReport(second, 'meta'))).not.toContain('"held_out"')
  })
  it('honors cancellation during the final evaluation before recording terminal success', async () => {
    const f = fixture()
    const evaluate = f.provider.evaluate.bind(f.provider)
    f.provider.evaluate = async (input, signal) => {
      const result = await evaluate(input, signal)
      f.store.cancelled = true
      return result
    }
    await expect(f.runtime.start({ ...f.plan, kind: 'evaluate' }, signal())).rejects.toThrow('Cancellation recorded')
    expect(f.store.run.status).toBe('cancelled')
    expect(f.store.run.operations).toHaveLength(1)
    expect(f.store.run.champion).toBe('initial')
  })
  it('does not start Meta work when cancellation arrives while the algorithm decides', async () => {
    const f = fixture(),
      step = f.algorithm.step.bind(f.algorithm)
    f.algorithm.step = async (...args) => {
      const decision = await step(...args)
      f.store.cancelled = true
      return decision
    }
    let generated = false
    f.provider.generate = async () => {
      generated = true
      return {}
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('Cancellation recorded')
    expect(generated).toBe(false)
    expect(f.store.run.champion).toBe('initial')
  })
  it('refuses resume after the execution-layer implementation changes', async () => {
    const f = fixture()
    const one = new ProjectRuntime(f.store, f.provider, f.algorithm, async () => {}, undefined, undefined, 'runtime-v1')
    const run = await one.start(f.plan, signal())
    const two = new ProjectRuntime(f.store, f.provider, f.algorithm, async () => {}, undefined, undefined, 'runtime-v2')
    await expect(two.resume(run.id, signal())).rejects.toThrow('Frozen configuration')
  })
  it('reconciles a submitted trial after interruption without resetting its budget or rerunning it', async () => {
    const f = fixture()
    f.store.beforeWrite = (state) => {
      if (state.trials.length === 1) throw new Error('power-loss')
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('power-loss')
    expect(f.store.run.operations[0]?.status).toBe('reserved')
    f.store.beforeWrite = undefined
    const run = await f.runtime.resume(f.store.run.id, signal())
    expect(run.champion).toBe('next')
    expect(f.submissions).toHaveLength(4)
    expect(new Set(f.submissions).size).toBe(4)
  })
  it('never resubmits an unknown external operation', async () => {
    const f = fixture()
    f.provider.evaluate = async () => {
      throw new Error('connection-lost')
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('connection-lost')
    const id = f.store.run.id
    await expect(f.runtime.resume(id, signal())).rejects.toMatchObject({
      details: { code: 'operation-pending', run_id: id },
    })
    expect(f.store.run.operations).toHaveLength(1)
  })
  it('replays the committed decision and does not update champion twice after a gate interruption', async () => {
    const f = fixture()
    let once = true
    f.store.beforeWrite = (state) => {
      if (once && state.gate && state.decisions.at(-1)?.done) {
        once = false
        throw new Error('after-gate')
      }
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('after-gate')
    const decisions = f.views.length
    const run = await f.runtime.resume(f.store.run.id, signal())
    expect(run.gate).toMatchObject({ accepted: true, before: 0, after: 1 })
    expect(f.views).toHaveLength(decisions)
    expect(f.submissions).toHaveLength(4)
  })
  it('rejects invalid or incomplete evidence and does not treat it as a valid zero', async () => {
    const f = fixture()
    f.provider.evaluate = async () => ({ status: 'infrastructure-failed', physicalAttempts: 1 })
    await expect(f.runtime.start(f.plan, signal())).rejects.toMatchObject({ details: { code: 'incomplete-evidence' } })
    const report = projectReport(f.store.run)
    expect(report.candidates[0]?.partitions[0]).toMatchObject({ validZero: 0, invalid: 1, passRate: null })
  })
  it('seals research mode and prevents budget overflow before submitting the gate', async () => {
    const f = fixture()
    f.plan.maxEvaluations = 3
    await expect(f.runtime.start(f.plan, signal())).rejects.toMatchObject({ details: { code: 'budget-exhausted' } })
    expect(f.submissions).toHaveLength(2)
    const research = fixture()
    research.plan.validation = 'research'
    research.plan.maxEvaluations = 2
    const run = await research.runtime.start(research.plan, signal())
    expect(run.gate?.mode).toBe('shared-set-research')
    expect(research.submissions).toHaveLength(2)
  })
  it('rejects algorithm attempts to request held-out tasks', async () => {
    const f = fixture()
    f.algorithm.step = async () => ({
      state: {},
      reason: 'bad',
      operations: [{ kind: 'evaluate_seed', candidate: 'initial', parent: '', tasks: ['held_out'] }],
    })
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('invalid-algorithm-operation')
    expect(f.submissions).toHaveLength(1)
  })
  it('preflights an incomplete baseline before starting any physical trial', async () => {
    const f = fixture()
    const second = { ...f.plan.benchmark.tasks[0]!, id: 'seed-2' }
    f.plan.benchmark.tasks.push(second)
    f.plan.maxEvaluations = 1
    await expect(f.runtime.start(f.plan, signal())).rejects.toMatchObject({ details: { code: 'budget-exhausted' } })
    expect(f.submissions).toHaveLength(0)
  })
  it('does not label an interrupted partial baseline as a complete pass rate', async () => {
    const f = fixture()
    f.plan.benchmark.tasks.push({ ...f.plan.benchmark.tasks[0]!, id: 'seed-2' })
    let count = 0
    const evaluate = f.provider.evaluate.bind(f.provider)
    f.provider.evaluate = async (...args) => {
      if (++count === 2) throw new Error('second-trial-pending')
      const result = await evaluate(...args)
      result.output = 'correct'
      return result
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('second-trial-pending')
    const partition = projectReport(f.store.run).candidates[0]!.partitions[0]
    expect(partition).toMatchObject({ planned: 2, observed: 1, valid: 1, missing: 1, passRate: null })
  })
  it('preflights the whole algorithm-selected seed scope and retains its decision on budget exhaustion', async () => {
    const f = fixture()
    f.plan.benchmark.tasks.push({ ...f.plan.benchmark.tasks[0]!, id: 'seed-2' })
    f.plan.maxEvaluations = 3
    f.algorithm.step = async (view) => ({
      state: { planned: true },
      reason: 'Evaluate a two-task scope',
      operations: [
        { kind: 'generate', candidate: 'next', parent: 'initial', tasks: [] },
        { kind: 'evaluate_seed', candidate: 'next', parent: '', tasks: view.seed_tasks },
      ],
    })
    await expect(f.runtime.start(f.plan, signal())).rejects.toMatchObject({ details: { code: 'budget-exhausted' } })
    const saved = f.store.run
    expect(saved.trials).toHaveLength(2)
    expect(saved.trials.every((trial) => trial.candidate === 'initial')).toBe(true)
    expect(saved.decisions[0]?.done).toBe(false)
    await expect(f.runtime.resume(saved.id, signal())).rejects.toMatchObject({ details: { code: 'budget-exhausted' } })
    expect(f.store.run.operations).toEqual(saved.operations)
    expect(f.store.run.decisions).toEqual(saved.decisions)
    expect(f.submissions).toHaveLength(2)
  })
  it('commits batched decisions with distinct operation IDs and passes only seed diagnosis to Meta', async () => {
    const f = fixture()
    f.plan.maxCandidates = 2
    f.plan.validation = 'research'
    f.plan.maxEvaluations = 3
    const generate = f.provider.generate.bind(f.provider)
    let calls = 0
    f.provider.generate = async (input, signal) => {
      calls++
      expect(input.diagnosis).toMatchObject({
        kind: 'diagnose_seed',
        candidate: 'initial',
        tasks: [{ id: 'seed', score: 0 }],
      })
      expect(JSON.stringify(input.diagnosis)).not.toContain('held_out')
      return generate(input, signal)
    }
    f.algorithm.step = async (_view, state) => ({
      state: { done: true },
      reason: 'batch contract',
      operations: state.done
        ? [{ kind: 'nominate', candidate: 'two', parent: '', tasks: [] }]
        : [
            { kind: 'diagnose_seed', candidate: 'initial', parent: '', tasks: ['seed'] },
            { kind: 'generate', candidate: 'one', parent: 'initial', tasks: [] },
            { kind: 'generate', candidate: 'two', parent: 'initial', tasks: [] },
            { kind: 'evaluate_seed', candidate: 'two', parent: '', tasks: ['seed'] },
          ],
    })
    const run = await f.runtime.start(f.plan, signal())
    expect(calls).toBe(2)
    expect(new Set(run.operations.map((o) => o.id)).size).toBe(run.operations.length)
    expect(Object.values(run.completed!).filter((r) => r.kind === 'generate')).toHaveLength(2)
    expect(run.champion).toBe('two')
  })
  it('records invalid candidates once and lets the algorithm stop without resubmitting Meta work', async () => {
    const f = fixture()
    f.algorithm.step = async (view, state) => {
      if (state.done) {
        expect(Object.values(view.completed)).toContainEqual({
          kind: 'generate',
          candidate: 'next',
          status: 'invalid-candidate',
        })
        return {
          state,
          reason: 'Invalid proposal is final',
          operations: [{ kind: 'stop', candidate: '', parent: '', tasks: [] }],
        }
      }
      return {
        state: { done: true },
        reason: 'Attempt once',
        operations: [{ kind: 'generate', candidate: 'next', parent: 'initial', tasks: [] }],
      }
    }
    const runtime = new ProjectRuntime(f.store, f.provider, f.algorithm, async () => {
      throw new MutationValidationError('invalid path')
    })
    const run = await runtime.start(f.plan, signal())
    expect(run.status).toBe('complete')
    expect(run.candidates).toHaveLength(1)
    expect(run.operations.filter((o) => o.kind === 'generation')).toHaveLength(1)
    expect((await runtime.resume(run.id, signal())).operations).toEqual(run.operations)
  })
  it('distinguishes a terminal Meta failure from an unresolved submission and keeps one reservation', async () => {
    const f = fixture()
    let generated = 0
    f.provider.generate = async () => {
      generated++
      throw new GenerationFailed('missing-proposal')
    }
    f.algorithm.step = async (view, state) => {
      if (state.done) {
        expect(Object.values(view.completed)).toContainEqual({
          kind: 'generate',
          candidate: 'next',
          status: 'invalid-candidate',
          reason: 'missing-proposal',
        })
        return { state, reason: 'retain initial', operations: [{ kind: 'stop', candidate: '', parent: '', tasks: [] }] }
      }
      return {
        state: { done: true },
        reason: 'try once',
        operations: [
          { kind: 'generate', candidate: 'next', parent: 'initial', tasks: [] },
          { kind: 'evaluate_seed', candidate: 'next', parent: '', tasks: ['seed'] },
        ],
      }
    }
    const run = await f.runtime.start(f.plan, signal())
    expect(run.champion).toBe('initial')
    expect(generated).toBe(1)
    expect(f.submissions).toHaveLength(1)
    expect(Object.values(run.completed!)).toContainEqual({
      kind: 'evaluate_seed',
      candidate: 'next',
      status: 'prerequisite-failed',
    })
    expect((await f.runtime.resume(run.id, signal())).status).toBe('complete')
  })
  it('canonicalizes floats and unicode independent of insertion order', () => {
    expect(canonicalDigest({ '😀': 0.1, 中: [], nested: { n: null, b: true } })).toBe(
      canonicalDigest({ nested: { b: true, n: null }, 中: [], '😀': 0.1 }),
    )
    expect(() => canonicalDigest(NaN)).toThrow(/out of range/)
  })
})
