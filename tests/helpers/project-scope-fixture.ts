import { resolveSizing, seal } from '../../src/search/contracts.js'
import { crossOrder, representativeOrder } from '../../src/search/scope-sampling.js'
import { createScope, sharedTasks } from '../../src/search/scopes.js'
import { revise, settings, universe } from '../../src/search/testing.js'
import type { TaskSetLimit } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

interface Limit { ratio: number; min_tasks?: number; max_tasks?: number }
export interface ScopeFixture {
  name: string
  tasks: Array<{
    id: string; stratum: string; estimated_cost?: number; family_ids?: string[]
    submodes?: string[]; modification_paths?: string[]; historical_difficulty?: number
  }>
  config: {
    seed: string; local: Limit; shared: Limit; cross: Limit; bridge: Limit
    bucket_weights: { local: number; shared: number; cross: number }
    shared_core_task_ids: string[]; guard_task_ids: string[]
  }
  family: { id: string; task_ids: string[]; successful_control_task_ids: string[]; modification_paths: string[] }
  successful_ids: string[]
  epoch: number
  expected: ReturnType<typeof legacyScopeResult>
}

/** Projection only: all selections and quota decisions come from the legacy implementation. */
export function legacyScopeResult(fixture: ScopeFixture) {
  const base = universe(fixture.tasks.length)
  const seed = revise(base, { tasks: fixture.tasks.map((task, i) => ({
    ...base.tasks[i]!, id: task.id, stratum: task.stratum, estimatedCost: task.estimated_cost ?? 1,
  })) })
  const evidence = seal({
    universeDigest: seed.digest, cutoffDigest: digestJson('scope-fixture-cutoff'), clusterDigests: [],
    tasks: Object.fromEntries(fixture.tasks.map(task => [task.id, {
      familyIds: task.family_ids ?? [], submodes: task.submodes ?? [], modificationPaths: task.modification_paths ?? [],
      ...(task.historical_difficulty === undefined ? {} : { historicalDifficulty: task.historical_difficulty }),
    }])),
  })
  const config = settings().search
  // SearchConfig historically admits numeric seeds; the ordering primitives
  // interpolate that seed as text. Fixtures keep the same decimal string.
  config.seed = Number(fixture.config.seed)
  const limit = (value: Limit): TaskSetLimit => ({ ratio: value.ratio,
    ...(value.min_tasks === undefined ? {} : { minTasks: value.min_tasks }),
    ...(value.max_tasks === undefined ? {} : { maxTasks: value.max_tasks }),
  })
  for (const name of ['local', 'shared', 'cross', 'bridge'] as const) config.taskSetSizing[name] = limit(fixture.config[name])
  config.scopeSampling = { ...config.scopeSampling, sharedCoreTaskIds: fixture.config.shared_core_task_ids,
    bucketWeights: fixture.config.bucket_weights }
  config.explorationGuards = fixture.config.guard_task_ids.map(taskId => ({taskId, partition: 'seed', rule: 'must-pass'}))
  const sizing = resolveSizing(seed, config.taskSetSizing)
  const shared = sharedTasks(seed, sizing, config, fixture.successful_ids, fixture.epoch)
  const scope = createScope(seed, sizing, config, {
    familyId: fixture.family.id, taskIds: fixture.family.task_ids,
    successfulControlTaskIds: fixture.family.successful_control_task_ids,
    modificationPaths: fixture.family.modification_paths,
  }, shared, fixture.epoch, evidence)
  const cross = crossOrder(seed, new Set(fixture.family.task_ids), fixture.family.id,
    fixture.family.modification_paths, fixture.config.seed, evidence)
  return {
    quantities: sizing.quantities,
    representative: representativeOrder(seed, fixture.tasks.map(task => task.id), fixture.config.seed, evidence),
    cross: { ids: cross.ids, general_ids: cross.generalIds },
    scope: scope ? {
      family_id: scope.familyId, epoch: scope.epoch, buckets: scope.buckets,
      task_ids: scope.taskIds, weights: scope.weights, sampling: scope.sampling,
    } : null,
  }
}
