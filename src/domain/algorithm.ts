import type { AlgorithmDecision, SearchView } from './algorithm-protocol.js'

export type { AlgorithmDecision, AlgorithmOperation, CandidateView, SearchView } from './algorithm-protocol.js'
export interface AlgorithmWorker {
  readonly identity: string
  step(
    view: SearchView,
    state: Record<string, unknown>,
    context: { runId: string; stepId: number },
    signal: AbortSignal,
  ): Promise<AlgorithmDecision>
}
