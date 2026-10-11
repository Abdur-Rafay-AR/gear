export interface CandidateView {
  id: string
  scores: Record<string, number>
}
export interface SearchView {
  seed_tasks: string[]
  candidates: CandidateView[]
  champion: string
  max_candidates: number
  remaining_evaluations: number
  random_seed: string
  completed: Record<string, Record<string, unknown>>
  task_families?: Record<string, string>
}
export interface AlgorithmOperation {
  kind: 'diagnose_seed' | 'generate' | 'evaluate_seed' | 'nominate' | 'stop'
  candidate: string
  tasks: string[]
  parent: string
}
export interface AlgorithmDecision {
  state: Record<string, unknown>
  operations: AlgorithmOperation[]
  reason: string
}
export interface AlgorithmWorker {
  readonly identity: string
  step(
    view: SearchView,
    state: Record<string, unknown>,
    context: { runId: string; stepId: number },
    signal: AbortSignal,
  ): Promise<AlgorithmDecision>
}
