import { readFile } from 'node:fs/promises'
import { canonicalDigest } from '../../domain/canonical.js'
import { validateArtifactPath } from '../../domain/mutation-policy.js'
import type { HarnessAdapter } from '../../ports/harness.js'
import type { TargetSnapshot } from '../../ports/project.js'
import { GitSnapshots } from '../storage/git-snapshots.js'
import { gitSourceCheckout } from '../storage/git-source.js'

const carrierAssets = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'build-carrier.mjs']
const nativeAssets = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'run.mjs', 'dsh-policy.mjs']
export interface HitchCarrierRevision {
  /** Stable transport directory. Read this candidate by commit, never by the checked-out HEAD. */
  repository: string
  commit: string
  identity: string
  targetDigest: string
}

/** Fixed build assets plus validated Target resources; no task/verifier resources or credentials. */
export class HitchCarrier {
  private constructor(
    readonly root: string,
    readonly adapter: HarnessAdapter,
    readonly files: Readonly<Record<string, string>>,
    readonly identity: string,
  ) {}
  static async create(root: string, adapter: HarnessAdapter): Promise<HitchCarrier> {
    const files: Record<string, string> = {}
    for (const name of carrierAssets)
      files[name] = await readFile(new URL(`../../../assets/hitch-carrier/${name}`, import.meta.url), 'utf8')
    for (const name of nativeAssets)
      files[`native/${name}`] = await readFile(
        new URL(`../../../assets/native-runtime/${name}`, import.meta.url),
        'utf8',
      )
    files['native/hitch-entry.mjs'] = await readFile(
      new URL('../../../assets/hitch-carrier/hitch-entry.mjs', import.meta.url),
      'utf8',
    )
    return new HitchCarrier(
      root,
      adapter,
      Object.freeze(files),
      canonicalDigest({ version: 1, files, adapter: adapter.ref, policy: adapter.mutationPolicy }),
    )
  }
  async prepare(target: TargetSnapshot): Promise<HitchCarrierRevision> {
    const resources: Record<string, string> = {}
    for (const [path, text] of Object.entries(target.files)) {
      validateArtifactPath(path, this.adapter.mutationPolicy)
      resources[`target/${path}`] = text
    }
    const targetDigest = canonicalDigest(target.files)
    if (target.digest !== targetDigest) throw new TypeError('hitch-carrier-target-digest-mismatch')
    const files = {
      ...this.files,
      ...resources,
      'carrier.json': `${JSON.stringify({ version: 1, targetDigest, runtime: this.identity, adapter: this.adapter.ref })}\n`,
    }
    const identity = canonicalDigest(files)
    const snapshots = new GitSnapshots(this.root)
    const commit = await snapshots.publish(files, identity)
    // Target changes must not change Hitch's repositoryPath comparison condition.
    // This anchor contains only fixed build assets; every candidate is selected by its exact OID.
    const anchor = await snapshots.publish({ ...this.files }, canonicalDigest(this.files))
    return { repository: await gitSourceCheckout(this.root, anchor), commit, identity, targetDigest }
  }
}
