import { execFileSync } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AlgorithmDecision, AlgorithmWorker } from '../../src/domain/algorithm.js'
import { algorithmProtocol } from '../../src/domain/algorithm-protocol.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { ProjectProvider, TrialResult } from '../../src/ports/project.js'
import type { RunStore } from '../../src/ports/run-store.js'
import { type ProjectRun, ProjectRuntime, type RunPlan } from '../../src/runtime/project.js'

function fixture(interruptBridge = false, entrypoint = 'gear.algorithms:StagedGEPA', periodic = false) {
  const seedSize = periodic ? 20 : 10
  const multiParent = entrypoint.startsWith('multi_parent_fixture:')
  let saved: ProjectRun
  let interrupted = false
  const results = new Map<string, TrialResult>()
  const generations = new Map<string, Record<string, string>>()
  const calls: string[] = []
  const steps: number[] = []
  const store: RunStore = {
    async read<T>() {
      return structuredClone(saved) as T
    },
    async write(_id, value) {
      saved = structuredClone(value) as ProjectRun
    },
    async locked(_id, action) {
      return action()
    },
    async cancelRequested() {
      return false
    },
    async requestCancel() {},
  }
  const provider: ProjectProvider = {
    identity: 'staged-fixture-provider',
    capabilities: { meteredAttempts: true, recovery: true, isolatedMeta: true, isolatedTarget: true },
    async evaluate(input) {
      calls.push(input.operationId)
      const result: TrialResult = {
        status: 'completed',
        physicalAttempts: 1,
        output:
          input.target.id === 'initial'
            ? 'wrong'
            : !periodic
              ? 'correct'
              : (saved.algorithmState.plans as Array<{ task_ids: string[] }> | undefined)?.[0]?.task_ids[0] ===
                  input.task.id
                ? 'correct'
                : 'wrong',
      }
      results.set(input.operationId, result)
      if (periodic && !interrupted && saved.algorithmState.stage === 'epoch-results' && input.target.id !== 'initial') {
        interrupted = true
        throw new Error('fixture-worker-disconnected-after-epoch-result')
      }
      if (interruptBridge && !interrupted && saved.algorithmState.stage === 'global') {
        interrupted = true
        throw new Error('fixture-worker-disconnected-after-bridge-result')
      }
      return result
    },
    async inspectEvaluation(id) {
      return results.get(id)
    },
    async generate(input) {
      if (input.diagnosis) {
        expect(input.diagnosisId).toMatch(/^sha256:/)
        expect(saved.completed![input.diagnosisId!]).toEqual(input.diagnosis)
        expect(input.diagnosis.candidate).toBe(input.parent.id)
      }
      const files = { 'AGENTS.md': input.operationId }
      generations.set(input.operationId, files)
      return files
    },
    async inspectGeneration(id) {
      return generations.get(id)
    },
    async cancel() {},
  }
  const algorithm: AlgorithmWorker = {
    identity: `python-fixture:${entrypoint}`,
    async step(view, state, context) {
      expect(JSON.stringify(view)).not.toContain('PRIVATE-HOLDOUT')
      expect(view.seed_tasks.every((t) => t.startsWith('seed-'))).toBe(true)
      expect(view.candidates.every((c) => typeof c.content_digest === 'string')).toBe(true)
      expect(view.evidence_condition).toMatch(/^sha256:/)
      for (const candidate of view.candidates) {
        expect(candidate.execution_digest).toMatch(/^sha256:/)
        expect(Object.keys(candidate.score_evidence!)).toEqual(Object.keys(candidate.scores))
        expect(Object.values(candidate.score_evidence!).every((ref) => ref.startsWith('sha256:'))).toBe(true)
      }
      steps.push(context.stepId)
      const input = { view, state }
      const request = {
        protocol_version: 1,
        request_id: `step-${context.stepId}`,
        run_id: context.runId,
        step_id: context.stepId,
        capabilities: algorithmProtocol.capabilities,
        input_digest: canonicalDigest(input),
        input,
      }
      const raw = execFileSync(
        process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
        ['-m', 'gear._protocol.worker', entrypoint],
        {
          cwd: resolve(import.meta.dirname, '../..'),
          env: {
            PYTHONPATH: ['python', 'examples/python-algorithm', 'tests/fixtures/project_algorithms'].join(delimiter),
            PYTHONDONTWRITEBYTECODE: '1',
          },
          input: `${JSON.stringify(request)}\n`,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      const response = JSON.parse(raw)
      expect(response.input_digest).toBe(request.input_digest)
      return response.decision as AlgorithmDecision
    },
  }
  const plan: RunPlan = {
    kind: 'refine',
    providerIdentity: provider.identity,
    algorithmIdentity: algorithm.identity,
    target: { id: 'initial', files: { 'AGENTS.md': 'initial' }, digest: canonicalDigest('initial') },
    validation: 'holdout',
    maxEvaluations: multiParent ? 200 : periodic ? 100 : 60,
    maxCandidates: multiParent ? 6 : periodic ? 4 : 2,
    split: 'seed',
    taskIds: Array.from({ length: seedSize }, (_, i) => `seed-${i}`),
    benchmark: {
      version: 1,
      sourceDigest: 'fixture-source',
      digest: 'fixture-benchmark',
      metric: { name: 'pass_rate', direction: 'maximize', range: [0, 1], missing: 'invalid' },
      tasks: Array.from({ length: seedSize + 2 }, (_, i) => ({
        id: i < seedSize ? `seed-${i}` : `PRIVATE-HOLDOUT-${i}`,
        instruction: i < seedSize ? 'Produce correct' : 'PRIVATE-HOLDOUT',
        family: periodic ? 'same' : `family-${i % 2}`,
        split: i < seedSize ? ('seed' as const) : ('held_out' as const),
        scorer: { kind: 'text' as const, expected: 'correct', normalization: 'exact' as const },
        fixtures: { positive: 'correct', negative: 'wrong' },
      })),
    },
  }
  const runtime = () => new ProjectRuntime(store, provider, algorithm, async () => {})
  return { plan, runtime, calls, steps, saved: () => saved, generations }
}

describe('Python staged GEPA through the durable TypeScript runtime', () => {
  it('completes local, bridge, global and held-out using the public worker protocol', async () => {
    const f = fixture()
    const run = await f.runtime().start(f.plan, new AbortController().signal)
    expect(run.status).toBe('complete')
    expect(run.gate?.accepted).toBe(true)
    expect(run.decisions.some((d) => d.decision.reason.includes('bridge participants'))).toBe(true)
    expect(run.decisions.some((d) => d.decision.reason.includes('global seed'))).toBe(true)
    expect(run.trials.filter((t) => t.candidate === run.nominee && t.split === 'seed')).toHaveLength(10)
    expect(f.calls.length).toBeLessThanOrEqual(f.plan.maxEvaluations)
    expect(new Set(f.calls).size).toBe(f.calls.length)
    expect(new Set(f.steps).size).toBe(f.steps.length)
    const before = [...f.calls]
    expect(await f.runtime().resume(run.id, new AbortController().signal)).toEqual(run)
    expect(f.calls).toEqual(before)
  })
  it('replays a committed bridge decision after disconnect without resampling or resubmitting', async () => {
    const f = fixture(true)
    await expect(f.runtime().start(f.plan, new AbortController().signal)).rejects.toThrow('fixture-worker-disconnected')
    const pending = f.saved().decisions.find((d) => !d.done)!
    const frozen = structuredClone(pending.decision)
    expect(pending.decision.state.stage).toBe('global')
    const run = await f.runtime().resume(f.saved().id, new AbortController().signal)
    expect(run.gate?.accepted).toBe(true)
    expect(run.decisions[pending.step]!.decision).toEqual(frozen)
    expect(new Set(f.steps).size).toBe(f.steps.length)
    expect(new Set(f.calls).size).toBe(f.calls.length)
    expect(f.generations.size).toBe(2)
    expect(run.operations.every((op) => op.status === 'complete')).toBe(true)
  })
})

it('runs an independent OneShot algorithm through baseline, proposal, full seed, final gate and resume', async () => {
  const f = fixture(false, 'one_shot:build_algorithm')
  const run = await f.runtime().start(f.plan, new AbortController().signal)
  expect(run.status).toBe('complete')
  expect(run.champion).toBe('one-shot')
  expect(run.gate?.accepted).toBe(true)
  expect(run.decisions.flatMap((d) => d.decision.operations.map((op) => op.kind))).toEqual([
    'generate',
    'evaluate_seed',
    'nominate',
  ])
  expect(run.trials.filter((t) => t.candidate === 'one-shot' && t.split === 'seed')).toHaveLength(10)
  expect(run.trials.filter((t) => t.candidate === 'one-shot' && t.split === 'held_out')).toHaveLength(2)
  const submitted = [...f.calls]
  expect(await f.runtime().resume(run.id, new AbortController().signal)).toEqual(run)
  expect(f.calls).toEqual(submitted)
  expect(f.generations.size).toBe(1)
})

it('uses the public multi-scope archive parent policy in a durable Python GEPA run', async () => {
  const f = fixture(false, 'archive_policy:build_algorithm')
  const run = await f.runtime().start(f.plan, new AbortController().signal)
  expect(run.status).toBe('complete')
  expect(run.gate?.accepted).toBe(true)
  expect(run.champion).not.toBe('initial')
  expect(run.trials.filter((t) => t.candidate === run.nominee && t.split === 'seed')).toHaveLength(10)
  expect(run.trials.filter((t) => t.candidate === run.nominee && t.split === 'held_out')).toHaveLength(2)
  expect(run.decisions.every((d) => d.decision.reason.length > 0)).toBe(true)
  expect(f.generations.size).toBe(2)
  expect(f.calls.length).toBeLessThanOrEqual(f.plan.maxEvaluations)
  expect(new Set(f.calls).size).toBe(f.calls.length)
  const submitted = [...f.calls]
  expect(await f.runtime().resume(run.id, new AbortController().signal)).toEqual(run)
  expect(f.calls).toEqual(submitted)
  expect(f.generations.size).toBe(2)
})

it('recovers a frozen periodic scope preparation without resampling parents or resubmitting a lost result', async () => {
  const f = fixture(false, 'periodic:build_algorithm', true)
  await expect(f.runtime().start(f.plan, new AbortController().signal)).rejects.toThrow(
    'disconnected-after-epoch-result',
  )
  const pending = f.saved().decisions.find((d) => !d.done)!
  const frozen = structuredClone(pending.decision)
  expect(frozen.state.stage).toBe('epoch-results')
  const sampling = frozen.state.sampling_evidence as { cutoff_identity: string; tasks: Array<{ id: string }> }
  expect(sampling.cutoff_identity).toMatch(/^sha256:/)
  expect(sampling.tasks.map((t) => t.id)).toEqual(f.plan.taskIds)
  expect(sampling).not.toHaveProperty('observations')
  const preparation = frozen.state.pending_epoch as { scope: { id: string }; admission: { participant_ids: string[] } }
  expect(preparation.admission.participant_ids).toContain('initial')
  for (const batch of frozen.state.parent_batches as Array<{ parent: string }>) {
    expect(preparation.admission.participant_ids).toContain(batch.parent)
  }
  expect(
    (frozen.state.catalog as Array<{ scope: { id: string } }>).some((c) => c.scope.id === preparation.scope.id),
  ).toBe(false)
  const run = await f.runtime().resume(f.saved().id, new AbortController().signal)
  expect(run.status).toBe('complete')
  expect(run.decisions[pending.step]!.decision).toEqual(frozen)
  expect(new Set(f.calls).size).toBe(f.calls.length)
  expect(new Set(f.steps).size).toBe(f.steps.length)
  expect(f.generations.size).toBe(4)
  expect((run.algorithmState.catalog as unknown[]).length).toBeGreaterThanOrEqual(4)
  const calls = [...f.calls]
  expect(await f.runtime().resume(run.id, new AbortController().signal)).toEqual(run)
  expect(f.calls).toEqual(calls)
})

it('recovers every parent allocation and generates from distinct parents after periodic preparation', async () => {
  const f = fixture(false, 'multi_parent_fixture:build_algorithm', true)
  await expect(f.runtime().start(f.plan, new AbortController().signal)).rejects.toThrow(
    'disconnected-after-epoch-result',
  )
  const pending = f.saved().decisions.find((d) => !d.done)!
  const frozen = structuredClone(pending.decision)
  const batches = frozen.state.parent_batches as Array<{ parent: string; slots: number; batch_id: string }>
  expect(new Set(batches.map((b) => b.parent)).size).toBe(2)
  const admission = (frozen.state.pending_epoch as { admission: { participant_ids: string[] } }).admission
  expect(admission.participant_ids).toEqual(expect.arrayContaining(batches.map((b) => b.parent)))
  const run = await f.runtime().resume(f.saved().id, new AbortController().signal)
  expect(run.status).toBe('complete')
  expect(run.decisions[pending.step]!.decision).toEqual(frozen)
  const local = run.decisions.find(
    (d) => d.step > pending.step && d.decision.operations.some((o) => o.kind === 'generate'),
  )!
  expect(new Set(local.decision.operations.filter((o) => o.kind === 'generate').map((o) => o.parent)).size).toBe(2)
  expect(local.decision.state.parent_batches).toEqual(batches)
  expect(f.generations.size).toBe(6)
  expect(new Set(f.calls).size).toBe(f.calls.length)
  expect(new Set(f.steps).size).toBe(f.steps.length)
  expect(f.calls.length).toBeLessThanOrEqual(f.plan.maxEvaluations)
  const calls = [...f.calls]
  expect(await f.runtime().resume(run.id, new AbortController().signal)).toEqual(run)
  expect(f.calls).toEqual(calls)
})

it('binds the exact committed diagnosis in the default Python recipe', async () => {
  const f = fixture(false, 'gear.algorithms:GEPA')
  const run = await f.runtime().start(f.plan, new AbortController().signal)
  expect(run.status).toBe('complete')
  expect(run.gate?.accepted).toBe(true)
  const generated = run.decisions.flatMap((d) => d.decision.operations.filter((op) => op.kind === 'generate'))
  expect(generated.length).toBeGreaterThan(0)
  for (const op of generated) {
    expect(op.diagnosis_id).toMatch(/^sha256:/)
    expect(run.completed![op.diagnosis_id!]!.candidate).toBe(op.parent)
    expect(run.completed![op.diagnosis_id!]!.kind).toBe('diagnose_seed')
  }
  const before = [...f.calls]
  expect(await f.runtime().resume(run.id, new AbortController().signal)).toEqual(run)
  expect(f.calls).toEqual(before)
})
