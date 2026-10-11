import type { EvaluationEvidence, EvaluationRequest, RefinementRound, RoundEvaluationAttempt } from '../types.js'
import { type RoundPatch, type ActiveRound } from './service-contracts.js'
import { TERMINAL } from './generation-state.js'

export function sameAttempt(left: Pick<RoundEvaluationAttempt, 'provider' | 'evalId'>, right: Pick<RoundEvaluationAttempt, 'provider' | 'evalId'>): boolean {
    return left.provider === right.provider && left.evalId === right.evalId
  }

export function attemptHasEvidence(round: RefinementRound, attempt: RoundEvaluationAttempt): boolean {
    const matches = (evidence: EvaluationEvidence | undefined): boolean =>
      evidence?.provider === attempt.provider && evidence.evalId === attempt.evalId
    if (attempt.phase === 'seed-baseline') {
      return matches(round.baseline)
        || round.parentBaselines?.some(value => matches(value.evidence)) === true
    }
    if (attempt.phase === 'seed-candidate') {
      return round.candidatePool.some(candidate => matches(candidate.seedEvaluation))
    }
    if (attempt.phase === 'held-out-baseline') return matches(round.evaluation?.heldOutBaseline)
    return matches(round.evaluation?.heldOutCandidate)
      || round.candidatePool.some(candidate => matches(candidate.heldOutEvaluation))
  }

export function pendingRepairAttempt(round: RefinementRound): RoundEvaluationAttempt | undefined {
    if (round.commitIntent !== undefined || round.decision !== undefined || TERMINAL.has(round.status)) return undefined
    if (round.evaluationRepairResume !== undefined) {
      const attempt = round.evaluationAttempts?.find(value => sameAttempt(value, round.evaluationRepairResume!))
      if (attempt?.status !== 'repair-completed' || attempt.completedAt !== round.evaluationRepairResume.completedAt
        || !attemptHasEvidence(round, attempt)) {
        throw new Error(`round ${round.roundId} has an invalid evaluation repair resume intent`)
      }
      return attempt
    }
    if (round.status !== 'repairing-evaluation') return undefined
    const pending = (round.evaluationAttempts ?? []).filter(attempt => (
      attempt.status === 'repair-completed' || attempt.status === 'rerunning'
    ) && attemptHasEvidence(round, attempt))
    if (pending.length > 1) throw new Error(`round ${round.roundId} has multiple completed evaluation repairs`)
    return pending[0]
  }

export function repairableAttempts(round: RefinementRound): RoundEvaluationAttempt[] {
    if (round.decision !== undefined || round.commitIntent !== undefined) return []
    return (round.evaluationAttempts ?? []).filter(attempt =>
      attempt.provider === 'hitch-cli'
      && attempt.status === 'failed'
      && !attemptHasEvidence(round, attempt)
      && (attempt.phase !== 'seed-candidate' || round.candidatePool.some(candidate =>
        candidate.candidateId === attempt.owner.candidateId
        && candidate.sealedVersion?.commitOid === attempt.requestedCommit
        && candidate.seedEvaluation === undefined)),
    )
  }

export function evaluationRequest(round: RefinementRound, attempt: RoundEvaluationAttempt): EvaluationRequest {
    const condition = attempt.phase.startsWith('seed-') ? round.plan.seed : round.plan.heldOut
    const dataset = attempt.phase.startsWith('seed-') ? round.seedTaskRef : round.heldOutRef
    if (attempt.conditionId !== condition.conditionId || attempt.dataset !== dataset
      || attempt.requestedModelId !== condition.model || attempt.requestedCommit !== attempt.owner.harnessRef) {
      throw new Error(`evaluation attempt ${attempt.evalId} no longer matches its frozen condition`)
    }
    return { phase: attempt.phase, dataset, harnessRef: attempt.requestedCommit, condition }
  }

export function assertRepairedEvidence(attempt: RoundEvaluationAttempt, evidence: EvaluationEvidence): void {
    if (evidence.provider !== attempt.provider || evidence.evalId !== attempt.evalId
      || evidence.conditionId !== attempt.conditionId || evidence.dataset !== attempt.dataset
      || evidence.requestedCommit !== attempt.requestedCommit || evidence.actualCommit !== attempt.owner.harnessRef) {
      throw new Error(`repaired evaluation evidence does not match attempt ${attempt.evalId}`)
    }
  }

export function completeEvaluationRepairResume(
    active: ActiveRound,
    round: RefinementRound,
    patch: RoundPatch,
  ): RoundPatch {
    if (active.repairAttempt === undefined) return patch
    const intent = round.evaluationRepairResume
    if (intent === undefined || !sameAttempt(intent, active.repairAttempt)) {
      throw new Error(`round ${round.roundId} lost its durable evaluation repair resume intent`)
    }
    let found = false
    const evaluationAttempts = (round.evaluationAttempts ?? []).map(attempt => {
      if (!sameAttempt(attempt, active.repairAttempt!)) return attempt
      if (attempt.status !== 'repair-completed' || !attemptHasEvidence(round, attempt)) {
        throw new Error(`round ${round.roundId} cannot settle an incomplete evaluation repair`)
      }
      found = true
      const { failure: _failure, ...owned } = attempt
      return { ...owned, status: 'settled' as const, completedAt: intent.completedAt }
    })
    if (!found) throw new Error(`round ${round.roundId} lost its repaired evaluation attempt`)
    return { ...patch, evaluationRepairResume: undefined, evaluationAttempts }
  }
