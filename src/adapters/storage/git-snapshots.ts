import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { withFileLock } from './file-lock.js'

/** Publish immutable Git objects without checking out or changing a user's working tree. */
export class GitSnapshots {
  constructor(readonly root: string) {}
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
  async publish(
    files: Record<string, string>,
    identity: string,
    parent?: string,
    executablePaths: readonly string[] = [],
  ): Promise<string> {
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(identity) ||
      (parent !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(parent))
    )
      throw new TypeError('invalid-git-snapshot-identity')
    const paths = new Set(Object.keys(files))
    const executables = new Set(executablePaths)
    if (executables.size !== executablePaths.length || executablePaths.some((path) => !paths.has(path)))
      throw new TypeError('invalid-git-snapshot-executables')
    for (const [path, content] of Object.entries(files)) {
      if (typeof content !== 'string') throw new TypeError('invalid-git-snapshot-content')
      if (
        path.includes('\\') ||
        path.includes('\0') ||
        path.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
      )
        throw new TypeError('invalid-git-snapshot-path')
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++)
        if (paths.has(parts.slice(0, i).join('/'))) throw new TypeError('git-snapshot-path-collision')
    }
    return withFileLock(`${this.root}.lock`, async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await this.git(['init', '--bare', '--quiet'])
      const entries = Object.entries(files)
      const tree = async (prefix: string): Promise<string> => {
        const names = [
          ...new Set(entries.filter(([p]) => p.startsWith(prefix)).map(([p]) => p.slice(prefix.length).split('/')[0]!)),
        ].sort()
        const records: string[] = []
        for (const name of names) {
          const file = entries.find(([p]) => p === prefix + name)
          if (file)
            records.push(
              `${executables.has(file[0]) ? '100755' : '100644'} blob ${await this.git(['hash-object', '-w', '--stdin'], file[1])}\t${name}\0`,
            )
          else records.push(`040000 tree ${await tree(`${prefix}${name}/`)}\t${name}\0`)
        }
        return this.git(['mktree', '-z'], records.join(''))
      }
      const commit = await this.git(['commit-tree', await tree(''), ...(parent ? ['-p', parent] : [])], identity)
      await this.git(['update-ref', `refs/gear/${identity.slice(7)}`, commit])
      return commit
    })
  }
}
