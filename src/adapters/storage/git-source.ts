import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { withFileLock } from './file-lock.js'

const execute = promisify(execFile)

/** A fixed, clean transport source with access to future snapshots in the same owned object store. */
export async function gitSourceCheckout(repository: string, anchor: string): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(anchor)) throw new TypeError('invalid-git-snapshot-commit')
  repository = await realpath(repository)
  const root = `${repository}.sources`,
    destination = join(root, anchor)
  const git = async (args: string[]) =>
    (
      await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      })
    ).stdout.trim()
  // Share the publisher's lock; worktree registration and snapshot publication never race.
  return withFileLock(`${repository}.lock`, async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('hitch-carrier-source-conflict')
    try {
      const info = await lstat(destination)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('hitch-carrier-source-conflict')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A crash during creation leaves an inspectable conflict; never reset an existing tree.
      await git(['--git-dir', repository, 'worktree', 'add', '--quiet', '--detach', destination, anchor])
    }
    const metadata = await lstat(join(destination, '.git'))
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
      throw new Error('hitch-carrier-source-conflict')
    const common = await git(['-C', destination, 'rev-parse', '--git-common-dir'])
    if (
      (await realpath(resolve(destination, common))) !== repository ||
      (await git(['-C', destination, 'rev-parse', 'HEAD'])) !== anchor ||
      (await git(['-C', destination, 'status', '--porcelain', '--untracked-files=all', '--ignored']))
    )
      throw new Error('hitch-carrier-source-conflict')
    return realpath(destination)
  })
}
