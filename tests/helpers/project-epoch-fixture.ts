import { buildArchive, selectParents } from '../../src/search/archive.js'
import { resolveSizing, seal } from '../../src/search/contracts.js'
import { prepareScopeEpochs } from '../../src/search/epochs.js'
import { samplingEvidence } from '../../src/search/scope-sampling.js'
import {
  evaluatedFixture,
  MemorySearchStore,
  revise,
  scopeFixture,
  settings,
  snapshot,
  universe,
} from '../../src/search/testing.js'
import { digestJson } from '../../src/state/digest.js'
import type { FailureCluster } from '../../src/search/types.js'

export interface EpochFixture {
  name: string
  period: number | null
  round: number
  maxHistorical: number
  cells: number
  repair: number
  repairPerCandidate: number
  cached: string[]
  history?: boolean
  equivalent?: boolean
  selected?: boolean
}

export async function legacyEpochAdmission(f: EpochFixture) {
  const u = universe(4),
    config = settings(),
    store = new MemorySearchStore()
  config.search.scopeSampling = {
    ...config.search.scopeSampling,
    epochPolicy: f.period === null ? 'stable' : 'periodic',
    updateEveryRounds: f.period ?? 1,
    maxHistoricalSpecialists: f.maxHistorical,
  }
  config.budgets.round.maxNewRolloutCells = config.budgets.evolution.maxNewRolloutCells = f.cells
  config.budgets.round.maxRepairCells = config.budgets.evolution.maxRepairCells = f.repair
  const epoch = f.period === null ? 1 : 1 + Math.floor(f.round / f.period)
  const members = [snapshot('anchor'), snapshot('chosen'), snapshot('specialist')]
  const previous = scopeFixture(u, ['task-0', 'task-1'], 'family', 1)
  const proposed = scopeFixture(u, f.equivalent ? previous.taskIds : ['task-2', 'task-3'], 'family', epoch)
  const rows = members.map((s, i) =>
    evaluatedFixture(u, previous, s, (id) => ({
      outcome: i === 0 ? 0 : id === (i === 1 ? 'task-0' : 'task-1') ? 1 : 0,
    })),
  )
  const family = seal({
    familyId: 'family',
    parentSnapshotDigest: members[0]!.digest,
    dossierDigest: digestJson('fixture-diagnosis'),
    protectedFailure: false,
    estimatedCost: 2,
    taskIds: ['task-0', 'task-1'],
    successfulControlTaskIds: [],
    modificationPaths: [],
    evidenceRefs: [],
    hypotheses: ['fixture'],
  }) satisfies FailureCluster
  const archive = buildArchive({
    evolutionId: 'epoch-fixture',
    universe: u,
    snapshots: members,
    scopes: [previous],
    plans: rows.map((r) => r.plan),
    results: rows.map((r) => r.result),
    config: config.search,
    championId: 'anchor',
    clusters: f.history === false ? [] : [family],
  })
  const parents = revise(selectParents(archive, config.search, 2, 'epoch-round'), {
    batches:
      f.selected === false
        ? []
        : [
            {
              batchId: 'epoch-batch',
              sourceScopeDigest: previous.digest,
              parentSnapshotDigest: members[1]!.digest,
              maxCandidateSlots: 2,
              drawIndex: 0,
            },
          ],
  })
  const sampler = samplingEvidence(u, archive.digest, archive.clusters, archive.results)
  // Model an already frozen proposal. Scope sampling itself has separate historical fixtures.
  await store.freezeEvolution(`scope-epoch-${digestJson([previous.familyId, epoch]).slice(7)}`, () =>
    seal({
      scope: proposed,
      sampler,
      archiveCutoffDigest: archive.digest,
      clusterDigests: archive.clusters.map((c) => c.digest),
      ruleDigest: digestJson(config.search.scopeSampling),
    }),
  )
  const quotes: Array<{ ids: string[]; tasks: string[]; cost: { cells: number; repair_cells: number } }> = []
  const prepared = await prepareScopeEpochs({
    store,
    roundId: 'epoch-round',
    roundIndex: f.round,
    settings: config,
    archive,
    universe: u,
    anchor: members[0]!,
    parents,
    resolution: resolveSizing(u, config.search.taskSetSizing),
    async missingCost(snapshots, taskIds) {
      const cost = {
        cells: snapshots.reduce(
          (sum, s) => sum + taskIds.filter((t) => !f.cached.includes(`${s.candidateId}:${t}`)).length,
          0,
        ),
        repairCells: snapshots.length * f.repairPerCandidate,
      }
      quotes.push({
        ids: snapshots.map((s) => s.candidateId),
        tasks: taskIds,
        cost: { cells: cost.cells, repair_cells: cost.repairCells },
      })
      return cost
    },
    async evaluate(plan, s) {
      const result = evaluatedFixture(u, proposed, s, () => ({ outcome: 1 }), {
        participants: plan.participantIds,
        stage: 'baseline-probe',
      }).result
      return revise(result, { stagePlanDigest: plan.digest })
    },
  })
  const project = (s: typeof previous) => ({
    id: s.digest,
    family: s.familyId,
    epoch: s.epoch,
    task_ids: s.taskIds,
    weights: s.weights,
    guard_identity: digestJson(s.guards),
  })
  const probabilities = archive.scopeViews[0]!.conditionalParentProbabilities
  const decision = prepared.decisions[0]
  return {
    input: {
      period: f.period,
      round_index: f.round,
      max_historical: f.maxHistorical,
      previous: project(previous),
      proposed: f.history === false ? null : project(proposed),
      anchor: 'anchor',
      selected: f.selected === false ? [] : ['chosen'],
      historical_probabilities: probabilities,
      historical_order: Object.keys(probabilities).sort((a, b) => a.localeCompare(b)),
      remaining: { cells: f.cells, repair_cells: f.repair },
      cached: f.cached,
      repair_per_candidate: f.repairPerCandidate,
    },
    expected: {
      epoch: prepared.epoch,
      admission: decision
        ? {
            family_id: decision.familyId,
            previous_scope_id: decision.previousScopeDigest,
            proposed_scope_id: decision.proposedScopeDigest ?? null,
            participant_ids: decision.participantIds,
            excluded_historical_ids: decision.excludedHistoricalIds,
            status: decision.status === 'prepared' ? 'admitted' : decision.status,
            reason_codes: decision.reasonCodes,
            cost: quotes.at(-1)?.cost ?? { cells: 0, repair_cells: 0 },
          }
        : null,
      quotes,
    },
  }
}
