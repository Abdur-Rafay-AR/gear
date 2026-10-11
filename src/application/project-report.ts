import type { ProjectRun } from '../runtime/project.js'
import { diagnosisAccounting } from '../runtime/project-diagnosis.js'

function plannedTasks(run: ProjectRun, candidate: string, split: 'seed' | 'held_out'): Set<string> {
  const ids = new Set(run.trials.filter((t) => t.candidate === candidate && t.split === split).map((t) => t.taskId))
  const partition = run.plan.benchmark.tasks.filter((t) => t.split === split).map((t) => t.id)
  if (run.plan.kind === 'evaluate') {
    if (candidate === run.plan.target.id && split === run.plan.split) for (const id of run.plan.taskIds) ids.add(id)
  } else if (split === 'seed') {
    if (candidate === run.plan.target.id) for (const id of partition) ids.add(id)
    for (const saved of run.decisions)
      for (const op of saved.decision.operations)
        if (op.kind === 'evaluate_seed' && op.candidate === candidate) for (const id of op.tasks) ids.add(id)
  } else if (
    run.plan.validation === 'holdout' &&
    run.nominee &&
    run.gate?.reason !== 'seed-not-improved' &&
    (candidate === run.plan.target.id || candidate === run.nominee)
  ) {
    for (const id of partition) ids.add(id)
  }
  return ids
}

export function projectReport(run: ProjectRun, view: 'operator' | 'meta' = 'operator') {
  const candidates = run.candidates.map((candidate) => {
    const trials = run.trials.filter((t) => t.candidate === candidate.id)
    return {
      id: candidate.id,
      digest: candidate.digest,
      gitRef: candidate.gitRef ?? null,
      manifestDigest: candidate.manifest?.digest ?? null,
      partitions: (['seed', 'held_out'] as const)
        .filter((split) => view === 'operator' || split === 'seed')
        .map((split) => {
          const selected = trials.filter((t) => t.split === split),
            valid = selected.filter((t) => t.score !== null)
          const planned = plannedTasks(run, candidate.id, split).size
          return {
            split,
            scope: selected.map((t) => t.taskId),
            planned,
            observed: selected.length,
            valid: valid.length,
            validZero: valid.filter((t) => t.score === 0).length,
            invalid: selected.length - valid.length,
            missing: Math.max(0, planned - selected.length),
            passRate:
              planned > 0 && selected.length === planned && valid.length === planned
                ? valid.reduce((sum, t) => sum + t.score!, 0) / valid.length
                : null,
          }
        }),
    }
  })
  const current = run.candidates.find((c) => c.id === run.champion)!,
    initial = run.plan.target
  return {
    run_id: run.id,
    status: run.status,
    kind: run.plan.kind,
    validation_mode: run.plan.validation === 'research' ? 'shared-set-research' : 'independent-held-out',
    ...(run.plan.validation === 'research'
      ? { notice: '同集优化，未做独立验证 / Shared-set optimization; no independent validation.' }
      : {}),
    initial: initial.id,
    champion: run.champion,
    nominee: run.nominee ?? null,
    gate: !run.gate ? null : view === 'operator' ? run.gate : { mode: run.gate.mode, accepted: run.gate.accepted },
    candidates,
    failures: run.trials
      .filter((t) => t.result.status !== 'completed' && (view === 'operator' || t.split === 'seed'))
      .map((t) => ({
        candidate: t.candidate,
        task: t.taskId,
        split: t.split,
        status: t.result.status,
        reason: t.result.reason,
      })),
    physicalAttempts: run.trials.reduce((sum, t) => sum + (t.reusedFrom ? 0 : t.result.physicalAttempts), 0),
    reusedTrials: run.trials
      .filter((t) => t.reusedFrom && (view === 'operator' || t.split === 'seed'))
      .map((t) => ({ taskId: t.taskId, candidate: t.candidate, source: t.reusedFrom })),
    reservedAttempts: run.operations.filter((o) => o.kind === 'evaluation' && o.status === 'reserved').length,
    maxEvaluations: run.plan.maxEvaluations,
    generationAttempts: run.operations.filter((o) => o.kind === 'generation').length,
    ...(run.plan.diagnosis ? { diagnosisBudget: diagnosisAccounting(run) } : {}),
    invalidCandidates: Object.values(run.completed ?? {})
      .filter((r) => r.kind === 'generate' && r.status === 'invalid-candidate')
      .map((r) => r.candidate),
    changes: [...new Set([...Object.keys(initial.files), ...Object.keys(current.files)])]
      .sort()
      .filter((path) => initial.files[path] !== current.files[path])
      .map((path) => ({ path, before: initial.files[path] ?? null, after: current.files[path] ?? null })),
    next_action:
      view === 'meta'
        ? `gear ${run.status === 'running' ? 'resume' : 'report'} ${run.id} --view meta`
        : run.status === 'running'
          ? `gear resume ${run.id}`
          : `gear export ${run.id}`,
  }
}
