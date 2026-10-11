import { digestJson } from '../state/evolution.js'
import type { CandidateAssessment, CandidateAssessmentResult, ComponentRef, EvaluationEvidence, HitchTrajectoryReader, MetricSet, PairedTrial, PairingAudit, PublicSeedEvidence, RefineEvaluator } from '../types.js'

export function trialReward(trial: EvaluationEvidence['trials'][number]): number | undefined {
  return trial.rewards.reward ?? Object.values(trial.rewards)[0]
}

export function validMetricSet(value: MetricSet): boolean {
  return Number.isFinite(value.quality) && Number.isFinite(value.taskSuccessRate)
    && [value.cost, value.latency, value.safety, value.trajectoryDiversity]
      .every(metric => metric === undefined || Number.isFinite(metric))
    && (value.descriptors === undefined || Object.values(value.descriptors)
      .every(item => typeof item === 'string' || Number.isFinite(item)))
}

export function sealAssessment(
  component: ComponentRef<unknown>,
  candidates: readonly import('../types.js').CandidateSelectionInput[],
  result: CandidateAssessmentResult,
): CandidateAssessment {
  const candidateIds = candidates.map(candidate => candidate.candidateId).sort()
  const metricIds = Object.keys(result.candidateMetrics).sort()
  if (JSON.stringify(candidateIds) !== JSON.stringify(metricIds)
    || Object.values(result.candidateMetrics).some(metrics => !validMetricSet(metrics))) {
    throw new Error('candidate assessor returned invalid or incomplete metrics')
  }
  if (result.rankingCandidateIds !== undefined
    && JSON.stringify([...result.rankingCandidateIds].sort()) !== JSON.stringify(candidateIds)) {
    throw new Error('candidate assessor ranking is not a candidate permutation')
  }
  if (result.reason.length === 0) throw new Error('candidate assessor must provide a reason')
  if (result.usage !== undefined) {
    const usage = [result.usage.modelRequests, result.usage.inputTokens, result.usage.outputTokens,
      result.usage.cachedInputTokens, result.usage.reasoningTokens]
    if (usage.some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
      throw new Error('candidate assessor returned invalid usage')
    }
  }
  const identity = {
    component,
    candidateMetrics: result.candidateMetrics,
    ...(result.rankingCandidateIds === undefined ? {} : { rankingCandidateIds: result.rankingCandidateIds }),
    reason: result.reason,
    evidence: result.evidence,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  }
  return { ...identity, digest: digestJson(identity) }
}

export function trajectoryReader(evaluator: RefineEvaluator): HitchTrajectoryReader | undefined {
  const value = evaluator as Partial<HitchTrajectoryReader>
  return typeof value.inspectCapabilities === 'function'
    && typeof value.inspectTrajectoryAnalysis === 'function'
    && typeof value.inspectTrajectoryEvents === 'function'
    ? value as HitchTrajectoryReader
    : undefined
}

export function publicSeedEvidence(evidence: EvaluationEvidence): PublicSeedEvidence {
  return {
    ...(evidence.rawMetrics ? { rawMetrics: evidence.rawMetrics } : {}),
    ...(evidence.objectiveScore ? { objectiveScore: evidence.objectiveScore } : {}),
    evalId: evidence.evalId,
    completeness: evidence.completeness,
    plannedTrialCount: evidence.plannedTrialCount,
    primaryReward: evidence.primaryReward,
    ...(evidence.processScore === undefined ? {} : { processScore: evidence.processScore }),
    summary: evidence.summary,
    trials: [
      ...evidence.trials.map(trial => {
        const reward = trialReward(trial)
        return {
          taskName: trial.taskName,
          ...(trial.trialName === undefined ? {} : { trialName: trial.trialName }),
          ...(trial.runId === undefined ? {} : { runId: trial.runId }),
          ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
          status: trial.status,
          ...(trial.passStatus === undefined ? {} : { passStatus: trial.passStatus }),
          ...(reward === undefined ? {} : { reward }),
          ...(trial.scores === undefined ? {} : { scores: trial.scores }),
        }
      }),
      ...evidence.invalidTrials.map(({ originalResult: privateOriginal, ...trial }) => trial),
    ],
  }
}

export function trialIdentity(trial: { taskName: string; attempt?: number }): string {
  return JSON.stringify([trial.taskName, trial.attempt ?? null])
}

export function plannedTrialKeys(evidence: EvaluationEvidence): string[] {
  return [...evidence.trials, ...evidence.invalidTrials]
    .map(trialIdentity)
    .sort((left, right) => left.localeCompare(right))
}

export function pairedTrials(baseline: EvaluationEvidence, candidate: EvaluationEvidence): PairedTrial[] {
  const index = new Map<string, EvaluationEvidence['trials'][number]>()
  for (const trial of baseline.trials) {
    const trialKey = trialIdentity(trial)
    if (index.has(trialKey)) throw new Error(`baseline has ambiguous duplicate trial identity: ${trialKey}`)
    index.set(trialKey, trial)
  }
  const result: PairedTrial[] = []
  for (const trial of candidate.trials) {
    const trialKey = trialIdentity(trial)
    const before = index.get(trialKey)
    if (before === undefined) continue
    const baselineReward = trialReward(before)
    const candidateReward = trialReward(trial)
    if (baselineReward === undefined || candidateReward === undefined) {
      throw new Error(`paired trial has no reward: ${trialKey}`)
    }
    const baselineProcessScore = before.scores?.processScore
    const candidateProcessScore = trial.scores?.processScore
    result.push({
      conditionId: baseline.conditionId,
      trialKey,
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
    })
  }
  return result.sort((left, right) => left.trialKey.localeCompare(right.trialKey))
}

export function pairingAudit(
  baseline: EvaluationEvidence,
  candidate: EvaluationEvidence,
  pairs: readonly PairedTrial[],
): PairingAudit {
  return {
    planned: baseline.plannedTrialCount,
    paired: pairs.length,
    excluded: baseline.plannedTrialCount - pairs.length,
    baselineInvalid: baseline.invalidTrials.length,
    candidateInvalid: candidate.invalidTrials.length,
  }
}

export function pairedAggregate(pairs: readonly PairedTrial[], side: 'baseline' | 'candidate'): {
  score: number
  passed: number
  total: number
} {
  const rewards = pairs.map(pair => side === 'baseline' ? pair.baselineReward : pair.candidateReward)
  return {
    score: rewards.length === 0 ? 0 : rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length,
    passed: rewards.filter(reward => reward > 0).length,
    total: rewards.length,
  }
}

export function pairedProcessAggregate(pairs: readonly PairedTrial[], side: 'baseline' | 'candidate'): number | undefined {
  const scores = pairs.map(pair => side === 'baseline' ? pair.baselineProcessScore : pair.candidateProcessScore)
  if (scores.length === 0 || scores.some(score => score === undefined)) return undefined
  const available = scores as number[]
  return available.reduce((sum, score) => sum + score, 0) / available.length
}

export function pairedProcessDelta(pairs: readonly PairedTrial[]): number | undefined {
  const baseline = pairedProcessAggregate(pairs, 'baseline')
  const candidate = pairedProcessAggregate(pairs, 'candidate')
  return baseline === undefined || candidate === undefined ? undefined : candidate - baseline
}

export function projectPairedEvidence(
  evidence: EvaluationEvidence,
  pairs: readonly PairedTrial[],
  side: 'baseline' | 'candidate',
): EvaluationEvidence {
  const keys = new Set(pairs.map(pair => pair.trialKey))
  const trials = evidence.trials.filter(trial => keys.has(trialIdentity(trial)))
  const aggregate = pairedAggregate(pairs, side)
  const processScore = pairedProcessAggregate(pairs, side)
  return {
    ...evidence,
    completeness: 'complete',
    plannedTrialCount: pairs.length,
    primaryReward: aggregate.score,
    ...(processScore === undefined ? {} : { processScore }),
    summary: {
      total: aggregate.total,
      passed: aggregate.passed,
      failed: aggregate.total - aggregate.passed,
      score: aggregate.score,
      metrics: { primaryReward: aggregate.score, totalScore: aggregate.score, ...(processScore === undefined ? {} : { processScore }) },
      ...(processScore === undefined ? {} : { process: { score: processScore } }),
    },
    trials,
    invalidTrials: [],
  }
}
