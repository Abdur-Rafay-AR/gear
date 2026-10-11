import { expect } from 'vitest'
import type { AlgorithmWorker } from '../../src/domain/algorithm.js'
import type { DiagnosisInput, DiagnosisResult } from '../../src/domain/diagnosis.js'
import type { DiagnosisProvider } from '../../src/ports/diagnosis.js'
import type { ProjectProvider, TrialResult } from '../../src/ports/project.js'
import type { RunStore } from '../../src/ports/run-store.js'
import { type ProjectRun, ProjectRuntime, type RunPlan } from '../../src/runtime/project.js'

export function diagnosisFixture(rounds = 1) {
  let saved: ProjectRun | undefined,
    cancelled = false
  const calls: DiagnosisInput[] = [],
    evaluated: string[] = [],
    stopped: string[] = []
  const diagnoses = new Map<string, DiagnosisResult>(),
    trials = new Map<string, TrialResult>()
  const store: RunStore = {
    async read<T>() {
      return structuredClone(saved) as T | undefined
    },
    async write(_id, value) {
      saved = structuredClone(value) as ProjectRun
    },
    async locked(_id, action) {
      return action()
    },
    async cancelRequested() {
      return cancelled
    },
    async requestCancel() {
      cancelled = true
    },
  }
  const answer = (input: DiagnosisInput): DiagnosisResult => ({
    facts: [
      {
        task_id: 'bad',
        evidence_refs: [input.observations.find((o) => o.taskId === 'bad')!.evidenceRef!],
        status: 'supported-hypothesis',
        family_id: 'behavior',
        hypothesis: 'Check instruction handling',
        mechanism: 'The observed seed output violates its frozen scorer',
        modification_paths: ['AGENTS.md'],
      },
    ],
    usage: { requests: 1, inputTokens: 100, outputTokens: 20 },
  })
  const port: DiagnosisProvider = {
    identity: 'diagnosis-fixture-v1',
    capabilities: { boundedRequests: true, boundedTokens: true, recovery: true, isolated: true },
    async diagnose(input) {
      calls.push(structuredClone(input))
      expect(saved!.operations.find((o) => o.id === input.operationId)?.diagnosis?.input).toEqual(input)
      expect(JSON.stringify(input)).not.toContain('PRIVATE-HOLDOUT')
      expect(JSON.stringify(input)).not.toContain('expected')
      const result = answer(input)
      diagnoses.set(input.operationId, result)
      return result
    },
    async inspectDiagnosis(id) {
      const result = diagnoses.get(id)
      return result ? { status: 'complete', result } : { status: 'pending' }
    },
    async cancel(id) {
      stopped.push(id)
    },
  }
  const provider: ProjectProvider = {
    identity: 'evaluation-fixture-v1',
    diagnosis: port,
    capabilities: { meteredAttempts: true, recovery: true, isolatedTarget: true, isolatedMeta: true },
    async evaluate(input) {
      evaluated.push(input.operationId)
      const result: TrialResult = {
        status: 'completed',
        physicalAttempts: 1,
        output: input.task.id === 'bad' && input.target.id === 'initial' ? 'wrong\u0000🦊' : 'ok',
      }
      trials.set(input.operationId, result)
      return result
    },
    async inspectEvaluation(id) {
      return trials.get(id)
    },
    async generate(input) {
      expect(input.delivery?.dossier ?? input.diagnosis?.dossier).toMatchObject({ parent_identity: 'target-v1' })
      return { 'AGENTS.md': 'improved' }
    },
    async inspectGeneration() {
      return { 'AGENTS.md': 'improved' }
    },
    async cancel() {
      throw new Error('Diagnosis cancellation must use its own port')
    },
  }
  const algorithm: AlgorithmWorker = {
    identity: 'diagnosis-algorithm-v1',
    async step(view, state) {
      const n = Number(state.n ?? 0)
      expect(view.diagnosis_budget?.requests).toBe(3 - n)
      return {
        state: { n: n + 1 },
        reason: 'Diagnose the tracked seed',
        operations:
          n < rounds
            ? [{ kind: 'diagnose_seed', candidate: 'initial', parent: '', tasks: view.seed_tasks }]
            : [{ kind: 'stop', candidate: '', parent: '', tasks: [] }],
      }
    },
  }
  const plan: RunPlan = {
    kind: 'refine',
    target: { id: 'initial', digest: 'target-v1', files: { 'AGENTS.md': 'baseline' } },
    providerIdentity: provider.identity,
    algorithmIdentity: algorithm.identity,
    validation: 'holdout',
    maxEvaluations: 10,
    maxCandidates: 1,
    split: 'seed',
    taskIds: ['bad', 'good'],
    diagnosis: { providerIdentity: port.identity, limits: { requests: 3, inputTokens: 1000, outputTokens: 200 } },
    benchmark: {
      version: 1,
      sourceDigest: 'source',
      digest: 'benchmark',
      metric: { name: 'pass_rate', direction: 'maximize', range: [0, 1], missing: 'invalid' },
      tasks: ['bad', 'good', 'held_out'].map((id) => ({
        id,
        instruction: id === 'held_out' ? 'PRIVATE-HOLDOUT' : `task ${id}`,
        family: 'seed-family',
        split: id === 'held_out' ? 'held_out' : 'seed',
        scorer: { kind: 'text', expected: 'ok', normalization: 'exact' },
        fixtures: { positive: 'ok', negative: 'wrong' },
      })),
    },
  }
  const runtime = new ProjectRuntime(store, provider, algorithm, async () => {})
  return {
    runtime,
    store,
    plan,
    provider,
    port,
    algorithm,
    calls,
    evaluated,
    stopped,
    diagnoses,
    answer,
    run: () => saved!,
  }
}
