/** Stable Target contracts. These contain no evaluator or runtime implementation. */
export interface HarnessArtifact {
  path: string
  digest: string
  bytes: number
}
export interface LegacyHarnessManifest {
  schemaVersion: 1
  parentRef?: string
  dshBaseRef: string
  toolchainRef: string
  sandboxProfileRef: string
  artifacts: HarnessArtifact[]
  digest: string
}
export interface TargetManifest {
  schemaVersion: 2
  parentRef?: string
  baseRef: string
  adapterRef: string
  runtimeIdentity: string
  mutationPolicyDigest: string
  toolchainRef: string
  sandboxProfileRef: string
  artifacts: HarnessArtifact[]
  digest: string
}
export type HarnessManifest = LegacyHarnessManifest | TargetManifest

export class MutationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MutationValidationError'
  }
}
export class SubstrateExpansionError extends MutationValidationError {
  constructor(message: string) {
    super(message)
    this.name = 'SubstrateExpansionError'
  }
}
