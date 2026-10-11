/** Stable v1 ports for project integrations. Runtime state is intentionally private. */

export { dshTarget } from './adapters/dsh/target.js'
export { compileHarbor } from './adapters/hitch/benchmark.js'
export { piTarget } from './adapters/pi/target.js'
export { loadBenchmark } from './application/benchmark.js'
export { ProjectApplication } from './application/project.js'
export { scoreOutput } from './application/scoring.js'
export type { AlgorithmDecision, AlgorithmOperation, AlgorithmWorker, SearchView } from './domain/algorithm.js'
export type { BenchmarkSpec, BenchmarkTask, Score, Scorer, Split } from './domain/benchmark.js'
export type {
  DiagnosisFact,
  DiagnosisInput,
  DiagnosisObservation,
  DiagnosisResult,
  DiagnosisUsage,
} from './domain/diagnosis.js'
export { GearError, GenerationFailed } from './domain/errors.js'
export { MutationValidationError } from './domain/harness.js'
export type { DiagnosisProvider, DiagnosisRecovery } from './ports/diagnosis.js'
export type { HarnessAdapter, HarnessDescription, HarnessExecutionSpec, MutationPolicy } from './ports/harness.js'
export type { EvaluationInput, GenerationInput, ProjectProvider, TargetSnapshot, TrialResult } from './ports/project.js'
