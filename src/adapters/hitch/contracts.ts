import type { EvaluationTrialScores, FailedEvaluationEvidence } from '../../types.js'

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface HitchEvaluationIdentity {
  provider: 'hitch-cli'
  effectiveConfigDigest: string
  invocationFingerprint: string
}

export type JsonRecord = Record<string, unknown>

export interface ParsedRunTrial {
  originalResult: import('@deepseek-ai/dsh-session').JsonValue
  taskName: string
  trialName: string
  runId: string
  attempt: number
  observationStatus: 'valid' | 'invalid'
  reward?: number
  scores?: EvaluationTrialScores
  invalidReason?: string
}

export class HitchEvaluationError extends Error {
  constructor(
    message: string,
    readonly code = 'hitch_evaluation_failed',
    readonly failedEvidence?: FailedEvaluationEvidence,
  ) {
    super(message)
    this.name = 'HitchEvaluationError'
  }
}
