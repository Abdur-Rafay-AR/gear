import { readFile } from 'node:fs/promises'
import { canonicalDigest } from '../../domain/canonical.js'
import { validateArtifactPath } from '../../domain/mutation-policy.js'
import type { HarnessAdapter } from '../../ports/harness.js'
import type { TargetSnapshot } from '../../ports/project.js'
import { snapshotCheckout } from '../storage/git-checkout.js'
import { GitSnapshots } from '../storage/git-snapshots.js'

const carrierAssets = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'build-carrier.mjs']
const nativeAssets = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'run.mjs', 'dsh-policy.mjs']
export interface HitchCarrierRevision {
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
    const commit = await new GitSnapshots(this.root).publish(files, identity)
    return { repository: await snapshotCheckout(this.root, commit), commit, identity, targetDigest }
  }
}
