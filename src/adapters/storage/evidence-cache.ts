import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import type { CachedTrial, EvidenceCache } from '../../ports/evidence-cache.js'
import { atomicJSON } from './atomic.js'
import { withFileLock } from './file-lock.js'

export class ProjectEvidenceCache implements EvidenceCache {
  constructor(readonly root: string) {}
  private path(identity: string): string {
    if (!/^sha256:[a-f0-9]{64}$/u.test(identity)) throw new Error('invalid-evidence-identity')
    return join(this.root, `${identity.slice(7)}.json`)
  }
  async find(identity: string): Promise<CachedTrial | undefined> {
    try {
      const { digest, trial } = JSON.parse(await readFile(this.path(identity), 'utf8')) as {
        digest: string
        trial: CachedTrial
      }
      if (trial.identity !== identity || canonicalDigest(trial) !== digest) throw new Error('cached-evidence-integrity')
      return trial
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  async save(trial: CachedTrial): Promise<void> {
    // First observation owns the slot, including a valid zero. Never select the
    // best outcome from concurrent runs or replace it with a later retry.
    await withFileLock(`${this.path(trial.identity)}.lock`, async () => {
      if (!(await this.find(trial.identity)))
        await atomicJSON(this.path(trial.identity), { trial, digest: canonicalDigest(trial) })
    })
  }
}
