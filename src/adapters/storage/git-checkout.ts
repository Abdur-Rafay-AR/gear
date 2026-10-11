import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { withFileLock } from './file-lock.js'

const execute = promisify(execFile)
/** Materialize an owned, immutable Git snapshot for tools requiring a working tree. */
export async function snapshotCheckout(repository: string, commit: string): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new TypeError('invalid-git-snapshot-commit')
  const root = `${repository}.checkouts`,
    destination = join(root, commit)
  const git = async (args: string[]) =>
    (
      await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      })
    ).stdout.trim()
  return withFileLock(`${destination}.lock`, async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    try {
      const info = await lstat(destination)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('hitch-carrier-checkout-conflict')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const stage = await mkdtemp(join(dirname(destination), '.preparing-'))
      try {
        await git(['clone', '--quiet', '--no-checkout', '--no-hardlinks', '--', repository, stage])
        await git(['-C', stage, 'checkout', '--quiet', '--detach', commit])
        await rename(stage, destination)
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
    }
    if (
      (await git(['-C', destination, 'rev-parse', 'HEAD'])) !== commit ||
      (await git(['-C', destination, 'status', '--porcelain', '--untracked-files=all', '--ignored']))
    )
      throw new Error('hitch-carrier-checkout-conflict')
    return destination
  })
}
