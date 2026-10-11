import type { DiagnosisInput, DiagnosisResult } from '../domain/diagnosis.js'

export type DiagnosisRecovery =
  | { status: 'pending' }
  | { status: 'not-started' }
  | { status: 'complete'; result: DiagnosisResult }

/** Host-owned metering. Only a definitive not-started inspection permits submission after recovery. */
export interface DiagnosisProvider {
  readonly identity: string
  readonly capabilities: { boundedRequests: true; boundedTokens: true; recovery: true; isolated: true }
  diagnose(input: DiagnosisInput, signal: AbortSignal): Promise<DiagnosisResult>
  inspectDiagnosis(operationId: string, signal: AbortSignal): Promise<DiagnosisRecovery>
  cancel(operationId: string, signal: AbortSignal): Promise<void>
}
