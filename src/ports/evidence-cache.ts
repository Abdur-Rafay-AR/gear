import type { TrialResult } from './project.js'

export interface CachedTrial {
  identity: string
  runId: string
  operationId: string
  result: TrialResult
}
export interface EvidenceCache {
  find(identity: string): Promise<CachedTrial | undefined>
  save(trial: CachedTrial): Promise<void>
}
