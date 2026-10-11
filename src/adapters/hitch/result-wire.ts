import type {
  EvaluationRequest,
  EvaluationTrialScores,
  HitchEvaluationEvidence,
  HitchTrialSummary,
  InvalidEvaluationTrialSummary,
  LocalSourceTransportSummary,
  ScoreSummary,
} from '../../types.js'
import { isExactGitCommit } from '../../types.js'
import {
  HitchEvaluationError,
  type HitchEvaluationIdentity,
  type JsonRecord,
  type ParsedRunTrial,
  type ProcessResult,
} from './contracts.js'
import { evaluationTrialScores } from './verifier-wire.js'
import { finite, integer, jsonValue, record, rewardForTrial, string } from './wire-primitives.js'

export function parseResult(
  harnessId: string,
  value: unknown,
  processResult: ProcessResult,
  request: Readonly<EvaluationRequest>,
  identity: HitchEvaluationIdentity,
  allowFailedRunEvidence = false,
): HitchEvaluationEvidence {
  const result = record(value, 'Hitch result')
  if (result.schema_version !== '1')
    throw new HitchEvaluationError('unsupported Hitch eval schema', 'unsupported_hitch_schema')
  const evalId = string(result.eval_id, 'eval_id')
  if (!/^eval_[0-9a-f]{32}$/u.test(evalId))
    throw new HitchEvaluationError('invalid Hitch eval_id', 'invalid_hitch_result')
  const exitCode = integer(result.exit_code, 'exit_code')
  if (processResult.exitCode !== exitCode) {
    throw new HitchEvaluationError(`Hitch process/result exit mismatch: ${processResult.exitCode} != ${exitCode}`)
  }
  const failedRunEvidence =
    allowFailedRunEvidence &&
    result.status === 'failed' &&
    exitCode !== 0 &&
    Array.isArray(result.trials) &&
    result.trials.length > 0
  if ((result.status !== 'succeeded' || exitCode !== 0) && !failedRunEvidence) {
    const error = typeof result.error === 'object' && result.error !== null ? (result.error as JsonRecord) : {}
    throw new HitchEvaluationError(
      `Hitch eval ${evalId} failed (${String(error.code ?? result.status)}): ${String(error.message ?? processResult.stderr).slice(-4000)}`,
      typeof error.code === 'string' ? error.code : 'hitch_eval_failed',
    )
  }
  if (result.dataset !== request.dataset)
    throw new HitchEvaluationError('Hitch result dataset does not match the request')
  const candidate = record(result.candidate, 'candidate')
  const revisionIdentity = string(candidate.revision_identity, 'candidate.revision_identity')
  const lockedHarnessRef = string(candidate.harness_ref, 'candidate.harness_ref')
  const match = lockedHarnessRef.match(/@commit:([0-9a-f]{40}|[0-9a-f]{64})$/u)
  if (match?.[1] === undefined) throw new HitchEvaluationError('Hitch candidate does not contain a locked commit')
  const actualCommit = match[1]
  if (lockedHarnessRef !== `${harnessId}@commit:${actualCommit}`) {
    throw new HitchEvaluationError(
      'Hitch candidate harness id does not match the configured adapter',
      'hitch_commit_mismatch',
    )
  }
  if (actualCommit !== request.harnessRef) {
    throw new HitchEvaluationError(
      `Hitch resolved ${actualCommit}, expected ${request.harnessRef}`,
      'hitch_commit_mismatch',
    )
  }
  const transport = parseTransport(result.local_source_transport)
  if (transport.commit !== request.harnessRef || transport.resolutionIdentity !== revisionIdentity) {
    throw new HitchEvaluationError(
      'Hitch local source transport identity does not match the locked candidate',
      'hitch_transport_mismatch',
    )
  }
  const summaryValue = record(result.summary, 'summary')
  if (Array.isArray(result.trials)) {
    const evidence = parseRunCenteredResult(
      result,
      summaryValue,
      evalId,
      request,
      actualCommit,
      revisionIdentity,
      identity,
      transport,
    )
    if ((result.status === 'succeeded') !== (evidence.completeness === 'complete')) {
      throw new HitchEvaluationError(
        'Hitch result status does not match run evidence completeness',
        'invalid_hitch_result',
      )
    }
    return evidence
  }
  const total = integer(summaryValue.n_trials, 'summary.n_trials')
  const completed = integer(summaryValue.n_completed, 'summary.n_completed')
  const errored = integer(summaryValue.n_errored, 'summary.n_errored')
  const cancelled = integer(summaryValue.n_cancelled, 'summary.n_cancelled')
  if (total <= 0 || completed !== total || errored !== 0 || cancelled !== 0) {
    throw new HitchEvaluationError(
      `Hitch eval has incomplete trials: total=${total}, completed=${completed}, errored=${errored}, cancelled=${cancelled}`,
      'hitch_infrastructure_failure',
    )
  }
  const primaryReward = finite(summaryValue.primary_reward, 'summary.primary_reward')
  const trials = parseTrials(summaryValue.trials)
  if (trials.length !== total) throw new HitchEvaluationError('Hitch trial count does not match summary.n_trials')
  const passed = trials.filter((trial) => (rewardForTrial(trial.rewards) ?? 0) > 0).length
  const processScores = trials.flatMap((trial) =>
    trial.scores?.processScore === undefined ? [] : [trial.scores.processScore],
  )
  const processScore =
    processScores.length === trials.length && processScores.length > 0
      ? processScores.reduce((sum, score) => sum + score, 0) / processScores.length
      : undefined
  const summary: ScoreSummary = {
    total,
    passed,
    failed: total - passed,
    score: primaryReward,
    metrics: { primaryReward, totalScore: primaryReward, ...(processScore === undefined ? {} : { processScore }) },
    ...(processScore === undefined ? {} : { process: { score: processScore } }),
  }
  return {
    provider: 'hitch-cli',
    conditionId: request.condition.conditionId,
    effectiveConfigDigest: identity.effectiveConfigDigest,
    evalId,
    dataset: request.dataset,
    requestedCommit: request.harnessRef,
    actualCommit,
    revisionIdentity,
    invocationFingerprint: identity.invocationFingerprint,
    completeness: 'complete',
    plannedTrialCount: total,
    primaryReward,
    ...(processScore === undefined ? {} : { processScore }),
    summary,
    trials,
    invalidTrials: [],
    originalResult: jsonValue(result, 'result'),
    localSourceTransport: transport,
  }
}

export function parseRunCenteredResult(
  result: JsonRecord,
  summaryValue: JsonRecord,
  evalId: string,
  request: Readonly<EvaluationRequest>,
  actualCommit: string,
  revisionIdentity: string,
  identity: HitchEvaluationIdentity,
  transport: LocalSourceTransportSummary,
): HitchEvaluationEvidence {
  const total = integer(summaryValue.n_trials, 'summary.n_trials')
  const completed = integer(summaryValue.n_completed, 'summary.n_completed')
  const invalid = integer(summaryValue.n_invalid, 'summary.n_invalid')
  const parsed = parseRunTrials(result.trials)
  if (total <= 0 || parsed.length !== total)
    throw new HitchEvaluationError('Hitch trial count does not match summary.n_trials')
  const valid = parsed.filter((trial) => trial.observationStatus === 'valid')
  const invalidObservations = parsed.filter((trial) => trial.observationStatus === 'invalid')
  if (completed !== valid.length || invalid !== invalidObservations.length || completed + invalid !== total) {
    throw new HitchEvaluationError(
      `Hitch observation counts are inconsistent: total=${total}, completed=${completed}, invalid=${invalid}`,
      'invalid_hitch_result',
    )
  }
  const trials: HitchTrialSummary[] = valid.map((trial) => ({
    originalResult: trial.originalResult,
    taskName: trial.taskName,
    trialName: trial.trialName,
    runId: trial.runId,
    attempt: trial.attempt,
    status: 'completed',
    rewards: {
      reward: trial.reward!,
      total_score: trial.scores?.totalScore ?? trial.reward!,
      ...(trial.scores?.processScore === undefined ? {} : { process_score: trial.scores.processScore }),
    },
    scores: trial.scores ?? { totalScore: trial.reward!, normalization: 'legacy-reward' },
  }))
  const invalidTrials: InvalidEvaluationTrialSummary[] = invalidObservations.map((trial) => ({
    originalResult: trial.originalResult,
    taskName: trial.taskName,
    trialName: trial.trialName,
    runId: trial.runId,
    attempt: trial.attempt,
    status: 'errored',
    invalidReason: trial.invalidReason!,
  }))
  const primaryReward =
    trials.length === 0 ? 0 : trials.reduce((sum, trial) => sum + trial.scores!.totalScore, 0) / trials.length
  if (trials.length > 0) {
    const reportedPrimaryReward = finite(summaryValue.primary_reward, 'summary.primary_reward')
    if (Math.abs(reportedPrimaryReward - primaryReward) > 1e-12) {
      throw new HitchEvaluationError(
        'Hitch primary reward does not match valid run observations',
        'invalid_hitch_result',
      )
    }
  }
  const passed = trials.filter((trial) => (rewardForTrial(trial.rewards) ?? 0) > 0).length
  const processScores = trials.flatMap((trial) =>
    trial.scores?.processScore === undefined ? [] : [trial.scores.processScore],
  )
  const processScore =
    processScores.length === trials.length && processScores.length > 0
      ? processScores.reduce((sum, score) => sum + score, 0) / processScores.length
      : undefined
  const summary: ScoreSummary = {
    total: trials.length,
    passed,
    failed: trials.length - passed,
    score: primaryReward,
    metrics: { primaryReward, totalScore: primaryReward, ...(processScore === undefined ? {} : { processScore }) },
    ...(processScore === undefined ? {} : { process: { score: processScore } }),
  }
  return {
    provider: 'hitch-cli',
    conditionId: request.condition.conditionId,
    effectiveConfigDigest: identity.effectiveConfigDigest,
    evalId,
    dataset: request.dataset,
    requestedCommit: request.harnessRef,
    actualCommit,
    revisionIdentity,
    invocationFingerprint: identity.invocationFingerprint,
    completeness: invalidTrials.length === 0 ? 'complete' : 'partial',
    plannedTrialCount: total,
    primaryReward,
    ...(processScore === undefined ? {} : { processScore }),
    summary,
    trials,
    invalidTrials,
    originalResult: jsonValue(result, 'result'),
    localSourceTransport: transport,
  }
}

export function parseRunTrials(value: unknown): ParsedRunTrial[] {
  if (!Array.isArray(value)) throw new HitchEvaluationError('trials must be an array', 'invalid_hitch_result')
  return value.map((item, index) => {
    const trial = record(item, `trials[${index}]`)
    const runId = string(trial.run_id, `trials[${index}].run_id`)
    if (!/^run_[0-9a-f]{32}$/u.test(runId))
      throw new HitchEvaluationError(`trials[${index}].run_id is invalid`, 'invalid_hitch_result')
    const observation = string(trial.observation_status, `trials[${index}].observation_status`)
    if (observation !== 'valid' && observation !== 'invalid') {
      throw new HitchEvaluationError(`trials[${index}].observation_status is invalid`, 'invalid_hitch_result')
    }
    const reward = observation === 'valid' ? finite(trial.reward, `trials[${index}].reward`) : undefined
    const scores =
      observation === 'valid'
        ? trial.scores === undefined
          ? { totalScore: reward!, normalization: 'legacy-reward' as const }
          : evaluationTrialScores(trial.scores, `trials[${index}].scores`)
        : undefined
    if (scores !== undefined && scores.totalScore !== reward) {
      throw new HitchEvaluationError(
        `trials[${index}].scores.total_score does not match reward`,
        'invalid_hitch_result',
      )
    }
    const invalidReason =
      observation === 'invalid' ? string(trial.invalid_reason, `trials[${index}].invalid_reason`) : undefined
    const attempt = integer(trial.attempt, `trials[${index}].attempt`)
    if (attempt <= 0)
      throw new HitchEvaluationError(`trials[${index}].attempt must be positive`, 'invalid_hitch_result')
    return {
      taskName: string(trial.task_id, `trials[${index}].task_id`),
      originalResult: jsonValue(trial, `trials[${index}]`),
      trialName: string(trial.trial_id, `trials[${index}].trial_id`),
      runId,
      attempt,
      observationStatus: observation,
      ...(reward === undefined ? {} : { reward }),
      ...(scores === undefined ? {} : { scores }),
      ...(invalidReason === undefined ? {} : { invalidReason }),
    }
  })
}

export function parseTrials(value: unknown): HitchTrialSummary[] {
  if (!Array.isArray(value)) throw new HitchEvaluationError('summary.trials must be an array', 'invalid_hitch_result')
  return value.map((item, index) => {
    const trial = record(item, `summary.trials[${index}]`)
    const status = trial.status
    if (status !== 'completed') {
      throw new HitchEvaluationError(`summary.trials[${index}].status is invalid`, 'invalid_hitch_result')
    }
    const rewardsValue = record(trial.rewards, `summary.trials[${index}].rewards`)
    const rewards: Record<string, number> = {}
    for (const [name, reward] of Object.entries(rewardsValue)) rewards[name] = finite(reward, `trial reward ${name}`)
    const taskName = string(trial.task_name, `summary.trials[${index}].task_name`)
    const trialName = typeof trial.trial_name === 'string' && trial.trial_name.length > 0 ? trial.trial_name : undefined
    const totalScore = rewards.total_score ?? rewardForTrial(rewards)
    if (totalScore === undefined || (rewards.reward !== undefined && Math.abs(rewards.reward - totalScore) > 1e-12)) {
      throw new HitchEvaluationError(`summary.trials[${index}] total score is invalid`, 'invalid_hitch_result')
    }
    const scores: EvaluationTrialScores = {
      totalScore,
      ...(rewards.process_score === undefined ? {} : { processScore: rewards.process_score }),
      normalization: rewards.total_score === undefined ? 'legacy-reward' : 'standard',
    }
    return {
      taskName,
      ...(trialName === undefined ? {} : { trialName }),
      status: 'completed',
      rewards,
      scores,
      originalResult: jsonValue(trial, `summary.trials[${index}]`),
    }
  })
}

export function parseTransport(value: unknown): LocalSourceTransportSummary {
  const transport = record(value, 'local_source_transport')
  if (transport.kind !== 'local-git-commit') {
    throw new HitchEvaluationError(
      'Hitch result is missing local exact commit transport evidence',
      'missing_hitch_transport',
    )
  }
  const commit = string(transport.commit, 'local_source_transport.commit')
  const tree = string(transport.tree, 'local_source_transport.tree')
  if (!isExactGitCommit(commit) || !isExactGitCommit(tree)) {
    throw new HitchEvaluationError('Hitch transport commit/tree is not an exact Git OID', 'invalid_hitch_result')
  }
  const payloadSha256 = string(transport.payload_sha256, 'local_source_transport.payload_sha256')
  if (!/^sha256:[0-9a-f]{64}$/u.test(payloadSha256)) {
    throw new HitchEvaluationError('Hitch transport payload digest is invalid', 'invalid_hitch_result')
  }
  return {
    kind: 'local-git-commit',
    resolutionIdentity: string(transport.resolution_identity, 'local_source_transport.resolution_identity'),
    commit,
    tree,
    payloadSha256,
    payloadBytes: integer(transport.payload_bytes, 'local_source_transport.payload_bytes'),
  }
}
