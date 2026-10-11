import { createHash } from 'node:crypto'
import { canonicalDigest } from '../../domain/canonical.js'
import type { TargetManifest } from '../../domain/harness.js'
import type { HarnessAdapter } from '../../ports/harness.js'
import type { TargetSnapshot } from '../../ports/project.js'
import { GitSnapshots } from './git-snapshots.js'

/** Immutable, content-addressed Git objects; independent of the user's checkout. */
export class TargetSnapshots {
  constructor(
    readonly root: string,
    readonly adapter: HarnessAdapter,
    readonly runtimeIdentity: string,
  ) {}
  async seal(snapshot: TargetSnapshot, parent?: TargetSnapshot): Promise<TargetSnapshot> {
    const artifacts = Object.entries(snapshot.files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, text]) => ({
        path,
        bytes: Buffer.byteLength(text),
        digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      }))
    const body = {
      schemaVersion: 2 as const,
      baseRef: parent?.manifest?.baseRef ?? this.runtimeIdentity,
      ...(parent?.gitRef ? { parentRef: parent.gitRef } : {}),
      adapterRef: this.adapter.ref,
      runtimeIdentity: this.runtimeIdentity,
      mutationPolicyDigest: canonicalDigest(this.adapter.mutationPolicy),
      toolchainRef: 'gear-native-runtime@1',
      sandboxProfileRef: 'gear-docker@1',
      artifacts,
    }
    const manifest: TargetManifest = { ...body, digest: canonicalDigest(body) }
    const gitRef = await new GitSnapshots(this.root).publish(
      { ...snapshot.files, 'manifest.json': `${JSON.stringify(manifest)}\n` },
      manifest.digest,
      parent?.gitRef,
    )
    return { ...snapshot, gitRef, manifest }
  }
}
