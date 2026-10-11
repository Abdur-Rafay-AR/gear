import { resolveMetric, resolveObjective } from '../../src/objective/contracts.js'
import { numeric, repetitionsForTask, utility } from '../../src/search/contracts.js'
import { samplingEvidence } from '../../src/search/scope-sampling.js'
import { evaluatedFixture, revise, scopeFixture, snapshot, universe } from '../../src/search/testing.js'
import type { FailureCluster } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

export interface HistoryFixture {
  name: string
  repetitions: number
  versions: Array<{ id: string; tree?: string; values: Array<Array<number | null>>; invalid?: string[] }>
  copies?: number[]
  minimized?: boolean
  threshold?: number
  objective?: boolean
  perTaskSlots?: number[][]
  diagnoses?: Array<{
    family: string
    tasks: number[]
    controls?: number[]
    paths?: string[]
    features?: Array<{ task: number; modes: string[]; paths: string[] }>
  }>
}

export function legacySamplingHistory(f: HistoryFixture) {
  const base = universe(4)
  let u = revise(base, {
    repetitions: Array.from({ length: f.repetitions }, (_, i) => ({ index: i, seed: i * 13 })),
    tasks: base.tasks.map((t, i) => ({
      ...t,
      estimatedCost: i + 1,
      successUtility: f.threshold ?? 1,
      ...(f.perTaskSlots ? { repetitionIndices: f.perTaskSlots[i] } : {}),
      outcome: f.minimized ? revise(t.outcome, { direction: 'minimize' }) : t.outcome,
    })),
  })
  if (f.objective) {
    const metric = resolveMetric({
      id: 'pass_rate',
      revision: '1',
      unit: 'ratio',
      direction: 'maximize',
      source: { path: 'originalResult.pass', extractor: 'boolean-v1' },
      granularity: 'trial',
      repetitionReducer: 'mean',
      taskReducer: 'weighted-mean',
      comparisonPrecision: 1e-9,
    })
    u = revise(u, {
      rawMetricContracts: [metric],
      objective: resolveObjective({ terms: [{ metric: 'pass_rate', weight: 1 }] }, [metric]),
    })
  }
  const scope = scopeFixture(
    u,
    u.tasks.map((t) => t.id),
  )
  const rows = f.versions.map(
    (v) =>
      evaluatedFixture(u, scope, snapshot(v.id, [], v.tree), (id, r) => {
        const value = v.values[Number(id.slice(5))]?.[r]
        return value == null ? undefined : { outcome: value, invalid: v.invalid?.includes(`${id}:${r}`) ?? false }
      }).result,
  )
  const history = (f.copies ?? rows.map((_, i) => i)).map((i) => rows[i]!)
  const clusters = (f.diagnoses ?? []).map((d) =>
    revise(
      {
        digest: 'unused',
        familyId: d.family,
        parentSnapshotDigest: snapshot('parent').digest,
        dossierDigest: digestJson(['diagnosis', d.family]),
        taskIds: d.tasks.map((i) => `task-${i}`),
        successfulControlTaskIds: (d.controls ?? []).map((i) => `task-${i}`),
        modificationPaths: d.paths ?? [],
        hypotheses: ['fixture'],
        evidenceRefs: [],
        protectedFailure: false,
        estimatedCost: 1,
        taskFeatures: (d.features ?? []).map((x) => ({
          taskId: `task-${x.task}`,
          submodes: x.modes,
          modificationPaths: x.paths,
        })),
      },
      {},
    ),
  ) satisfies FailureCluster[]
  const cutoff = digestJson('fixed-history-cutoff')
  const result = samplingEvidence(u, cutoff, clusters, history)
  const taskIdentity = (id: string) => {
    const t = u.tasks.find((t) => t.id === id)!
    return digestJson([t.contentDigest, t.outcome.digest])
  }
  const plainTask = (t: (typeof u.tasks)[number]) => ({
    id: t.id,
    stratum: t.stratum,
    estimated_cost: t.estimatedCost,
    family_ids: [],
    submodes: [],
    modification_paths: [],
    historical_difficulty: null,
  })
  return {
    input: {
      contracts: u.tasks.map((t) => ({
        task: plainTask(t),
        identity: taskIdentity(t.id),
        slots: repetitionsForTask(u, t.id).map((s) => `${s.index}:${s.seed}`),
        success_utility: t.successUtility,
      })),
      condition_identity: u.conditionDigest,
      cutoff_identity: cutoff,
      objective: f.objective ?? false,
      diagnoses: clusters.map((c) => ({
        family_id: c.familyId,
        task_ids: c.taskIds,
        successful_control_task_ids: c.successfulControlTaskIds ?? [],
        modification_paths: c.modificationPaths,
        features: Object.fromEntries(
          (c.taskFeatures ?? []).map((t) => [
            t.taskId,
            { submodes: t.submodes, modification_paths: t.modificationPaths },
          ]),
        ),
      })),
      observations: history.flatMap((r) =>
        r.cells.map((c) => ({
          task_id: c.identity.taskId,
          task_identity: taskIdentity(c.identity.taskId),
          condition_identity: c.identity.conditionDigest,
          version_identity: digestJson([c.identity.harnessCommit, c.identity.harnessManifestDigest]),
          slot: `${c.identity.repetition}:${c.identity.seed}`,
          utility:
            c.outcome.status === 'available'
              ? numeric(utility(c.outcome.rawValue, u.tasks.find((t) => t.id === c.identity.taskId)!.outcome))
              : null,
          evidence_identity: digestJson([
            c.identity,
            c.evidenceRef,
            c.completedAt,
            c.outcome,
            c.outcomeCertified,
            c.envelope,
          ]),
        })),
      ),
    },
    expected: {
      cutoff_identity: cutoff,
      tasks: u.tasks.map((t) => ({
        ...plainTask(t),
        family_ids: result.tasks[t.id]!.familyIds,
        submodes: result.tasks[t.id]!.submodes,
        modification_paths: result.tasks[t.id]!.modificationPaths,
        historical_difficulty: result.tasks[t.id]!.historicalDifficulty ?? null,
      })),
    },
  }
}
