import type { CandidateAssessment, ChampionState, ComponentKind, ComponentRef, EvaluationEvidence, MetaSessionState,
  PairedTrial, PairingAudit, PopulationMember, PopulationState, RefinementRound, RoundEvaluationAttempt, EvaluationSubmissionIntent } from '../types.js'
import { isExactGitCommit } from '../types.js'
import { digestJson } from '../state/digest.js'
import { validMetricSet, validMetaPrerequisiteFailure, trialKey, trialReward, expectedPairedTrials, pairedScoreDelta, pairedProcessScoreDelta, requiredRegressionCount, validComponentRef } from './state-contract.js'
import { searchProjectionAggregates } from '../search/legacy.js'
/** Historical JSON validation only. No file access or state mutation. */
export class LegacyEvidenceValidator {
  constructor(readonly evolutionId?: string) {}
  validateChampion(value: unknown): ChampionState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('champion state must be an object')
    const champion = value as Partial<ChampionState>
    if (champion.schemaVersion !== 2) throw new TypeError('unsupported champion state schema; migrate the old sha256 artifact state')
    if (typeof champion.ref !== 'string' || !isExactGitCommit(champion.ref)) throw new TypeError('champion ref must be an exact Git commit')
    if (typeof champion.manifestDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(champion.manifestDigest)) {
      throw new TypeError('champion manifestDigest must be a sha256 digest')
    }
    if (typeof champion.updatedAt !== 'string' || champion.updatedAt.length === 0) throw new TypeError('champion updatedAt is required')
    if (champion.roundId !== undefined && typeof champion.roundId !== 'string') throw new TypeError('champion roundId must be a string')
    return champion as ChampionState
  }

  validateMeta(value: unknown): MetaSessionState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('meta state must be an object')
    const meta = value as Partial<MetaSessionState>
    if (typeof meta.evolutionId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(meta.evolutionId)
      || (this.evolutionId !== undefined && meta.evolutionId !== this.evolutionId)
      || typeof meta.sessionId !== 'string' || meta.sessionId.length === 0
      || typeof meta.metaHarnessRef !== 'string' || meta.metaHarnessRef.length === 0
      || typeof meta.specDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(meta.specDigest)) {
      throw new TypeError('meta state requires matching evolutionId, sessionId, metaHarnessRef, and specDigest')
    }
    if (meta.checkpoint !== undefined
      && (typeof meta.checkpoint.sourceSessionId !== 'string' || meta.checkpoint.sourceSessionId !== meta.sessionId
        || !Number.isSafeInteger(meta.checkpoint.eventCount) || meta.checkpoint.eventCount < 0
        || !/^sha256:[0-9a-f]{64}$/u.test(meta.checkpoint.prefixDigest))) {
      throw new TypeError('meta checkpoint identity is invalid')
    }
    return meta as MetaSessionState
  }

  validatePopulation(value: unknown): PopulationState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('population state must be an object')
    const population = value as Partial<PopulationState>
    if (typeof population.evolutionId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(population.evolutionId)
      || (this.evolutionId !== undefined && population.evolutionId !== this.evolutionId)
      || !Number.isSafeInteger(population.generation) || (population.generation as number) < 0
      || !Array.isArray(population.members) || population.members.length === 0
      || typeof population.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(population.digest)) {
      throw new TypeError('population identity is invalid')
    }
    for (const member of population.members) this.validatePopulationMember(member)
    const identity = { evolutionId: population.evolutionId, generation: population.generation, members: population.members }
    if (digestJson(identity) !== population.digest) throw new TypeError('population digest mismatch')
    return population as PopulationState
  }

  validatePopulationMember(value: unknown): PopulationMember {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('population member is invalid')
    const member = value as Partial<PopulationMember>
    if (typeof member.candidateId !== 'string' || member.candidateId.length === 0
      || typeof member.harnessRef !== 'string' || !isExactGitCommit(member.harnessRef)
      || typeof member.harnessDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(member.harnessDigest)
      || !Array.isArray(member.parentCandidateIds)
      || member.parentCandidateIds.some(id => typeof id !== 'string' || id.length === 0)
      || typeof member.lineageRootId !== 'string' || member.lineageRootId.length === 0
      || !validMetricSet(member.metrics)
      || typeof member.selectedAt !== 'string' || member.selectedAt.length === 0
      || member.metaSessionId !== undefined && (typeof member.metaSessionId !== 'string' || member.metaSessionId.length === 0)) {
      throw new TypeError('population member is invalid')
    }
    if (member.metaCheckpoint !== undefined
      && (typeof member.metaCheckpoint !== 'object' || member.metaCheckpoint === null
        || member.metaCheckpoint.sourceSessionId !== member.metaSessionId || member.metaSessionId === undefined
        || !Number.isSafeInteger(member.metaCheckpoint.eventCount) || member.metaCheckpoint.eventCount < 0
        || !/^sha256:[0-9a-f]{64}$/u.test(member.metaCheckpoint.prefixDigest))) {
      throw new TypeError('population member Meta checkpoint is invalid')
    }
    return member as PopulationMember
  }

  validateEvaluationAttempt(
    round: RefinementRound,
    attempt: RoundEvaluationAttempt,
    identities: Set<string>,
  ): void {
    if (typeof attempt !== 'object' || attempt === null || Array.isArray(attempt)
      || typeof attempt.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(attempt.provider)
      || typeof attempt.evalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(attempt.evalId)
      || (attempt.provider === 'hitch-cli' && !/^eval_[0-9a-f]{32}$/u.test(attempt.evalId))) {
      throw new TypeError('round evaluation attempt identity is invalid')
    }
    if (attempt.submissionIntent !== undefined) {
      this.validateSubmissionIntent(attempt.submissionIntent)
      if (attempt.submissionIntent.provider !== attempt.provider) throw new TypeError('evaluation submission provider differs from attempt')
    }
    const identity = `${attempt.provider}\0${attempt.evalId}`
    if (identities.has(identity)) throw new TypeError('round evaluation attempt identity is duplicated')
    identities.add(identity)
    if (!['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'].includes(attempt.phase)
      || !['running', 'rerunning', 'repair-completed', 'settled', 'failed', 'cancelled'].includes(attempt.status)
      || typeof attempt.startedAt !== 'string' || attempt.startedAt.length === 0
      || typeof attempt.owner !== 'object' || attempt.owner === null
      || typeof attempt.owner.candidateId !== 'string' || attempt.owner.candidateId.length === 0
      || (attempt.owner.role !== 'baseline' && attempt.owner.role !== 'candidate')
      || !isExactGitCommit(attempt.owner.harnessRef)
      || attempt.requestedCommit !== attempt.owner.harnessRef) {
      throw new TypeError('round evaluation attempt lifecycle/owner is invalid')
    }
    const terminal = attempt.status !== 'running' && attempt.status !== 'rerunning'
    if (terminal !== (typeof attempt.completedAt === 'string' && attempt.completedAt.length > 0)
      || ((attempt.status === 'running' || attempt.status === 'rerunning') && attempt.failure !== undefined)
      || ((attempt.status === 'failed' || attempt.status === 'cancelled')
        && (typeof attempt.failure?.code !== 'string' || attempt.failure.code.length === 0
          || typeof attempt.failure.message !== 'string' || attempt.failure.message.length === 0))
      || ((attempt.status === 'settled' || attempt.status === 'repair-completed') && attempt.failure !== undefined)
      || (attempt.reusedFromRoundId !== undefined
        && (typeof attempt.reusedFromRoundId !== 'string' || attempt.reusedFromRoundId.length === 0
          || (attempt.reusedFromEvolutionId === undefined && attempt.reusedFromRoundId === round.roundId)
          || !attempt.phase.endsWith('baseline')
          || attempt.status !== 'settled'))
      || (attempt.reusedFromEvolutionId !== undefined
        && (typeof attempt.reusedFromEvolutionId !== 'string'
          || !/^[a-zA-Z0-9_-]+$/u.test(attempt.reusedFromEvolutionId)
          || attempt.reusedFromEvolutionId === round.evolutionId
          || attempt.reusedFromRoundId === undefined))
      || (attempt.reuseAudit !== undefined
        && (attempt.reusedFromRoundId === undefined
          || typeof attempt.reuseAudit !== 'object' || attempt.reuseAudit === null
          || typeof attempt.reuseAudit.sourceInvocationFingerprint !== 'string'
          || attempt.reuseAudit.sourceInvocationFingerprint.length === 0
          || typeof attempt.reuseAudit.currentInvocationFingerprint !== 'string'
          || attempt.reuseAudit.currentInvocationFingerprint.length === 0
          || typeof attempt.reuseAudit.invocationFingerprintChanged !== 'boolean'
          || attempt.reuseAudit.invocationFingerprintChanged
            !== (attempt.reuseAudit.sourceInvocationFingerprint !== attempt.reuseAudit.currentInvocationFingerprint)))) {
      throw new TypeError('round evaluation attempt terminal state is invalid')
    }
    const condition = attempt.phase.startsWith('seed-') ? round.plan.seed : round.plan.heldOut
    const expectedDataset = attempt.phase.startsWith('seed-') ? round.seedTaskRef : round.heldOutRef
    if (attempt.conditionId !== condition.conditionId || attempt.dataset !== expectedDataset
      || attempt.requestedModelId !== condition.model) {
      throw new TypeError('round evaluation attempt condition is invalid')
    }
    if (attempt.owner.role === 'candidate') {
      const candidate = round.candidatePool.find(value => value.candidateId === attempt.owner.candidateId)
      if (!attempt.phase.endsWith('candidate') || candidate?.sealedVersion?.commitOid !== attempt.owner.harnessRef) {
        throw new TypeError('round candidate evaluation attempt owner is invalid')
      }
      return
    }
    const allocation = round.parentAllocations?.find(value => value.parentCandidateId === attempt.owner.candidateId
      && value.parentHarnessRef === attempt.owner.harnessRef)
    const deterministicChampion = attempt.owner.harnessRef === round.targetHarnessRef
      && attempt.owner.candidateId === `champion-${round.targetHarnessRef}`
    if (!attempt.phase.endsWith('baseline') || (allocation === undefined && !deterministicChampion)) {
      throw new TypeError('round baseline evaluation attempt owner is invalid')
    }
  }

  validateSubmissionIntent(intent: EvaluationSubmissionIntent): void {
    if (typeof intent !== 'object' || intent === null
      || typeof intent.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(intent.provider)
      || typeof intent.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(intent.idempotencyKey)
      || intent.parameters === undefined) {
      throw new TypeError('evaluation submission intent is invalid')
    }
  }

  validateCandidateAssessment(value: CandidateAssessment, candidateIds: string[]): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || value.component.kind !== 'candidate-assessor'
      || !validComponentRef(value.component, 'candidate-assessor')
      || typeof value.reason !== 'string' || value.reason.length === 0
      || typeof value.candidateMetrics !== 'object' || value.candidateMetrics === null
      || Array.isArray(value.candidateMetrics)) {
      throw new TypeError('round candidate assessment is invalid')
    }
    const expected = [...candidateIds].sort()
    const actual = Object.keys(value.candidateMetrics).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)
      || Object.values(value.candidateMetrics).some(metrics => !validMetricSet(metrics))) {
      throw new TypeError('round candidate assessment metrics are invalid')
    }
    if (value.rankingCandidateIds !== undefined
      && JSON.stringify([...value.rankingCandidateIds].sort()) !== JSON.stringify(expected)) {
      throw new TypeError('round candidate assessment ranking is invalid')
    }
    if (value.usage !== undefined) {
      const usage = [value.usage.modelRequests, value.usage.inputTokens, value.usage.outputTokens,
        value.usage.cachedInputTokens, value.usage.reasoningTokens]
      if (usage.some(item => item !== undefined && (!Number.isSafeInteger(item) || item < 0))) {
        throw new TypeError('round candidate assessment usage is invalid')
      }
    }
    const { digest, ...identity } = value
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest) || digestJson(identity) !== digest) {
      throw new TypeError('round candidate assessment digest mismatch')
    }
  }

  validateEvaluationEvidence(value: EvaluationEvidence, label: string, searchMode = false): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
    if (typeof value.provider !== 'string' || value.provider.length === 0
      || !/^sha256:[0-9a-f]{64}$/u.test(value.conditionId)
      || !/^sha256:[0-9a-f]{64}$/u.test(value.effectiveConfigDigest)
      || typeof value.evalId !== 'string' || value.evalId.length === 0) throw new TypeError(`${label} identity is invalid`)
    if (typeof value.dataset !== 'string' || value.dataset.length === 0) throw new TypeError(`${label} dataset is invalid`)
    if (!isExactGitCommit(value.requestedCommit) || !isExactGitCommit(value.actualCommit)) throw new TypeError(`${label} commit is invalid`)
    if (typeof value.revisionIdentity !== 'string' || value.revisionIdentity.length === 0
      || (value.invocationFingerprint !== undefined
        && (typeof value.invocationFingerprint !== 'string' || value.invocationFingerprint.length === 0))
      || (value.benchmark !== undefined && (
        typeof value.benchmark !== 'object' || value.benchmark === null
        || typeof value.benchmark.id !== 'string' || value.benchmark.id.length === 0
        || typeof value.benchmark.revision !== 'string' || value.benchmark.revision.length === 0
      ))
      || !Number.isFinite(value.primaryReward)
      || (value.processScore !== undefined && !Number.isFinite(value.processScore))
      || (value.completeness !== 'complete' && value.completeness !== 'partial')
      || !Number.isSafeInteger(value.plannedTrialCount) || value.plannedTrialCount <= 0) {
      throw new TypeError(`${label} identity/reward is invalid`)
    }
    if (typeof value.summary !== 'object' || value.summary === null
      || !Number.isSafeInteger(value.summary.total) || !Number.isSafeInteger(value.summary.passed)
      || !Number.isSafeInteger(value.summary.failed) || !Number.isFinite(value.summary.score)
      || value.summary.total < 0 || value.summary.passed < 0 || value.summary.failed < 0
      || value.summary.passed + value.summary.failed !== value.summary.total) {
      throw new TypeError(`${label} score summary is invalid`)
    }
    if ((value.processScore === undefined) !== (value.summary.process === undefined)
      || value.processScore !== undefined && value.summary.process?.score !== value.processScore) {
      throw new TypeError(`${label} process score summary is invalid`)
    }
    const scopedProjection = searchMode && value.provider === 'search-v2-seed-projection'
    if (!Array.isArray(value.trials) || (!scopedProjection && value.trials.length !== value.summary.total)
      || value.trials.some(trial => typeof trial.taskName !== 'string' || trial.taskName.length === 0
      || trial.status !== 'completed'
      || (trial.runId !== undefined && (typeof trial.runId !== 'string' || trial.runId.length === 0))
      || (trial.attempt !== undefined && (!Number.isSafeInteger(trial.attempt) || trial.attempt <= 0))
      || typeof trial.rewards !== 'object' || trial.rewards === null
      || Object.values(trial.rewards).some(reward => !Number.isFinite(reward))
      || (trial.scores !== undefined && (
        !Number.isFinite(trial.scores.totalScore)
        || (trial.scores.processScore !== undefined && !Number.isFinite(trial.scores.processScore))
        || (trial.scores.normalization !== 'standard' && trial.scores.normalization !== 'legacy-reward')
        || (trial.scores.normalization === 'legacy-reward' && trial.scores.processScore !== undefined)
        || trial.scores.totalScore !== (trial.rewards.total_score ?? trial.rewards.reward ?? Object.values(trial.rewards)[0])
      )))) {
      throw new TypeError(`${label} trials are invalid`)
    }
    const scoped = scopedProjection ? searchProjectionAggregates(value) : undefined
    if (scoped && (value.summary.total !== scoped.taskCount || Math.abs(value.primaryReward - scoped.outcome) > 1e-12 || Math.abs(value.summary.score - scoped.outcome) > 1e-12)) throw new TypeError(`${label} search task aggregate is invalid`)
    const processScores = value.trials.flatMap(trial => trial.scores?.processScore === undefined ? [] : [trial.scores.processScore])
    const expectedProcess = scopedProjection ? scoped?.process : processScores.length === value.trials.length && processScores.length > 0
      ? processScores.reduce((sum, score) => sum + score, 0) / processScores.length
      : undefined
    if ((value.processScore === undefined) !== (expectedProcess === undefined)
      || value.processScore !== undefined && Math.abs(value.processScore - expectedProcess!) > 1e-12) {
      throw new TypeError(`${label} process score does not match trials`)
    }
    if (!Array.isArray(value.invalidTrials)
      || value.plannedTrialCount !== value.trials.length + value.invalidTrials.length
      || (value.completeness === 'complete' ? value.invalidTrials.length !== 0 : value.invalidTrials.length === 0)
      || value.invalidTrials.some(trial => typeof trial.taskName !== 'string' || trial.taskName.length === 0
        || typeof trial.trialName !== 'string' || trial.trialName.length === 0
        || typeof trial.runId !== 'string' || trial.runId.length === 0
        || !Number.isSafeInteger(trial.attempt) || trial.attempt <= 0
        || trial.status !== 'errored'
        || typeof trial.invalidReason !== 'string' || trial.invalidReason.length === 0)) {
      throw new TypeError(`${label} invalid trials are invalid`)
    }
    const plannedKeys = [...value.trials, ...value.invalidTrials]
      .map(trial => JSON.stringify([trial.taskName, trial.attempt ?? null]))
    const runIds = [...value.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
      ...value.invalidTrials.map(trial => trial.runId)]
    if (new Set(plannedKeys).size !== plannedKeys.length || new Set(runIds).size !== runIds.length) {
      throw new TypeError(`${label} trial identities are ambiguous`)
    }
    const transport = value.localSourceTransport
    if (transport !== undefined) {
      if (typeof transport !== 'object' || transport === null || transport.kind !== 'local-git-commit'
        || transport.commit !== value.actualCommit || !isExactGitCommit(transport.tree)
        || transport.resolutionIdentity !== value.revisionIdentity
        || !/^sha256:[0-9a-f]{64}$/u.test(transport.payloadSha256)
        || !Number.isSafeInteger(transport.payloadBytes) || transport.payloadBytes < 0) {
        throw new TypeError(`${label} local exact commit transport evidence is invalid`)
      }
    }
  }

  validateFailedEvaluation(
    value: NonNullable<RefinementRound['failedEvaluations']>[number],
    round: RefinementRound,
  ): void {
    const phases = new Set(['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'])
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !phases.has(value.phase)
      || typeof value.owner !== 'object' || value.owner === null
      || typeof value.owner.candidateId !== 'string' || value.owner.candidateId.length === 0
      || !isExactGitCommit(value.owner.harnessRef)
      || (value.owner.role !== 'baseline' && value.owner.role !== 'candidate')
      || (value.phase.endsWith('baseline') ? value.owner.role !== 'baseline' : value.owner.role !== 'candidate')
      || typeof value.failure !== 'object' || value.failure === null
      || typeof value.failure.code !== 'string' || value.failure.code.length === 0
      || typeof value.failure.message !== 'string' || value.failure.message.length === 0) {
      throw new TypeError('round failed evaluation record is invalid')
    }
    const evidence = value.evidence
    if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)
      || typeof evidence.provider !== 'string' || evidence.provider.length === 0
      || !/^sha256:[0-9a-f]{64}$/u.test(evidence.conditionId)
      || !/^sha256:[0-9a-f]{64}$/u.test(evidence.effectiveConfigDigest)
      || typeof evidence.evalId !== 'string' || evidence.evalId.length === 0
      || typeof evidence.dataset !== 'string' || evidence.dataset.length === 0
      || !isExactGitCommit(evidence.requestedCommit) || !isExactGitCommit(evidence.actualCommit)
      || typeof evidence.revisionIdentity !== 'string' || evidence.revisionIdentity.length === 0
      || (evidence.invocationFingerprint !== undefined
        && (typeof evidence.invocationFingerprint !== 'string' || evidence.invocationFingerprint.length === 0))
      || evidence.runSetComplete !== true
      || !Array.isArray(evidence.trials) || evidence.trials.length === 0) {
      throw new TypeError('round failed evaluation evidence is invalid')
    }
    const runIds = evidence.trials.map(trial => trial.runId)
    if (new Set(runIds).size !== runIds.length || evidence.trials.some(trial => (
      typeof trial.taskName !== 'string' || trial.taskName.length === 0
      || typeof trial.trialName !== 'string' || trial.trialName.length === 0
      || typeof trial.runId !== 'string' || trial.runId.length === 0
      || !Number.isSafeInteger(trial.attempt) || trial.attempt <= 0
      || (trial.status !== 'completed' && trial.status !== 'errored')
      || (trial.status === 'errored'
        && (typeof trial.invalidReason !== 'string' || trial.invalidReason.length === 0))
      || (trial.invalidReason !== undefined && (typeof trial.invalidReason !== 'string' || trial.invalidReason.length === 0))
    ))) {
      throw new TypeError('round failed evaluation trials are invalid')
    }
    const partition = value.phase.startsWith('seed-') ? round.plan.seed : round.plan.heldOut
    if (evidence.conditionId !== partition.conditionId || evidence.dataset !== partition.dataset.ref
      || evidence.requestedCommit !== value.owner.harnessRef || evidence.actualCommit !== value.owner.harnessRef) {
      throw new TypeError('round failed evaluation does not match its owner or partition')
    }
    if (value.owner.role === 'candidate') {
      const candidate = round.candidatePool.find(item => item.candidateId === value.owner.candidateId)
      if (candidate?.sealedVersion?.commitOid !== value.owner.harnessRef) {
        throw new TypeError('round failed candidate evaluation owner is invalid')
      }
    } else {
      const parentHarnesses = new Set([
        round.targetHarnessRef,
        ...(round.parentAllocations ?? []).map(allocation => allocation.parentHarnessRef),
      ])
      if (!parentHarnesses.has(value.owner.harnessRef)) throw new TypeError('round failed baseline evaluation owner is invalid')
    }
    const transport = evidence.localSourceTransport
    if (transport !== undefined && (typeof transport !== 'object' || transport === null
      || transport.kind !== 'local-git-commit' || transport.commit !== evidence.actualCommit
      || !isExactGitCommit(transport.tree) || transport.resolutionIdentity !== evidence.revisionIdentity
      || !/^sha256:[0-9a-f]{64}$/u.test(transport.payloadSha256)
      || !Number.isSafeInteger(transport.payloadBytes) || transport.payloadBytes < 0)) {
      throw new TypeError('round failed evaluation transport is invalid')
    }
  }

  validatePairedTrials(value: PairedTrial[], conditionId: string, expectedCount: number, label: string): void {
    if (!Array.isArray(value) || value.length !== expectedCount
      || new Set(value.map(trial => trial.trialKey)).size !== value.length
      || value.some(trial => trial.conditionId !== conditionId || trial.trialKey.length === 0 || trial.taskName.length === 0
        || !Number.isFinite(trial.baselineReward) || !Number.isFinite(trial.candidateReward)
        || !Number.isFinite(trial.rewardDelta)
        || trial.rewardDelta !== trial.candidateReward - trial.baselineReward
        || (trial.baselineProcessScore !== undefined && !Number.isFinite(trial.baselineProcessScore))
        || (trial.candidateProcessScore !== undefined && !Number.isFinite(trial.candidateProcessScore))
        || (trial.processScoreDelta !== undefined && !Number.isFinite(trial.processScoreDelta))
        || (trial.processScoreDelta === undefined) !== (trial.baselineProcessScore === undefined || trial.candidateProcessScore === undefined)
        || trial.processScoreDelta !== undefined
          && trial.processScoreDelta !== trial.candidateProcessScore! - trial.baselineProcessScore!)) {
      throw new TypeError(`round ${label} paired trials are invalid`)
    }
  }

  validatePairingAudit(
    value: PairingAudit,
    baseline: EvaluationEvidence,
    candidate: EvaluationEvidence,
    pairs: readonly PairedTrial[],
    label: string,
  ): void {
    const baselinePlanned = [...baseline.trials, ...baseline.invalidTrials].map(trialKey).sort()
    const candidatePlanned = [...candidate.trials, ...candidate.invalidTrials].map(trialKey).sort()
    const expectedPairs = expectedPairedTrials(baseline, candidate)
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !Number.isSafeInteger(value.planned) || value.planned <= 0
      || !Number.isSafeInteger(value.paired) || value.paired < 0
      || !Number.isSafeInteger(value.excluded) || value.excluded < 0
      || !Number.isSafeInteger(value.baselineInvalid) || value.baselineInvalid < 0
      || !Number.isSafeInteger(value.candidateInvalid) || value.candidateInvalid < 0
      || value.planned !== baseline.plannedTrialCount || value.planned !== candidate.plannedTrialCount
      || value.paired !== pairs.length || value.excluded !== value.planned - value.paired
      || value.baselineInvalid !== baseline.invalidTrials.length
      || value.candidateInvalid !== candidate.invalidTrials.length
      || baseline.conditionId !== candidate.conditionId
      || baseline.provider !== candidate.provider
      || baseline.effectiveConfigDigest !== candidate.effectiveConfigDigest
      || baseline.benchmark?.id !== candidate.benchmark?.id
      || baseline.benchmark?.revision !== candidate.benchmark?.revision
      || baseline.dataset !== candidate.dataset
      || JSON.stringify(baselinePlanned) !== JSON.stringify(candidatePlanned)
      || digestJson(pairs) !== digestJson(expectedPairs)) {
      throw new TypeError(`round ${label} pairing audit is invalid`)
    }
  }}
