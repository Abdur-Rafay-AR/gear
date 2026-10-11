import type { BenchmarkTask } from '../domain/benchmark.js'
import type { HarborTask, HarborVerification } from '../domain/harbor.js'
import type { TargetManifest } from '../domain/harness.js'
import type { WorkplanDelivery } from '../domain/workplan.js'
import type { DiagnosisProvider } from './diagnosis.js'
export interface TargetSnapshot {
  id: string
  gitRef?: string
  manifest?: TargetManifest
  digest: string
  files: Record<string, string>
}
export interface TrialResult {
  /** Produced by the trusted verifier runner, never by Target/model output. */
  verification?: HarborVerification
  status: 'completed' | 'task-failed' | 'scorer-failed' | 'infrastructure-failed'
  output?: string
  physicalAttempts: number
  reason?: string
}
export interface EvaluationInput {
  operationId: string
  task: Pick<BenchmarkTask, 'id' | 'instruction' | 'inputs'> & { outputPath: string; harbor?: HarborTask }
  target: TargetSnapshot
}
export interface GenerationInput {
  operationId: string
  parent: TargetSnapshot
  seed: Array<{ id: string; instruction: string; score: number | null }>
  diagnosis?: Record<string, unknown>
  diagnosisId?: string
  delivery?: WorkplanDelivery
}
export interface ProjectProvider {
  readonly identity: string
  readonly diagnosis?: DiagnosisProvider
  readonly capabilities: {
    meteredAttempts: true
    recovery: true
    isolatedTarget: true
    isolatedMeta: true
    /** The runner preserves task environments and withholds tests/solution/reward writes from Target and Meta. */
    harborVerification?: true
  }
  evaluate(input: EvaluationInput, signal: AbortSignal): Promise<TrialResult>
  inspectEvaluation(operationId: string, signal: AbortSignal): Promise<TrialResult | undefined>
  generate(input: GenerationInput, signal: AbortSignal): Promise<Record<string, string>>
  inspectGeneration(operationId: string, signal: AbortSignal): Promise<Record<string, string> | undefined>
  cancel(operationId: string, signal: AbortSignal): Promise<void>
}
