import type { BenchmarkTask } from '../domain/benchmark.js'
import type { TargetManifest } from '../domain/harness.js'
export interface TargetSnapshot {
  id: string
  gitRef?: string
  manifest?: TargetManifest
  digest: string
  files: Record<string, string>
}
export interface TrialResult {
  status: 'completed' | 'task-failed' | 'scorer-failed' | 'infrastructure-failed'
  output?: string
  physicalAttempts: number
  reason?: string
}
export interface EvaluationInput {
  operationId: string
  task: Pick<BenchmarkTask, 'id' | 'instruction' | 'inputs'> & { outputPath: string }
  target: TargetSnapshot
}
export interface GenerationInput {
  operationId: string
  parent: TargetSnapshot
  seed: Array<{ id: string; instruction: string; score: number | null }>
  diagnosis?: Record<string, unknown>
  diagnosisId?: string
}
export interface ProjectProvider {
  readonly identity: string
  readonly capabilities: { meteredAttempts: true; recovery: true; isolatedTarget: true; isolatedMeta: true }
  evaluate(input: EvaluationInput, signal: AbortSignal): Promise<TrialResult>
  inspectEvaluation(operationId: string, signal: AbortSignal): Promise<TrialResult | undefined>
  generate(input: GenerationInput, signal: AbortSignal): Promise<Record<string, string>>
  inspectGeneration(operationId: string, signal: AbortSignal): Promise<Record<string, string> | undefined>
  cancel(operationId: string, signal: AbortSignal): Promise<void>
}
