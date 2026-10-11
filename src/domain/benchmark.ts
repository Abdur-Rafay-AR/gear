export type Split = 'seed' | 'held_out'
export type Scorer =
  | { kind: 'text'; expected: string; normalization: 'exact' | 'trim' }
  | { kind: 'json'; expected: Record<string, unknown> }
  | { kind: 'file'; path: string; expected: string; normalization: 'exact' | 'trim' }
export interface TaskInput {
  path: string
  base64: string
  digest: string
}
export interface BenchmarkTask {
  inputs?: TaskInput[]
  id: string
  instruction: string
  family: string
  split: Split
  scorer: Scorer
  fixtures: { positive: string; negative: string }
}
export interface BenchmarkSpec {
  version: 1
  sourceDigest: string
  tasks: BenchmarkTask[]
  metric: { name: 'pass_rate'; direction: 'maximize'; range: [0, 1]; missing: 'invalid' }
  digest: string
}
export interface Score {
  valid: boolean
  value?: number
  reason?: string
}
