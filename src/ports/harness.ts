export interface MutationPolicy {
  readonly roots: readonly string[]
  readonly protectedNames: readonly string[]
  readonly allowedImports: readonly string[]
}
export interface HarnessDescription {
  id: string
  version: number
  resources: readonly string[]
  guidance: string
}
export interface HarnessExecutionSpec {
  command: string
  args: string[]
  env: Record<string, string>
}
/** Target resources and loading only; scheduling, Git and state belong to Gear. */
export interface HarnessAdapter {
  readonly ref: string
  readonly mutationPolicy: MutationPolicy
  describe(): HarnessDescription
  prepare(root: string): Promise<void>
  check(root: string): Promise<void>
  executionSpec(root: string, model: string): HarnessExecutionSpec
}
