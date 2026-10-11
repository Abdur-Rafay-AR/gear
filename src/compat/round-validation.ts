import type { CandidateAssessment, ChampionState, ComponentKind, ComponentRef, EvaluationEvidence, MetaSessionState,
  PairedTrial, PairingAudit, PopulationMember, PopulationState, RefinementRound, RoundEvaluationAttempt, EvaluationSubmissionIntent } from '../types.js'
import { isExactGitCommit } from '../types.js'
import { digestJson } from '../state/digest.js'
import { validMetricSet, validMetaPrerequisiteFailure, trialKey, trialReward, expectedPairedTrials, pairedScoreDelta, pairedProcessScoreDelta, requiredRegressionCount, validComponentRef } from './state-contract.js'
import { validateSearchSchema } from '../search/schema.js'
import { validateBaselineSourceSnapshot } from '../refine/baseline-source.js'
import { LegacyEvidenceValidator } from './evidence-validation.js'

/** Preserved legacy round schema, deliberately unchanged during storage extraction.
 * This long validator covers the historical journal as one transaction; split its
 * schema only with frozen fixture equivalence, never by silently dropping checks.
 */
export class LegacyRoundValidator extends LegacyEvidenceValidator {
  validateRound(value: unknown): RefinementRound {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('refinement round must be an object')
    const round = value as Partial<RefinementRound>
    if (typeof round.evolutionId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(round.evolutionId)
      || (this.evolutionId !== undefined && round.evolutionId !== this.evolutionId)) {
      throw new TypeError('round evolutionId is invalid or does not match its store')
    }
    if (typeof round.roundId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(round.roundId)) throw new TypeError('roundId is invalid')
    const statuses = new Set([
      'queued', 'baseline-running', 'preparing-candidate', 'candidate-editing', 'building-candidate', 'candidate-seed-running',
      'selection-running', 'held-out-running', 'repairing-evaluation', 'promoting', 'accepted', 'rejected',
      'rejected-for-substrate', 'failed',
    ])
    if (typeof round.status !== 'string' || !statuses.has(round.status)) throw new TypeError('round status is invalid')
    if (round.baselineReuseBlocker !== undefined) {
      const blocker = round.baselineReuseBlocker
      if (typeof blocker !== 'object' || blocker === null
        || !['BASELINE_IDENTITY_UNRESOLVED', 'BASELINE_CONDITION_MISMATCH', 'BASELINE_EVIDENCE_UNAVAILABLE'].includes(blocker.code)
        || typeof blocker.reason !== 'string' || blocker.reason.length === 0
        || typeof blocker.requiredAction !== 'string' || blocker.requiredAction.length === 0
        || round.status !== 'failed') {
        throw new TypeError('round baselineReuseBlocker is invalid')
      }
    }
    if (round.source !== 'command' && round.source !== 'target' && round.source !== 'api' && round.source !== 'skill') {
      throw new TypeError('round source is invalid')
    }
    for (const [name, field] of Object.entries({
      workspaceRoot: round.workspaceRoot,
      createdAt: round.createdAt,
      updatedAt: round.updatedAt,
      metaHarnessRef: round.metaHarnessRef,
      sandboxProfileRef: round.sandboxProfileRef,
      seedTaskRef: round.seedTaskRef,
      heldOutRef: round.heldOutRef,
      batchId: round.batchId,
    })) {
      if (typeof field !== 'string' || field.length === 0) throw new TypeError(`round ${name} is required`)
    }
    if (!Number.isSafeInteger(round.taskBudgetMs) || (round.taskBudgetMs as number) <= 0) throw new TypeError('round taskBudgetMs is invalid')
    if (!Number.isSafeInteger(round.roundIndex) || !Number.isSafeInteger(round.roundCount)
      || (round.roundIndex as number) < 1 || (round.roundCount as number) < (round.roundIndex as number)) {
      throw new TypeError('round batch index/count is invalid')
    }
    if (typeof round.targetHarnessRef !== 'string' || !isExactGitCommit(round.targetHarnessRef)) {
      throw new TypeError('round targetHarnessRef must be an exact Git commit')
    }
    if (typeof round.targetHarnessDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(round.targetHarnessDigest)) {
      throw new TypeError('round targetHarnessDigest must be a sha256 digest')
    }
    const promotionPolicy = round.promotionPolicy
    if (promotionPolicy === undefined
      || !Number.isFinite(promotionPolicy.minimumCandidateScore)
      || !Number.isFinite(promotionPolicy.minimumAbsoluteGain)
      || typeof promotionPolicy.requireNoRegression !== 'boolean'
      || !Number.isFinite(promotionPolicy.maxHeldOutRegression)
      || !Number.isSafeInteger(promotionPolicy.maxRequiredRegressions)
      || promotionPolicy.maxRequiredRegressions < 0
      || (promotionPolicy.requiredTaskIds !== undefined
        && (!Array.isArray(promotionPolicy.requiredTaskIds)
          || promotionPolicy.requiredTaskIds.some(task => typeof task !== 'string' || task.length === 0)
          || new Set(promotionPolicy.requiredTaskIds).size !== promotionPolicy.requiredTaskIds.length))) {
      throw new TypeError('round promotion policy is invalid')
    }
    if (round.plan === undefined || round.plan.planId.length === 0 || !/^sha256:[0-9a-f]{64}$/u.test(round.plan.digest)) {
      throw new TypeError('round resolved plan is invalid')
    }
    if (round.plan.taskSampler.kind !== 'task-sampler'
      || digestJson({ roundId: round.roundId, taskSampler: round.plan.taskSampler, seed: round.plan.seed, heldOut: round.plan.heldOut }) !== round.plan.digest) {
      throw new TypeError('round resolved plan digest mismatch')
    }
    for (const [label, condition] of [['seed', round.plan.seed], ['held-out', round.plan.heldOut]] as const) {
      if (!/^sha256:[0-9a-f]{64}$/u.test(condition.conditionId) || condition.partition !== label
        || condition.dataset.ref !== (label === 'seed' ? round.seedTaskRef : round.heldOutRef)
        || !/^sha256:[0-9a-f]{64}$/u.test(condition.dataset.digest)
        || !Number.isSafeInteger(condition.repetitions) || condition.repetitions <= 0
        || !Number.isSafeInteger(condition.timeoutMs) || condition.timeoutMs !== round.taskBudgetMs
        || typeof condition.model !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(condition.rolloutProviderDigest)) {
        throw new TypeError(`round ${label} evaluation condition is invalid`)
      }
      const conditionIdentity = {
        partition: condition.partition,
        dataset: condition.dataset,
        repetitions: condition.repetitions,
        ...(condition.seeds === undefined ? {} : { seeds: condition.seeds }),
        model: condition.model,
        sampling: condition.sampling,
        timeoutMs: condition.timeoutMs,
        rolloutProviderDigest: condition.rolloutProviderDigest,
      }
      if (digestJson(conditionIdentity) !== condition.conditionId) {
        throw new TypeError(`round ${label} evaluation condition digest mismatch`)
      }
    }
    if (round.baselineSource !== undefined) {
      const snapshot = validateBaselineSourceSnapshot(round.baselineSource)
      const seed = snapshot.partitions.seed
      const seedAttempt = round.evaluationAttempts?.find(attempt => (
        attempt.provider === seed.evidence.provider && attempt.evalId === seed.evidence.evalId
      ))
      const parentBaseline = round.parentBaselines?.find(parent => (
        parent.parentHarnessRef === round.targetHarnessRef
          && digestJson(parent.evidence) === seed.evidenceDigest
      ))
      if (snapshot.source.evolutionId === round.evolutionId
        || snapshot.target.harnessRef !== round.targetHarnessRef
        || snapshot.target.manifestDigest !== round.targetHarnessDigest
        || digestJson(seed.condition) !== digestJson(round.plan.seed)
        || round.baseline === undefined || digestJson(round.baseline) !== seed.evidenceDigest
        || parentBaseline === undefined
        || seedAttempt?.status !== 'settled' || seedAttempt.phase !== 'seed-baseline'
        || seedAttempt.owner.role !== 'baseline' || seedAttempt.owner.harnessRef !== round.targetHarnessRef
        || seedAttempt.reusedFromEvolutionId !== snapshot.source.evolutionId
        || seedAttempt.reusedFromRoundId !== snapshot.source.roundId) {
        throw new TypeError('round baseline source snapshot is not durably imported')
      }
      const heldOut = snapshot.partitions.heldOut
      if (heldOut !== undefined && round.evaluation?.heldOutBaseline !== undefined) {
        const heldOutAttempt = round.evaluationAttempts?.find(attempt => (
          attempt.provider === heldOut.evidence.provider && attempt.evalId === heldOut.evidence.evalId
        ))
        if (digestJson(round.evaluation.heldOutBaseline) !== heldOut.evidenceDigest
          || heldOutAttempt?.status !== 'settled' || heldOutAttempt.phase !== 'held-out-baseline'
          || heldOutAttempt.owner.role !== 'baseline' || heldOutAttempt.owner.harnessRef !== round.targetHarnessRef
          || heldOutAttempt.reusedFromEvolutionId !== snapshot.source.evolutionId
          || heldOutAttempt.reusedFromRoundId !== snapshot.source.roundId) {
          throw new TypeError('round held-out baseline differs from its source snapshot')
        }
      }
    }
    if (round.advisoryFocus !== undefined && (!Array.isArray(round.advisoryFocus)
      || new Set(round.advisoryFocus).size !== round.advisoryFocus.length)) {
      throw new TypeError('round advisoryFocus must be a deduplicated array')
    }
    if (round.experienceSnapshot !== undefined) {
      const snapshot = round.experienceSnapshot
      if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.members)
        || snapshot.members.length > 4_096 || !/^sha256:[0-9a-f]{64}$/u.test(snapshot.digest)
        || new Set(snapshot.members.map(member => member.recordId)).size !== snapshot.members.length
        || new Set(snapshot.members.map(member => member.recordDigest)).size !== snapshot.members.length) {
        throw new TypeError('round seed experience snapshot is invalid')
      }
      for (const member of snapshot.members) {
        if (typeof member.recordId !== 'string' || member.recordId.length === 0
          || !/^sha256:[0-9a-f]{64}$/u.test(member.recordDigest)
          || typeof member.sourceRoundId !== 'string' || member.sourceRoundId.length === 0
          || typeof member.candidateId !== 'string' || member.candidateId.length === 0
          || !isExactGitCommit(member.candidateHarnessRef)
          || member.sourceRoundId === round.roundId) {
          throw new TypeError('round seed experience snapshot member is invalid')
        }
      }
      if (snapshot.digest !== digestJson({ schemaVersion: 1, members: snapshot.members })) {
        throw new TypeError('round seed experience snapshot digest mismatch')
      }
    }
    if (round.finalization !== undefined && round.finalization !== null) {
      if (typeof round.finalization.rationale !== 'string' || round.finalization.rationale.length === 0
        || typeof round.finalization.expectedOutcome !== 'string' || round.finalization.expectedOutcome.length === 0
        || !Array.isArray(round.finalization.evidenceRefs)
        || round.finalization.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length === 0)) {
        throw new TypeError('round finalization is invalid')
      }
    }
    if (round.decline !== undefined && (typeof round.decline.rationale !== 'string'
      || round.decline.rationale.length === 0 || !Array.isArray(round.decline.evidenceRefs)
      || round.decline.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length === 0))) {
      throw new TypeError('round decline is invalid')
    }
    if (round.searchMode !== undefined) {
      if (round.searchMode !== 'failure-cluster-gepa-v1' || !round.searchAnchor) throw new TypeError('invalid search round admission')
      const { digest: anchorDigest, ...snapshot } = round.searchAnchor.snapshot
      if (digestJson(snapshot) !== anchorDigest || snapshot.commit !== round.targetHarnessRef || snapshot.manifestDigest !== round.targetHarnessDigest
        || !/^sha256:[a-f0-9]{64}$/u.test(round.searchAnchor.championRevisionDigest)) throw new TypeError('search champion anchor identity mismatch')
      if (round.searchOutcome) {
        validateSearchSchema('SearchRoundOutcome', round.searchOutcome)
        const { digest: outcomeDigest, ...outcome } = round.searchOutcome
        if (digestJson(outcome) !== outcomeDigest || outcome.roundId !== round.roundId || outcome.schemaVersion !== 2
          || outcome.championAnchorDigest !== anchorDigest || outcome.championChanged !== (round.status === 'accepted')) throw new TypeError('search terminal decision mismatch')
        if (outcome.championChanged && (outcome.advisory || outcome.promotion?.outcome !== 'accepted'
          || !round.candidatePool?.some(c => c.candidateId === outcome.nomineeId && c.sealedVersion))) throw new TypeError('search champion requires complete promotion')
      } else if (round.status === 'accepted') throw new TypeError('search accepted round missing v2 outcome')
    }
    if (!Array.isArray(round.candidatePool) || round.candidatePool.length === 0 && round.searchMode === undefined
      || new Set(round.candidatePool.map(candidate => candidate.candidateId)).size !== round.candidatePool.length) {
      throw new TypeError('round candidatePool is invalid')
    }
    if (round.candidateGenerationDeadlineAt !== undefined
      && (!Number.isSafeInteger(round.candidateGenerationDeadlineAt) || round.candidateGenerationDeadlineAt <= 0)) {
      throw new TypeError('round candidate generation deadline is invalid')
    }
    for (const candidate of round.candidatePool) {
      if (candidate.roundId !== round.roundId || candidate.candidateId.length === 0
        || !isExactGitCommit(candidate.parentHarnessRef) || candidate.parentCandidateIds.length !== 1) {
        throw new TypeError('round candidate identity is invalid')
      }
      for (const checkpoint of [candidate.parentCheckpoint, candidate.resultCheckpoint]) {
        if (checkpoint !== undefined && (typeof checkpoint.sourceSessionId !== 'string'
          || !Number.isSafeInteger(checkpoint.eventCount) || checkpoint.eventCount < 0
          || !/^sha256:[0-9a-f]{64}$/u.test(checkpoint.prefixDigest))) {
          throw new TypeError('round candidate Meta checkpoint is invalid')
        }
      }
      if (candidate.generationAttempts !== undefined) {
        if (!Array.isArray(candidate.generationAttempts) || candidate.generationAttempts.length === 0) {
          throw new TypeError('round candidate generation attempts are invalid')
        }
        for (const [index, attempt] of candidate.generationAttempts.entries()) {
          const hasValidFailure = attempt.failure !== undefined
            && typeof attempt.failure.phase === 'string' && attempt.failure.phase.length > 0
            && typeof attempt.failure.message === 'string' && attempt.failure.message.length > 0
            && (attempt.failure.prerequisite === undefined
              || validMetaPrerequisiteFailure(attempt.failure.prerequisite))
          const turnUsage = attempt.metaTurn?.usage
          const hasValidMetaTurn = attempt.metaTurn === undefined || (
            typeof attempt.metaTurn.reason === 'string' && attempt.metaTurn.reason.length > 0
            && (attempt.metaTurn.turn === undefined || Number.isSafeInteger(attempt.metaTurn.turn))
            && (attempt.metaTurn.durationMs === undefined
              || Number.isSafeInteger(attempt.metaTurn.durationMs) && attempt.metaTurn.durationMs >= 0)
            && (attempt.metaTurn.effectiveMaxTokens === undefined
              || Number.isSafeInteger(attempt.metaTurn.effectiveMaxTokens) && attempt.metaTurn.effectiveMaxTokens > 0)
            && (turnUsage === undefined || [
              turnUsage.inputTokens, turnUsage.outputTokens, turnUsage.cacheReadTokens,
              turnUsage.cacheWriteTokens, turnUsage.reasoningTokens,
            ].every(value => value === undefined || Number.isSafeInteger(value) && value >= 0))
          )
          if (attempt.attempt !== index + 1
            || attempt.deadlineAt !== undefined && (!Number.isSafeInteger(attempt.deadlineAt) || attempt.deadlineAt <= 0)
            || [attempt.preparationCompletedAt, attempt.proposalCompletedAt].some(value => value !== undefined && !Number.isFinite(Date.parse(value)))
            || typeof attempt.startedAt !== 'string' || attempt.startedAt.length === 0
            || attempt.workspaceId !== undefined && (typeof attempt.workspaceId !== 'string' || attempt.workspaceId.length === 0)
            || attempt.metaSessionId !== undefined && (typeof attempt.metaSessionId !== 'string' || attempt.metaSessionId.length === 0)
            || attempt.prerequisiteBlocker !== undefined && !validMetaPrerequisiteFailure(attempt.prerequisiteBlocker)
            || attempt.status === 'running' && (attempt.completedAt !== undefined || attempt.failure !== undefined)
            || attempt.status === 'succeeded' && (typeof attempt.completedAt !== 'string' || attempt.completedAt.length === 0 || attempt.failure !== undefined)
            || attempt.status === 'failed' && (typeof attempt.completedAt !== 'string' || attempt.completedAt.length === 0 || !hasValidFailure)
            || !hasValidMetaTurn
            || !['running', 'succeeded', 'failed'].includes(attempt.status)) {
            throw new TypeError('round candidate generation attempt is invalid')
          }
        }
      }
      if (candidate.diff !== undefined && (candidate.diff.parentRef !== candidate.parentHarnessRef
        || !/^sha256:[0-9a-f]{64}$/u.test(candidate.diff.patchDigest)
        || !Number.isSafeInteger(candidate.diff.totalBytes) || candidate.diff.totalBytes < 0
        || !Array.isArray(candidate.diff.files))) {
        throw new TypeError('round candidate diff is invalid')
      }
      if (candidate.sealedVersion !== undefined) {
        if (!isExactGitCommit(candidate.sealedVersion.commitOid) || !isExactGitCommit(candidate.sealedVersion.treeOid)
          || !/^sha256:[0-9a-f]{64}$/u.test(candidate.sealedVersion.manifestDigest)
          || !/^sha256:[0-9a-f]{64}$/u.test(candidate.sealedVersion.patchDigest)
          || !candidate.sealedVersion.immutableRef.startsWith('refs/dsh-refine/evolutions/')) {
          throw new TypeError('round sealed candidate identity is invalid')
        }
        if (candidate.diff !== undefined && candidate.sealedVersion.patchDigest !== candidate.diff.patchDigest) {
          throw new TypeError('round sealed candidate patch digest mismatch')
        }
      }
      if (candidate.seedEvaluation !== undefined) this.validateEvaluationEvidence(candidate.seedEvaluation, 'candidate seed evaluation')
      if (candidate.seedComparison !== undefined) {
        if (candidate.seedEvaluation === undefined
          || typeof candidate.seedComparison.parentBaselineEvalId !== 'string'
          || !Number.isFinite(candidate.seedComparison.scoreDelta)
          || (candidate.seedComparison.processScoreDelta !== undefined && !Number.isFinite(candidate.seedComparison.processScoreDelta))
          || !Number.isSafeInteger(candidate.seedComparison.requiredRegressions)
          || candidate.seedComparison.requiredRegressions < 0) {
          throw new TypeError('candidate seed comparison is invalid')
        }
        this.validatePairedTrials(
          candidate.seedComparison.pairedTrials,
          round.plan.seed.conditionId,
          candidate.seedComparison.pairing.paired,
          'candidate seed',
        )
        const parentBaselineRecord = round.parentBaselines?.find(value => (
          value.evidence.evalId === candidate.seedComparison!.parentBaselineEvalId
        ))
        if (parentBaselineRecord === undefined
          || parentBaselineRecord.parentCandidateId !== candidate.parentCandidateIds[0]) {
          throw new TypeError('candidate seed comparison baseline is unavailable')
        }
        const parentBaseline = parentBaselineRecord.evidence
        this.validatePairingAudit(
          candidate.seedComparison.pairing,
          parentBaseline,
          candidate.seedEvaluation,
          candidate.seedComparison.pairedTrials,
          'candidate seed',
        )
        if (Math.abs(candidate.seedComparison.scoreDelta - pairedScoreDelta(candidate.seedComparison.pairedTrials)) > 1e-12) {
          throw new TypeError('candidate seed comparison score delta is invalid')
        }
        const expectedProcessScoreDelta = pairedProcessScoreDelta(candidate.seedComparison.pairedTrials)
        if ((candidate.seedComparison.processScoreDelta === undefined) !== (expectedProcessScoreDelta === undefined)
          || candidate.seedComparison.processScoreDelta !== undefined
            && Math.abs(candidate.seedComparison.processScoreDelta - expectedProcessScoreDelta!) > 1e-12) {
          throw new TypeError('candidate seed comparison process score delta is invalid')
        }
        if (candidate.seedComparison.requiredRegressions !== requiredRegressionCount(
          promotionPolicy.requiredTaskIds ?? [],
          candidate.seedComparison.pairedTrials,
        )) {
          throw new TypeError('candidate seed comparison required regressions are invalid')
        }
      }
      if (candidate.heldOutEvaluation !== undefined) this.validateEvaluationEvidence(candidate.heldOutEvaluation, 'candidate held-out evaluation')
      if (candidate.metrics !== undefined && !validMetricSet(candidate.metrics)) throw new TypeError('candidate metrics are invalid')
    }
    if (['accepted', 'rejected', 'rejected-for-substrate', 'failed'].includes(round.status)
      && round.candidatePool.some(candidate => candidate.generationAttempts?.some(attempt => attempt.status === 'running'))) {
      throw new TypeError('terminal round cannot contain a running candidate generation attempt')
    }
    if (round.championParent !== undefined) {
      const parent = this.validatePopulationMember(round.championParent)
      if (parent.harnessRef !== round.targetHarnessRef || parent.harnessDigest !== round.targetHarnessDigest) {
        throw new TypeError('round champion parent does not match its admitted champion')
      }
      if (!Array.isArray(round.parentAllocations)
        || new Set(round.parentAllocations.map(allocation => allocation.candidateId)).size !== round.candidatePool.length
        || round.parentAllocations.some(allocation => allocation.parentCandidateId !== parent.candidateId
          || allocation.parentHarnessRef !== parent.harnessRef || allocation.parentHarnessDigest !== parent.harnessDigest)
        || round.candidatePool.some(candidate => candidate.parentCandidateIds[0] !== parent.candidateId
          || candidate.parentHarnessRef !== parent.harnessRef)) {
        throw new TypeError('round champion parent allocation is invalid')
      }
    }
    if (round.parentAllocations !== undefined) {
      if (round.parentAllocations.length !== round.candidatePool.length) throw new TypeError('round parent allocation is incomplete')
      for (const allocation of round.parentAllocations) {
        const candidate = round.candidatePool.find(item => item.candidateId === allocation.candidateId)
        if (candidate === undefined || candidate.parentCandidateIds[0] !== allocation.parentCandidateId
          || candidate.parentHarnessRef !== allocation.parentHarnessRef || !isExactGitCommit(allocation.parentHarnessRef)
          || !/^sha256:[0-9a-f]{64}$/u.test(allocation.parentHarnessDigest)) {
          throw new TypeError('round parent allocation is invalid')
        }
      }
    }
    if (round.evaluationStarts !== undefined) {
      if (!Array.isArray(round.evaluationStarts)) throw new TypeError('round evaluationStarts must be an array')
      for (const start of round.evaluationStarts) {
        if (typeof start !== 'object' || start === null
          || !['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'].includes(start.phase)
          || !isExactGitCommit(start.harnessRef)
          || start.conditionId !== (start.phase.startsWith('seed-') ? round.plan!.seed : round.plan!.heldOut).conditionId
          || typeof start.startedAt !== 'string' || start.startedAt.length === 0) {
          throw new TypeError('round evaluation start is invalid')
        }
      }
    }
    if (round.evaluationRepairResume !== undefined && round.evaluationAttempts === undefined) {
      throw new TypeError('round evaluation repair resume intent requires evaluation attempts')
    }
    if (round.evaluationAttempts !== undefined) {
      if (!Array.isArray(round.evaluationAttempts)) throw new TypeError('round evaluationAttempts must be an array')
      const identities = new Set<string>()
      for (const attempt of round.evaluationAttempts) {
        this.validateEvaluationAttempt(round as RefinementRound, attempt, identities)
      }
    }
    if (round.pendingEvaluationRerun !== undefined) {
      const pending = round.pendingEvaluationRerun
      if (typeof pending !== 'object' || pending === null || typeof pending.reservation !== 'object' || pending.reservation === null) {
        throw new TypeError('pending evaluation rerun is invalid')
      }
      const reservation = pending.reservation
      this.validateSubmissionIntent({ provider: reservation.provider, idempotencyKey: reservation.rerunId, parameters: reservation.parameters })
      const attempt = round.evaluationAttempts?.find(value => value.provider === reservation.provider && value.evalId === reservation.evalId)
      if (attempt === undefined || (attempt.status !== 'rerunning' && attempt.status !== 'failed')
        || (round.status !== 'repairing-evaluation' && round.status !== 'failed')
        || (reservation.provider === 'hitch-cli' && !/^rerun_[0-9a-f]{32}$/u.test(reservation.rerunId))) {
        throw new TypeError('pending evaluation rerun does not match its owned attempt')
      }
    }
    if (round.pendingEvaluationSubmissions !== undefined) {
      if (!Array.isArray(round.pendingEvaluationSubmissions)) throw new TypeError('pending evaluation submissions must be an array')
      const identities = new Set<string>()
      for (const pending of round.pendingEvaluationSubmissions) {
        if (typeof pending !== 'object' || pending === null || typeof pending.request !== 'object'
          || pending.request === null || typeof pending.request.phase !== 'string') {
          throw new TypeError('pending evaluation submission is invalid')
        }
        this.validateSubmissionIntent(pending.intent)
        const identity = `${pending.intent.provider}\0${pending.intent.idempotencyKey}`
        if (identities.has(identity)) throw new TypeError('pending evaluation submission is duplicated')
        identities.add(identity)
        const request = pending.request
        const condition = request.phase.startsWith('seed-') ? round.plan!.seed : round.plan!.heldOut
        if (digestJson(request.condition) !== digestJson(condition)
          || (pending.reservation !== undefined && pending.reservation.provider !== pending.intent.provider)) {
          throw new TypeError('pending evaluation submission condition/provider is invalid')
        }
        this.validateEvaluationAttempt(round as RefinementRound, {
          provider: pending.intent.provider,
          evalId: pending.reservation?.evalId ?? `eval_${'0'.repeat(32)}`,
          phase: request.phase, owner: pending.owner,
          conditionId: request.condition.conditionId, dataset: request.dataset,
          requestedModelId: request.condition.model, requestedCommit: request.harnessRef,
          status: 'running', startedAt: pending.startedAt,
        }, new Set())
      }
    }
    if (round.parentBaselines !== undefined) {
      for (const baseline of round.parentBaselines) {
        this.validateEvaluationEvidence(baseline.evidence, 'parent seed baseline', round.searchMode === 'failure-cluster-gepa-v1')
        if (baseline.evidence.actualCommit !== baseline.parentHarnessRef
          || baseline.evidence.conditionId !== round.plan.seed.conditionId) throw new TypeError('parent seed baseline identity is invalid')
      }
    }
    if (round.failedEvaluations !== undefined) {
      if (!Array.isArray(round.failedEvaluations)) throw new TypeError('round failed evaluations must be an array')
      const keys = round.failedEvaluations.map(value => `${value.phase}\u0000${value.owner.candidateId}\u0000${value.evidence.evalId}`)
      if (new Set(keys).size !== keys.length) throw new TypeError('round failed evaluations are duplicated')
      for (const failed of round.failedEvaluations) this.validateFailedEvaluation(failed, round as RefinementRound)
    }
    if (round.selectionAssessment !== undefined) {
      const assessableCandidates = round.candidatePool
        .filter(candidate => candidate.seedEvaluation !== undefined && candidate.seedComparison !== undefined && candidate.metrics !== undefined)
      const assessable = assessableCandidates.map(candidate => candidate.candidateId)
      this.validateCandidateAssessment(round.selectionAssessment, assessable)
      if (assessableCandidates.some(candidate => digestJson(candidate.metrics) !== digestJson(
        round.selectionAssessment!.candidateMetrics[candidate.candidateId],
      ))) {
        throw new TypeError('round candidate assessment metrics do not match candidate records')
      }
    }
    if (round.selection !== undefined) {
      const selected = new Set(round.selection.selectedCandidateIds)
      const assessedIds = Object.keys(round.selectionAssessment?.candidateMetrics ?? {}).sort()
      const metricIds = Object.keys(round.selection.metrics).sort()
      if (selected.size !== round.selection.selectedCandidateIds.length || selected.size === 0
        || !selected.has(round.selection.promotionCandidateId)
        || round.selectionAssessment === undefined
        || round.selection.assessmentDigest !== round.selectionAssessment.digest
        || !validComponentRef(round.selection.component, 'candidate-selector')
        || JSON.stringify(metricIds) !== JSON.stringify(assessedIds)
        || Object.values(round.selection.metrics).some(metric => !Number.isFinite(metric))
        || round.promotionCandidateId !== undefined && round.promotionCandidateId !== round.selection.promotionCandidateId
        || [...selected].some(id => !round.candidatePool!.some(candidate => candidate.candidateId === id))) {
        throw new TypeError('round selection decision is invalid')
      }
    }
    if (round.meta !== undefined && round.meta.evolutionId !== round.evolutionId) {
      throw new TypeError('round meta attribution evolution mismatch')
    }
    if (round.proposalEvidence !== undefined && round.proposalEvidence.evolutionId !== round.evolutionId) {
      throw new TypeError('round proposal evidence evolution mismatch')
    }
    if (round.baseline !== undefined) this.validateEvaluationEvidence(round.baseline, 'round baseline')
    if (round.evaluationMode !== undefined && round.evaluationMode !== 'reuse-seed') {
      throw new TypeError('round evaluation mode is invalid')
    }
    if (round.evaluation?.heldOutReusedFromSeed !== undefined) {
      const { conditionId: _seedId, partition: _seedPartition, ...seed } = round.plan.seed
      const { conditionId: _heldOutId, partition: _heldOutPartition, ...heldOut } = round.plan.heldOut
      if (round.evaluationMode !== 'reuse-seed' || round.evaluation.heldOutReusedFromSeed !== true
        || digestJson(seed) !== digestJson(heldOut)
        || digestJson(round.evaluation.seedBaseline) !== digestJson(round.evaluation.heldOutBaseline)
        || digestJson(round.evaluation.seedCandidate) !== digestJson(round.evaluation.heldOutCandidate)
        || digestJson(round.evaluation.seedPairedTrials) !== digestJson(round.evaluation.heldOutPairedTrials)) {
        throw new TypeError('reused held-out evidence must exactly match seed evidence and conditions')
      }
    }
    const heldOutConditionId = round.evaluation?.heldOutReusedFromSeed === true
      ? round.plan.seed.conditionId : round.plan.heldOut.conditionId
    if (round.evaluation !== undefined) {
      this.validateEvaluationEvidence(round.evaluation.seedBaseline, 'seed baseline')
      this.validateEvaluationEvidence(round.evaluation.seedCandidate, 'seed candidate')
      if (round.evaluation.heldOutBaseline !== undefined) this.validateEvaluationEvidence(round.evaluation.heldOutBaseline, 'held-out baseline')
      if (round.evaluation.heldOutCandidate !== undefined) this.validateEvaluationEvidence(round.evaluation.heldOutCandidate, 'held-out candidate')
      this.validatePairedTrials(
        round.evaluation.seedPairedTrials,
        round.plan.seed.conditionId,
        round.evaluation.seedPairing.paired,
        'seed',
      )
      this.validatePairingAudit(
        round.evaluation.seedPairing,
        round.evaluation.seedBaseline,
        round.evaluation.seedCandidate,
        round.evaluation.seedPairedTrials,
        'seed',
      )
      if (Math.abs(round.evaluation.scoreDelta - pairedScoreDelta(round.evaluation.seedPairedTrials)) > 1e-12) {
        throw new TypeError('round seed score delta does not match paired evidence')
      }
      const seedProcessScoreDelta = pairedProcessScoreDelta(round.evaluation.seedPairedTrials)
      if ((round.evaluation.processScoreDelta === undefined) !== (seedProcessScoreDelta === undefined)
        || round.evaluation.processScoreDelta !== undefined
          && Math.abs(round.evaluation.processScoreDelta - seedProcessScoreDelta!) > 1e-12) {
        throw new TypeError('round seed process score delta does not match paired evidence')
      }
      if (round.evaluation.heldOutPairedTrials !== undefined) {
        if (round.evaluation.heldOutBaseline === undefined || round.evaluation.heldOutCandidate === undefined
          || round.evaluation.heldOutPairing === undefined) throw new TypeError('held-out pairs require paired evidence and audit')
        this.validatePairedTrials(
          round.evaluation.heldOutPairedTrials,
          heldOutConditionId,
          round.evaluation.heldOutPairing.paired,
          'held-out',
        )
        this.validatePairingAudit(
          round.evaluation.heldOutPairing,
          round.evaluation.heldOutBaseline,
          round.evaluation.heldOutCandidate,
          round.evaluation.heldOutPairedTrials,
          'held-out',
        )
        if (round.evaluation.heldOutScoreDelta === undefined
          || Math.abs(round.evaluation.heldOutScoreDelta - pairedScoreDelta(round.evaluation.heldOutPairedTrials)) > 1e-12) {
          throw new TypeError('round held-out score delta does not match paired evidence')
        }
        const heldOutProcessScoreDelta = pairedProcessScoreDelta(round.evaluation.heldOutPairedTrials)
        if ((round.evaluation.heldOutProcessScoreDelta === undefined) !== (heldOutProcessScoreDelta === undefined)
          || round.evaluation.heldOutProcessScoreDelta !== undefined
            && Math.abs(round.evaluation.heldOutProcessScoreDelta - heldOutProcessScoreDelta!) > 1e-12) {
          throw new TypeError('round held-out process score delta does not match paired evidence')
        }
      } else if (round.evaluation.heldOutCandidate !== undefined) {
        throw new TypeError('held-out candidate evidence requires paired trials')
      } else if (round.evaluation.heldOutPairing !== undefined) {
        throw new TypeError('held-out pairing audit requires paired trials')
      }
      if (round.evaluation.promotionMetrics !== undefined && !validMetricSet(round.evaluation.promotionMetrics)) {
        throw new TypeError('round promotion metrics are invalid')
      }
      if (!Number.isFinite(round.evaluation.scoreDelta)
        || (round.evaluation.processScoreDelta !== undefined && !Number.isFinite(round.evaluation.processScoreDelta))
        || (round.evaluation.heldOutScoreDelta !== undefined && !Number.isFinite(round.evaluation.heldOutScoreDelta))
        || (round.evaluation.heldOutProcessScoreDelta !== undefined && !Number.isFinite(round.evaluation.heldOutProcessScoreDelta))
        || !Number.isSafeInteger(round.evaluation.requiredRegressions) || round.evaluation.requiredRegressions < 0) {
        throw new TypeError('round evaluation deltas are invalid')
      }
      const expectedRequiredRegressions = requiredRegressionCount(
        promotionPolicy.requiredTaskIds ?? [],
        round.evaluation.seedPairedTrials,
      ) + (round.evaluation.heldOutReusedFromSeed === true ? 0 : requiredRegressionCount(
        promotionPolicy.requiredTaskIds ?? [],
        round.evaluation.heldOutPairedTrials ?? [],
      ))
      if (round.evaluation.requiredRegressions !== expectedRequiredRegressions) {
        throw new TypeError('round required regressions do not match paired evidence')
      }
      if (round.status === 'accepted' && (round.evaluation.seedPairedTrials.length === 0
        || (round.evaluation.heldOutPairedTrials?.length ?? 0) === 0)) {
        throw new TypeError('accepted round requires valid seed and held-out pairs')
      }
    }
    if (round.evaluationAttempts !== undefined) {
      const evidence = [
        round.baseline,
        ...(round.parentBaselines ?? []).map(value => value.evidence),
        ...round.candidatePool.flatMap(candidate => [candidate.seedEvaluation, candidate.heldOutEvaluation]),
        round.evaluation?.seedBaseline,
        round.evaluation?.seedCandidate,
        round.evaluation?.heldOutBaseline,
        round.evaluation?.heldOutCandidate,
      ].filter((value): value is EvaluationEvidence => value !== undefined)
      for (const value of evidence) {
        const attempt = round.evaluationAttempts.find(candidate => candidate.provider === value.provider && candidate.evalId === value.evalId)
        const durableRepairEvidence = attempt?.status === 'repair-completed'
          && round.evaluationRepairResume?.provider === attempt.provider
          && round.evaluationRepairResume.evalId === attempt.evalId
        const legacyRepairEvidence = round.evaluationRepairResume === undefined
          && round.status === 'repairing-evaluation'
          && (attempt?.status === 'rerunning' || attempt?.status === 'repair-completed')
        if (attempt === undefined || (attempt.status !== 'settled' && !durableRepairEvidence && !legacyRepairEvidence)
          || attempt.conditionId !== value.conditionId || attempt.dataset !== value.dataset
          || attempt.requestedCommit !== value.requestedCommit || attempt.owner.harnessRef !== value.actualCommit) {
          throw new TypeError('round evaluation evidence does not match its durable attempt ownership')
        }
      }
      const resume = round.evaluationRepairResume
      if (resume !== undefined) {
        if (typeof resume !== 'object' || resume === null
          || typeof resume.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(resume.provider)
          || typeof resume.evalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(resume.evalId)
          || typeof resume.completedAt !== 'string' || resume.completedAt.length === 0) {
          throw new TypeError('round evaluation repair resume intent is invalid')
        }
        const terminal = round.status === 'accepted' || round.status === 'rejected'
          || round.status === 'rejected-for-substrate' || round.status === 'failed'
        const attempt = round.evaluationAttempts.find(candidate => candidate.provider === resume.provider && candidate.evalId === resume.evalId)
        if (terminal || round.decision !== undefined || round.commitIntent !== undefined
          || attempt?.status !== 'repair-completed' || attempt.completedAt !== resume.completedAt
          || !evidence.some(value => value.provider === resume.provider && value.evalId === resume.evalId)) {
          throw new TypeError('round evaluation repair resume intent is invalid')
        }
      }
      for (const attempt of round.evaluationAttempts) {
        const ownsResume = round.evaluationRepairResume?.provider === attempt.provider
          && round.evaluationRepairResume.evalId === attempt.evalId
        const legacyPendingResume = round.evaluationRepairResume === undefined && round.status === 'repairing-evaluation'
        if (attempt.status === 'repair-completed' && ((!ownsResume && !legacyPendingResume)
          || !evidence.some(value => value.provider === attempt.provider && value.evalId === attempt.evalId))) {
          throw new TypeError('completed evaluation repair requires durable evidence and pending resume state')
        }
      }
    }
    if (round.parentPopulationDigest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(round.parentPopulationDigest)) {
      throw new TypeError('round parent population digest is invalid')
    }
    if (round.commitIntent !== undefined) {
      const intent = round.commitIntent
      if (intent.expectedPopulationDigest !== round.parentPopulationDigest
        || intent.expectedChampionRef !== round.targetHarnessRef
        || intent.promotionCandidateId !== round.promotionCandidateId
        || !['prepared', 'population-committed', 'champion-committed'].includes(intent.phase)
        || !['accepted', 'rejected'].includes(intent.decision)) {
        throw new TypeError('round commit intent identity is invalid')
      }
      this.validatePopulation(intent.nextPopulation)
      const selectedIds = new Set(round.selection?.selectedCandidateIds ?? [])
      if (intent.nextPopulation.evolutionId !== round.evolutionId
        || intent.nextPopulation.members.length !== selectedIds.size
        || intent.nextPopulation.members.some(member => {
          const candidate = round.candidatePool!.find(value => value.candidateId === member.candidateId)
          return !selectedIds.has(member.candidateId) || candidate?.metrics === undefined || candidate.resultCheckpoint === undefined
            || candidate.metaSessionId === undefined || candidate.sealedVersion?.commitOid !== member.harnessRef
            || candidate.sealedVersion.manifestDigest !== member.harnessDigest
            || candidate.metaSessionId !== member.metaSessionId
            || digestJson(candidate.metrics) !== digestJson(member.metrics)
            || digestJson(candidate.resultCheckpoint) !== digestJson(member.metaCheckpoint)
        })) {
        throw new TypeError('round commit intent population does not match seed-selected candidates')
      }
      if ((intent.decision === 'accepted') !== (intent.nextChampion !== undefined)) {
        throw new TypeError('round commit intent champion decision is incomplete')
      }
      if (intent.nextChampion !== undefined
        && (this.validateChampion(intent.nextChampion).ref
          !== round.candidatePool.find(candidate => candidate.candidateId === intent.promotionCandidateId)?.sealedVersion?.commitOid)) {
        throw new TypeError('round commit intent champion is invalid')
      }
    }
    const terminal = round.status === 'accepted' || round.status === 'rejected'
      || round.status === 'rejected-for-substrate' || round.status === 'failed'
    if (!terminal && round.decision !== undefined) throw new TypeError('non-terminal round cannot have a decision')
    if (round.status === 'accepted' && round.searchMode === undefined) {
      const promoted = round.candidatePool.find(candidate => candidate.candidateId === round.promotedCandidateId)
      if (round.decision !== 'accepted' || promoted?.sealedVersion === undefined
        || round.evaluation?.heldOutBaseline === undefined || round.evaluation.heldOutCandidate === undefined
        || round.evaluation.seedCandidate.actualCommit !== promoted.sealedVersion.commitOid
        || round.evaluation.heldOutCandidate.actualCommit !== promoted.sealedVersion.commitOid) {
        throw new TypeError('accepted round is missing verified candidate evaluation evidence')
      }
    }
    if (round.baseline !== undefined
      && (round.baseline.requestedCommit !== round.targetHarnessRef
        || round.baseline.actualCommit !== round.targetHarnessRef
        || round.baseline.dataset !== round.seedTaskRef
        || round.baseline.conditionId !== round.plan.seed.conditionId)) {
      throw new TypeError('round baseline does not match its pinned target/seed partition')
    }
    if (round.evaluation !== undefined) {
      const candidate = round.candidatePool.find(value => value.sealedVersion?.commitOid === round.evaluation?.seedCandidate.actualCommit)
        ?.sealedVersion?.commitOid
      if (candidate === undefined
        || round.evaluation.seedBaseline.requestedCommit !== round.targetHarnessRef
        || round.evaluation.seedBaseline.actualCommit !== round.targetHarnessRef
        || round.evaluation.seedBaseline.dataset !== round.seedTaskRef
        || round.evaluation.seedCandidate.requestedCommit !== candidate
        || round.evaluation.seedCandidate.actualCommit !== candidate
        || round.evaluation.seedCandidate.dataset !== round.seedTaskRef
        || round.evaluation.seedBaseline.conditionId !== round.plan.seed.conditionId
        || round.evaluation.seedCandidate.conditionId !== round.plan.seed.conditionId
        || round.evaluation.seedBaseline.provider !== round.evaluation.seedCandidate.provider
        || round.evaluation.seedBaseline.effectiveConfigDigest !== round.evaluation.seedCandidate.effectiveConfigDigest) {
        throw new TypeError('round seed evaluation does not match its pinned commits/partition/parity')
      }
      const heldOutBaseline = round.evaluation.heldOutBaseline
      const heldOutCandidate = round.evaluation.heldOutCandidate
      if (heldOutBaseline !== undefined
        && (heldOutBaseline.requestedCommit !== round.targetHarnessRef
          || heldOutBaseline.actualCommit !== round.targetHarnessRef
          || heldOutBaseline.dataset !== round.heldOutRef
          || heldOutBaseline.conditionId !== heldOutConditionId)) {
        throw new TypeError('round held-out baseline does not match its pinned target/partition')
      }
      if (heldOutCandidate !== undefined
        && (heldOutBaseline === undefined
          || heldOutCandidate.requestedCommit !== candidate
          || heldOutCandidate.actualCommit !== candidate
          || heldOutCandidate.dataset !== round.heldOutRef
          || heldOutCandidate.conditionId !== heldOutConditionId
          || heldOutBaseline.provider !== heldOutCandidate.provider
          || heldOutBaseline.effectiveConfigDigest !== heldOutCandidate.effectiveConfigDigest)) {
        throw new TypeError('round held-out evaluation does not match its pinned commits/partition/parity')
      }
    }
    if (round.status === 'rejected' && round.decision !== 'rejected' && round.decision !== 'no-change') {
      throw new TypeError('rejected round must record rejected or no-change decision')
    }
    if (round.status === 'rejected-for-substrate' && round.decision !== 'rejected-for-substrate') {
      throw new TypeError('substrate rejection must record rejected-for-substrate decision')
    }
    return round as RefinementRound
  }

}
