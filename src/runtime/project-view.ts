import type { SearchView } from '../domain/algorithm.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { ProjectRun } from './project.js'

/** Only verified seed scores and opaque provenance cross into algorithm workers. */
export function projectView(run: ProjectRun, sharedEvidence: boolean): SearchView {
  const tasks = run.plan.benchmark.tasks.filter((t) => t.split === 'seed')
  const seed = tasks.map((t) => t.id)
  const heldoutReserve =
    run.plan.validation === 'holdout' ? run.plan.benchmark.tasks.filter((t) => t.split === 'held_out').length * 2 : 0
  const condition = canonicalDigest({
    version: 1,
    runtime: run.plan.runtimeIdentity ?? null,
    provider: run.plan.providerIdentity,
    benchmark: run.plan.benchmark.digest,
    repetition: 0,
  })
  return {
    seed_tasks: seed,
    candidates: run.candidates.map((candidate) => {
      const trials = run.trials.filter((t) => t.candidate === candidate.id && t.split === 'seed' && t.score !== null)
      return {
        id: candidate.id,
        content_digest: candidate.digest,
        // A provider without a shared cache owns independent physical attempts
        // even when two candidate snapshots contain the same Target bytes.
        execution_digest: canonicalDigest([condition, candidate.digest, sharedEvidence ? null : candidate.id]),
        scores: Object.fromEntries(trials.map((t) => [t.taskId, t.score!])),
        score_evidence: Object.fromEntries(
          trials.map((t) => [
            t.taskId,
            t.reusedFrom?.operationId ?? canonicalDigest([run.id, 'evaluation', candidate.id, t.taskId]),
          ]),
        ),
      }
    }),
    champion: run.champion,
    max_candidates: run.plan.maxCandidates,
    random_seed: run.planDigest,
    remaining_evaluations: Math.max(
      0,
      run.plan.maxEvaluations - run.operations.filter((o) => o.kind === 'evaluation').length - heldoutReserve,
    ),
    completed: structuredClone(run.completed ?? {}),
    task_families: Object.fromEntries(tasks.map((t) => [t.id, t.family])),
    evidence_condition: condition,
  }
}
