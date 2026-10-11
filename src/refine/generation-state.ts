import { type MetaExecutionState } from '../meta/offloading-store.js'
import type { CandidateRecord, CandidateGenerationAttempt, CandidateGenerationSpec, EvaluationRerunSelector, MetaTurnObservation, RefinementRound, RefinementFailure, SemanticTarget, MetaPrerequisiteFailure } from '../types.js'
import { join } from 'node:path'
import { type FinalizationValue } from './service-contracts.js'

export const TERMINAL = new Set<RefinementRound['status']>(['accepted', 'rejected', 'rejected-for-substrate', 'failed'])

export function now(): string { return new Date().toISOString() }

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export class CandidateGenerationTimeoutError extends Error {
  constructor(readonly scope: 'attempt' | 'round', readonly budgetMs: number) {
    super(`candidate generation exceeded its ${budgetMs}ms ${scope} budget`)
    this.name = 'CandidateGenerationTimeoutError'
  }
}

export class MetaTurnEndedWithoutProposalError extends Error {
  constructor(readonly observation: MetaTurnObservation) {
    const details = [
      `reason=${observation.reason}`,
      observation.error?.code === undefined ? undefined : `code=${observation.error.code}`,
      observation.effectiveMaxTokens === undefined ? undefined : `effectiveMaxTokens=${observation.effectiveMaxTokens}`,
      observation.usage?.outputTokens === undefined ? undefined : `outputTokens=${observation.usage.outputTokens}`,
      observation.usage?.reasoningTokens === undefined ? undefined : `reasoningTokens=${observation.usage.reasoningTokens}`,
      observation.durationMs === undefined ? undefined : `durationMs=${observation.durationMs}`,
    ].filter((value): value is string => value !== undefined)
    super(`Meta turn ended without candidate.finalize or candidate.decline (${details.join(', ')})${observation.error === undefined ? '' : `: ${observation.error.message}`}`)
    this.name = 'MetaTurnEndedWithoutProposalError'
  }
}

export class ExternalMetaFailureError extends Error {
  constructor(readonly reason: string, readonly prerequisite?: MetaPrerequisiteFailure) {
    super(prerequisite === undefined
      ? `external Meta failed: ${reason}`
      : `external Meta blocked: ${prerequisite.code} (${prerequisite.blockedRuns
          .map(item => `${item.runId}:${item.cause ?? item.code}`).join(', ')})`)
    this.name = 'ExternalMetaFailureError'
  }
}

export function refinementFailure(phase: string, error: unknown): RefinementFailure {
  return {
    phase,
    message: errorMessage(error),
    ...(error instanceof ExternalMetaFailureError && error.prerequisite !== undefined
      ? { prerequisite: structuredClone(error.prerequisite) }
      : {}),
  }
}

export function runningPrerequisite(round: RefinementRound): MetaPrerequisiteFailure | undefined {
  return round.candidatePool.flatMap(candidate => candidate.generationAttempts ?? [])
    .find(attempt => attempt.status === 'running' && attempt.prerequisiteBlocker !== undefined)
    ?.prerequisiteBlocker
}

export function preferredFailure(phase: string, error: unknown, round: RefinementRound): RefinementFailure {
  if (error instanceof ExternalMetaFailureError && error.prerequisite !== undefined) {
    return refinementFailure(phase, error)
  }
  const prerequisite = runningPrerequisite(round)
  return refinementFailure(
    phase,
    prerequisite === undefined ? error : new ExternalMetaFailureError(errorMessage(error), prerequisite),
  )
}

export function effectiveCandidateGenerationBudget(spec: CandidateGenerationSpec): {
  attemptTimeoutMs: number
  maxAttemptsPerCandidate: number
  roundTimeoutMs: number
} {
  const { budget } = spec
  if (budget.attemptTimeoutMs !== undefined
    && budget.maxAttemptsPerCandidate !== undefined
    && budget.roundTimeoutMs !== undefined) {
    return {
      attemptTimeoutMs: budget.attemptTimeoutMs,
      maxAttemptsPerCandidate: budget.maxAttemptsPerCandidate,
      roundTimeoutMs: budget.roundTimeoutMs,
    }
  }
  if (budget.timeoutMs !== undefined) {
    return { attemptTimeoutMs: budget.timeoutMs, maxAttemptsPerCandidate: 1, roundTimeoutMs: budget.timeoutMs }
  }
  throw new Error('candidate generation budget is incomplete')
}

export function patchGenerationAttempt(
  attempts: readonly CandidateGenerationAttempt[],
  attempt: number,
  patch: Partial<CandidateGenerationAttempt>,
): CandidateGenerationAttempt[] {
  let found = false
  const updated = attempts.map(value => {
    if (value.attempt !== attempt) return value
    found = true
    return { ...value, ...patch, attempt: value.attempt }
  })
  if (!found) throw new Error(`unknown candidate generation attempt: ${attempt}`)
  return updated
}

export function settleInterruptedCandidateGeneration(
  round: RefinementRound,
  completedAt: string,
  source: string | RefinementFailure,
): CandidateRecord[] {
  return round.candidatePool.map(candidate => {
    if (!candidate.generationAttempts?.some(attempt => attempt.status === 'running')) return candidate
    const prerequisite = candidate.generationAttempts.find(attempt => attempt.status === 'running')?.prerequisiteBlocker
    const baseFailure = typeof source === 'string'
      ? { phase: 'candidate-generation', message: source }
      : { ...source, phase: 'candidate-generation' }
    const failure = prerequisite === undefined || baseFailure.prerequisite !== undefined
      ? baseFailure
      : refinementFailure(
          'candidate-generation',
          new ExternalMetaFailureError(baseFailure.message, prerequisite),
        )
    return {
      ...candidate,
      status: 'failed',
      failure,
      generationAttempts: candidate.generationAttempts.map(attempt => attempt.status !== 'running' ? attempt : {
        ...attempt,
        status: 'failed' as const,
        completedAt,
        failure,
      }),
    }
  })
}

export function resumableContextExecutions(
  round: RefinementRound,
  executions: readonly MetaExecutionState[],
): MetaExecutionState[] {
  return executions.filter(execution => execution.roundId === round.roundId
    && execution.candidateId !== undefined
    && execution.recovery !== undefined
    && execution.deadlineAt > Date.now()
    && (execution.status === 'rotating' || execution.status === 'running'
      && (execution.intent?.phase === 'activated' || execution.intent?.phase === 'delivered')))
}

export function hasContextRecoveryRoundStage(round: RefinementRound): boolean {
  return ['candidate-editing', 'preparing-candidate', 'baseline-running'].includes(round.status)
}

export function contextRecoveryOwnerMatches(
  round: RefinementRound,
  execution: MetaExecutionState,
  specDigest: string,
): boolean {
  return execution.specDigest === specDigest
    && round.candidatePool.some(candidate => candidate.candidateId === execution.candidateId
      && candidate.status === 'generating')
}

export function finalizationResolvers(): PromiseWithResolvers<FinalizationValue> {
  const value = Promise.withResolvers<FinalizationValue>()
  void value.promise.catch(() => {})
  return value
}

export function completionResolvers(): PromiseWithResolvers<void> {
  const value = Promise.withResolvers<void>()
  void value.promise.catch(() => {})
  return value
}

export function normalizeFocus(values: readonly SemanticTarget[] | undefined): SemanticTarget[] | undefined {
  return values === undefined || values.length === 0 ? undefined : [...new Set(values)]
}

export function validateCount(rounds: number): number {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new TypeError('rounds must be an integer between 1 and 100')
  return rounds
}

export function normalizeEvaluationRerunSelector(selector: EvaluationRerunSelector): EvaluationRerunSelector {
  if (typeof selector !== 'object' || selector === null || Array.isArray(selector)) {
    throw new TypeError('evaluation rerun selector must be an object')
  }
  if (selector.mode === 'invalid') return { mode: 'invalid' }
  if (selector.mode !== 'tasks' || !Array.isArray(selector.taskNames)
    || selector.taskNames.length === 0
    || selector.taskNames.some(task => typeof task !== 'string' || task.trim().length === 0)) {
    throw new TypeError('task evaluation rerun requires at least one non-empty task name')
  }
  return { mode: 'tasks', taskNames: [...new Set(selector.taskNames)] }
}
