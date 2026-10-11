import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { canonicalDigest } from '../../domain/canonical.js'
import type { TargetManifest } from '../../domain/harness.js'
import type { HarnessAdapter } from '../../ports/harness.js'
import type { TargetSnapshot } from '../../ports/project.js'
import { withFileLock } from './file-lock.js'

/** Immutable, content-addressed Git objects; independent of the user's checkout. */
export class TargetSnapshots {
  constructor(
    readonly root: string,
    readonly adapter: HarnessAdapter,
    readonly runtimeIdentity: string,
  ) {}
  private git(args: string[], input = ''): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['--git-dir', this.root, ...args], {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Gear',
          GIT_AUTHOR_EMAIL: 'gear@localhost',
          GIT_COMMITTER_NAME: 'Gear',
          GIT_COMMITTER_EMAIL: 'gear@localhost',
          GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = '',
        error = ''
      child.stdout.on('data', (value) => {
        output += value
      })
      child.stderr.on('data', (value) => {
        error += value
      })
      child.stdin.on('error', () => {})
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0 ? resolve(output.trim()) : reject(new Error(`Git snapshot failed: ${error.trim()}`)),
      )
      child.stdin.end(input)
    })
  }
  async seal(snapshot: TargetSnapshot, parent?: TargetSnapshot): Promise<TargetSnapshot> {
    return withFileLock(`${this.root}.lock`, async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await this.git(['init', '--bare', '--quiet'])
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
      const entries = Object.entries({ ...snapshot.files, 'manifest.json': `${JSON.stringify(manifest)}\n` })
      const tree = async (prefix: string): Promise<string> => {
        const names = [
          ...new Set(entries.filter(([p]) => p.startsWith(prefix)).map(([p]) => p.slice(prefix.length).split('/')[0]!)),
        ].sort()
        const records: string[] = []
        for (const name of names) {
          const file = entries.find(([p]) => p === prefix + name)
          if (file) records.push(`100644 blob ${await this.git(['hash-object', '-w', '--stdin'], file[1])}\t${name}\0`)
          else records.push(`040000 tree ${await tree(`${prefix}${name}/`)}\t${name}\0`)
        }
        return this.git(['mktree', '-z'], records.join(''))
      }
      const gitRef = await this.git(
        ['commit-tree', await tree(''), ...(parent?.gitRef ? ['-p', parent.gitRef] : [])],
        manifest.digest,
      )
      await this.git(['update-ref', `refs/gear/${manifest.digest.slice(7)}`, gitRef])
      return { ...snapshot, gitRef, manifest }
    })
  }
}
