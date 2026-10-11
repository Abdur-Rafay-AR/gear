import { digestJson } from '../../src/state/digest.js'
import { buildArchive, passesExploration } from '../../src/search/archive.js'
import { profile } from '../../src/search/evidence.js'
import { createParentRandom } from '../../src/search/parent-random.js'
import { parentSelectionInput, validateParentPlan } from '../../src/search/parent-selection.js'
import { championGepaPolicy, resolveParentPolicyRef, scopedFrontierPolicy } from '../../src/search/policies/parents.js'
import { evaluatedFixture, scopeFixture, settings, snapshot, universe } from '../../src/search/testing.js'

export interface ResearchFixture {
  name: string
  size: number
  process: boolean
  champion: string
  members: Array<{
    id: string
    tree?: string
    scores: Array<number | null>
    process_scores?: Array<number | null>
    observed_at: number
  }>
  scopes: Array<{ family: string; epoch: number; tasks: number[]; guard?: number }>
  records: Array<{ scope: number; member: number; omit?: number[]; missing_process?: boolean }>
  input: ReturnType<typeof legacyResearchArchive>['input']
  expected: ReturnType<typeof legacyResearchArchive>['expected']
}

export function legacyResearchArchive(f: ResearchFixture) {
  const u = universe(f.size, 'seed', f.process)
  const config = settings().search
  const snapshots = f.members.map((m) => snapshot(m.id, [], m.tree))
  const scopes = f.scopes.map((s) =>
    scopeFixture(
      u,
      s.tasks.map((t) => `task-${t}`),
      s.family,
      s.epoch,
      s.guard === undefined ? [] : [{ taskId: `task-${s.guard}`, partition: 'seed', rule: 'must-pass' }],
    ),
  )
  const records = f.records.map((r) => {
    const member = f.members[r.member]!,
      scope = scopes[r.scope]!,
      snap = snapshots[r.member]!
    const row = evaluatedFixture(
      u,
      scope,
      snap,
      (id) => {
        const i = Number(id.slice(5)),
          value = member.scores[i],
          process = r.missing_process ? undefined : member.process_scores?.[i]
        return value == null || r.omit?.includes(i)
          ? undefined
          : { outcome: value, ...(process == null ? {} : { process }) }
      },
      { completedAt: new Date(1767225600000 + member.observed_at).toISOString() },
    )
    return { ...row, snapshot: snap, member }
  })
  const archive = buildArchive({
    evolutionId: 'fixed-archive',
    universe: u,
    snapshots,
    scopes,
    plans: records.map((r) => r.plan),
    results: records.map((r) => r.result),
    config,
    championId: f.champion,
    includeChampion: false,
  })
  const parent = parentSelectionInput(archive, 'fixture-round', 5, 23, f.champion)
  const input = {
    seed_tasks: u.tasks.map((t) => t.id),
    members: snapshots.map((s) => ({
      id: s.candidateId,
      identity: s.digest,
      content_identity: `${s.tree}:${s.manifestDigest}`,
    })),
    scopes: scopes.map((s) => ({
      id: s.digest,
      family: s.familyId,
      epoch: s.epoch,
      task_ids: s.taskIds,
      weights: s.weights,
      guard_identity: digestJson(s.guards),
    })),
    observations: records.map((r) => {
      const p = profile(u, r.plan, r.snapshot, r.result, config.process.mode, r.scope.weights)
      return {
        scope_id: r.scope.digest,
        candidate: {
          id: r.snapshot.candidateId,
          identity: `${r.snapshot.tree}:${r.snapshot.manifestDigest}`,
          score_keys: Object.fromEntries(
            p.tasks.filter((t) => t.outcomeKey !== undefined).map((t) => [t.taskId, t.outcomeKey]),
          ),
          aggregate_key: p.outcomeKey ?? null,
          process_keys: Object.fromEntries(
            p.tasks.filter((t) => t.processKey !== undefined).map((t) => [t.taskId, t.processKey]),
          ),
          guard_passed: passesExploration(r.scope, p, u),
          process_complete: p.processComplete,
          observed_at: r.member.observed_at,
        },
      }
    }),
    champion: f.champion,
    family_order: [...new Set(scopes.map((s) => s.familyId))].sort((a, b) => a.localeCompare(b)),
    candidate_order: snapshots.map((s) => s.candidateId).sort((a, b) => a.localeCompare(b)),
    scope_order: scopes.map((s) => s.digest).sort((a, b) => a.localeCompare(b)),
    random_seed: parent.randomSeed,
    random_order: [...snapshots.map((s) => s.candidateId), ...scopes.map((s) => s.digest), 'champion', 'gepa'].sort(
      (a, b) => a.localeCompare(b),
    ),
  }
  const policies = [
    ...[1, 3].map((batch_count) => ({
      name: 'scoped',
      config: batch_count,
      policy: scopedFrontierPolicy(resolveParentPolicyRef({ ...config, parentBatchCount: batch_count })),
    })),
    ...(parent.champion
      ? [0, 0.5, 1].map((champion_probability) => ({
          name: 'champion',
          config: champion_probability,
          policy: championGepaPolicy(
            resolveParentPolicyRef({
              ...config,
              parentSampling: 'epsilon-greedy-gepa-v1',
              championProbability: champion_probability,
            }),
          ),
        }))
      : []),
  ].map(({ name, config, policy }) => {
    const plan = policy.select(parent, createParentRandom(parent.randomSeed))
    validateParentPlan(parent, plan)
    return {
      name,
      config,
      expected: {
        allocations: plan.allocations.map((a) => ({
          scope_id: a.scopeDigest,
          parent_identity: a.parentSnapshotDigest,
          slots: a.slots,
          draw_index: a.drawIndex,
          branch: a.selectionBranch ?? null,
        })),
        parent_probabilities: plan.parentProbabilities,
        reason_codes: plan.reasonCodes,
      },
    }
  })
  return {
    input,
    expected: {
      views: Object.fromEntries(
        archive.scopeViews.map((v) => [
          v.scopeDigest,
          {
            eligible_ids: v.outcomeEligibleIds,
            process_eligible_ids: v.processEligibleIds,
            fronts: v.fronts.map((f) => ({
              task_id: f.taskId,
              channel: f.channel,
              candidate_ids: f.candidateIds,
              informative: f.informative,
            })),
            representatives: v.representatives,
            pruned_ids: v.prunedIds,
            parent_probabilities: v.conditionalParentProbabilities,
            pending_ids: v.pendingEvidenceIds,
            ineligible_ids: v.ineligibleIds,
          },
        ]),
      ),
      scope_probabilities: archive.scopeProbabilities,
      parent_probabilities: archive.parentProbabilities,
      active_parent_ids: archive.activeParentIds,
      champion: parent.champion
        ? {
            candidate_id: parent.champion.candidateId,
            identity: parent.champion.snapshotDigest,
            scope_id: parent.champion.scopeDigest,
          }
        : null,
      policies,
    },
  }
}
