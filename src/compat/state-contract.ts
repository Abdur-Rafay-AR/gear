import type { CandidateAssessment, ChampionState, ComponentKind, ComponentRef, EvaluationEvidence, MetaSessionState,
  PairedTrial, PairingAudit, PopulationMember, PopulationState, RefinementRound, RoundEvaluationAttempt, EvaluationSubmissionIntent } from '../types.js'
import { isExactGitCommit } from '../types.js'
import { digestJson } from '../state/digest.js'
export function validMetricSet(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const metrics = value as Record<string, unknown>
  if (!Number.isFinite(metrics.quality) || !Number.isFinite(metrics.taskSuccessRate)) return false
  for (const key of ['cost', 'latency', 'safety', 'trajectoryDiversity']) {
    if (metrics[key] !== undefined && !Number.isFinite(metrics[key])) return false
  }
  if (metrics.descriptors !== undefined) {
    if (typeof metrics.descriptors !== 'object' || metrics.descriptors === null || Array.isArray(metrics.descriptors)) return false
    if (Object.values(metrics.descriptors).some(item => typeof item !== 'string' && !Number.isFinite(item))) return false
  }
  return true
}

export function validMetaPrerequisiteFailure(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const blocker = value as Record<string, unknown>
  if (blocker.schemaVersion !== 1
    || blocker.code !== 'VERIFIER_EVIDENCE_UNAVAILABLE' && blocker.code !== 'TRAJECTORY_EVIDENCE_UNAVAILABLE'
    || blocker.failedOperation !== 'candidate.finalize' && blocker.failedOperation !== 'candidate.decline'
      && blocker.failedOperation !== 'trajectory.query'
    || !Array.isArray(blocker.blockedRuns) || blocker.blockedRuns.length === 0) return false
  return blocker.blockedRuns.every(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const run = item as Record<string, unknown>
    return typeof run.runId === 'string' && /^run_[0-9a-f]{32}$/u.test(run.runId)
      && typeof run.code === 'string' && /^[a-z0-9_]{1,128}$/u.test(run.code)
      && (run.cause === undefined || typeof run.cause === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(run.cause))
      && (run.resolution === undefined || run.resolution === 'upgrade-hitch' || run.resolution === 'repair-evidence')
  })
}

export function trialKey(trial: { taskName: string; attempt?: number }): string {
  return JSON.stringify([trial.taskName, trial.attempt ?? null])
}

export function trialReward(trial: EvaluationEvidence['trials'][number]): number {
  const reward = trial.rewards.reward ?? Object.values(trial.rewards)[0]
  if (reward === undefined) throw new TypeError('paired evaluation trial has no reward')
  return reward
}

export function expectedPairedTrials(baseline: EvaluationEvidence, candidate: EvaluationEvidence): PairedTrial[] {
  const baselineTrials = new Map(baseline.trials.map(trial => [trialKey(trial), trial]))
  return candidate.trials.flatMap(trial => {
    const key = trialKey(trial)
    const before = baselineTrials.get(key)
    if (before === undefined) return []
    const baselineReward = trialReward(before)
    const candidateReward = trialReward(trial)
    const baselineProcessScore = before.scores?.processScore
    const candidateProcessScore = trial.scores?.processScore
    return [{
      conditionId: baseline.conditionId,
      trialKey: key,
      taskName: trial.taskName,
      ...(before.trialName === undefined ? {} : { baselineTrialName: before.trialName }),
      ...(trial.trialName === undefined ? {} : { candidateTrialName: trial.trialName }),
      ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
      ...(before.runId === undefined ? {} : { baselineRunId: before.runId }),
      ...(trial.runId === undefined ? {} : { candidateRunId: trial.runId }),
      baselineReward,
      candidateReward,
      rewardDelta: candidateReward - baselineReward,
      ...(baselineProcessScore === undefined ? {} : { baselineProcessScore }),
      ...(candidateProcessScore === undefined ? {} : { candidateProcessScore }),
      ...(baselineProcessScore === undefined || candidateProcessScore === undefined
        ? {}
        : { processScoreDelta: candidateProcessScore - baselineProcessScore }),
    }]
  }).sort((left, right) => left.trialKey.localeCompare(right.trialKey))
}

export function pairedScoreDelta(pairs: readonly PairedTrial[]): number {
  if (pairs.length === 0) return 0
  return pairs.reduce((sum, pair) => sum + pair.candidateReward - pair.baselineReward, 0) / pairs.length
}

export function pairedProcessScoreDelta(pairs: readonly PairedTrial[]): number | undefined {
  if (pairs.length === 0 || pairs.some(pair => pair.baselineProcessScore === undefined || pair.candidateProcessScore === undefined)) return undefined
  return pairs.reduce((sum, pair) => sum + pair.candidateProcessScore! - pair.baselineProcessScore!, 0) / pairs.length
}

export function requiredRegressionCount(requiredTaskIds: readonly string[], pairs: readonly PairedTrial[]): number {
  if (pairs.length === 0) return 0
  const grouped = new Map<string, PairedTrial[]>()
  for (const pair of pairs) grouped.set(pair.taskName, [...(grouped.get(pair.taskName) ?? []), pair])
  let regressions = 0
  for (const task of requiredTaskIds) {
    const taskPairs = grouped.get(task)
    if (taskPairs === undefined || taskPairs.length === 0) {
      throw new TypeError(`required task has no valid paired rollout cell: ${task}`)
    }
    const baseline = taskPairs.reduce((sum, pair) => sum + pair.baselineReward, 0) / taskPairs.length
    const candidate = taskPairs.reduce((sum, pair) => sum + pair.candidateReward, 0) / taskPairs.length
    if (candidate < baseline) regressions += 1
  }
  return regressions
}

export function validComponentRef(value: ComponentRef<unknown>, kind: ComponentKind): boolean {
  return value.kind === kind && value.apiVersion === 1 && value.id.length > 0
    && value.implementation.package.length > 0 && value.implementation.version.length > 0
    && value.implementation.integrity.length > 0 && digestJson(value.config) === value.configDigest
}
