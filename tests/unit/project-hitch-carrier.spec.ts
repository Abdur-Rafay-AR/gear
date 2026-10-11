import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { dshTarget } from '../../src/adapters/dsh/target.js'
import { HitchCarrier } from '../../src/adapters/hitch/carrier.js'
import { piTarget } from '../../src/adapters/pi/target.js'
import { GitSnapshots } from '../../src/adapters/storage/git-snapshots.js'
import { targetFiles } from '../../src/application/target-files.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const execute = promisify(execFile)
const roots: string[] = []
async function temporary() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-hitch-carrier-')))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([dshTarget, piTarget])(
  'freezes $ref native assets and Target resources into a deterministic Git carrier',
  async (adapter) => {
    const root = await temporary()
    await adapter.prepare(join(root, 'input'))
    const files = await targetFiles(join(root, 'input'), adapter)
    const target = { id: 'candidate', files, digest: canonicalDigest(files) }
    const carrier = await HitchCarrier.create(join(root, 'objects.git'), adapter)
    const revision = await carrier.prepare(target)
    const other = await HitchCarrier.create(join(root, 'other.git'), adapter)
    expect((await other.prepare({ ...target, id: 'different-run' })).commit).toBe(revision.commit)
    const args = ['-C', revision.repository, 'show']
    for (const [path, content] of Object.entries(files))
      expect((await execute('git', [...args, `${revision.commit}:target/${path}`])).stdout).toBe(content)
    for (const name of ['run.mjs', 'pnpm-lock.yaml', 'package.json'])
      expect((await execute('git', [...args, `${revision.commit}:native/${name}`])).stdout).toBe(
        await readFile(new URL(`../../assets/native-runtime/${name}`, import.meta.url), 'utf8'),
      )
    const metadata = JSON.parse((await execute('git', [...args, `${revision.commit}:carrier.json`])).stdout)
    expect(metadata).toEqual({
      version: 1,
      targetDigest: target.digest,
      runtime: carrier.identity,
      adapter: adapter.ref,
    })
    const changed = { ...files, [adapter === piTarget ? 'AGENTS.md' : 'prompts/system.md']: 'Changed policy' }
    const next = await carrier.prepare({ ...target, files: changed, digest: canonicalDigest(changed) })
    expect(next.commit).not.toBe(revision.commit)
    expect(next.repository).toBe(revision.repository)
    // An already-returned source can read future candidates without changing its HEAD.
    expect((await execute('git', [...args, `${next.commit}:target/${Object.keys(changed)[0]}`])).stdout).toBe(
      changed[Object.keys(changed)[0]!],
    )
    expect((await execute('git', ['-C', revision.repository, 'ls-tree', '--name-only', 'HEAD'])).stdout).not.toContain(
      'target',
    )
    const restarted = await HitchCarrier.create(carrier.root, adapter)
    expect(await restarted.prepare(target)).toEqual(revision)
    expect(await restarted.prepare({ ...target, files: changed, digest: canonicalDigest(changed) })).toEqual(next)
    await expect(carrier.prepare({ ...target, files: changed })).rejects.toThrow('digest-mismatch')
    const forbidden = { ...files, 'auth.json': 'secret' }
    await expect(carrier.prepare({ ...target, files: forbidden, digest: canonicalDigest(forbidden) })).rejects.toThrow()
    expect(Object.keys(carrier.files).some((path) => /tests\/|solution\/|credential|auth\.json/.test(path))).toBe(false)
    await writeFile(join(revision.repository, 'unexpected'), 'private')
    await expect(carrier.prepare(target)).rejects.toThrow('source-conflict')
    expect(await readFile(join(revision.repository, 'unexpected'), 'utf8')).toBe('private')
  },
)

it('shares one fixed source across simultaneous candidates without replacing their contents', async () => {
  const root = await temporary()
  const carrier = await HitchCarrier.create(join(root, 'objects.git'), piTarget)
  const targets = ['first', 'second'].map((content) => ({
    id: content,
    files: { 'AGENTS.md': content },
    digest: canonicalDigest({ 'AGENTS.md': content }),
  }))
  const revisions = await Promise.all(targets.map((target) => carrier.prepare(target)))
  expect(revisions[0]!.repository).toBe(revisions[1]!.repository)
  for (const [index, revision] of revisions.entries()) {
    expect(
      (await execute('git', ['-C', revision.repository, 'show', `${revision.commit}:target/AGENTS.md`])).stdout,
    ).toBe(targets[index]!.id)
  }
  expect((await execute('git', ['-C', revisions[0]!.repository, 'status', '--porcelain'])).stdout).toBe('')
})

it.each(['head', 'repository', 'symlink', 'root-symlink', 'metadata-link'] as const)(
  'refuses %s drift without repairing or overwriting it',
  async (kind) => {
    const root = await temporary()
    const carrier = await HitchCarrier.create(join(root, 'objects.git'), piTarget)
    const target = { id: 'first', files: { 'AGENTS.md': 'first' }, digest: canonicalDigest({ 'AGENTS.md': 'first' }) }
    const revision = await carrier.prepare(target)
    if (kind === 'head') {
      await execute('git', ['-C', revision.repository, 'checkout', '--detach', revision.commit])
    } else if (kind === 'repository') {
      const foreign = join(root, 'foreign')
      await execute('git', ['init', '--quiet', foreign])
      await writeFile(join(revision.repository, '.git'), `gitdir: ${join(foreign, '.git')}\n`)
    } else if (kind === 'metadata-link') {
      await rename(join(revision.repository, '.git'), join(root, 'metadata'))
      await symlink(join(root, 'metadata'), join(revision.repository, '.git'))
    } else {
      const outside = join(root, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'canary'), 'preserve')
      const changed = kind === 'root-symlink' ? dirname(revision.repository) : revision.repository
      await rename(changed, `${changed}.original`)
      await symlink(outside, changed)
    }
    await expect(carrier.prepare(target)).rejects.toThrow('source-conflict')
    if (kind === 'head')
      expect((await execute('git', ['-C', revision.repository, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(
        revision.commit,
      )
    else if (kind === 'repository')
      expect(await readFile(join(revision.repository, '.git'), 'utf8')).toBe(`gitdir: ${join(root, 'foreign/.git')}\n`)
    else if (kind === 'metadata-link') expect(await readFile(join(root, 'metadata'), 'utf8')).toContain('gitdir: ')
    else expect(await readFile(join(root, 'outside/canary'), 'utf8')).toBe('preserve')
  },
)

it.each([
  { a: '', 'a/b': '' },
  { '../escape': '' },
  { '/absolute': '' },
  { 'a/.GiT/config': '' },
  { 'a\\b': '' },
  { 'a//b': '' },
  { 'a/./b': '' },
  { 'a/../b': '' },
  { 'a\0b': '' },
])('rejects malformed Git trees before creating storage: %j', async (files) => {
  const root = await temporary()
  await expect(new GitSnapshots(join(root, 'objects.git')).publish(files, canonicalDigest(files))).rejects.toThrow()
  await expect(readFile(join(root, 'objects.git/HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
})

async function wrapper(adapter: string) {
  const root = await temporary()
  await mkdir(join(root, 'native'))
  await writeFile(
    join(root, 'native/hitch-entry.mjs'),
    await readFile(new URL('../../assets/hitch-carrier/hitch-entry.mjs', import.meta.url)),
  )
  await writeFile(
    join(root, 'entry.mjs'),
    `import {runHitchNative} from './native/hitch-entry.mjs'; await runHitchNative(${JSON.stringify(adapter)})`,
  )
  // The adapter translation contract has no native dependencies, credentials, or model calls.
  await writeFile(
    join(root, 'native/run.mjs'),
    `export async function runNative(adapter,model,prompt,options) {
    process.stdout.write(JSON.stringify({adapter,model,prompt,target:options.target,runtimeHome:options.runtimeHome,flags:process.execArgv})+'\\n');
    options.onEvent?.({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok'}]}});
  }`,
  )
  return { root, entry: join(root, 'entry.mjs') }
}
async function invoke(entry: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}
it.each(['pi', 'dsh'])('reports the %s version without credentials or loading the model', async (adapter) => {
  const { entry } = await wrapper(adapter)
  const result = await invoke(entry, ['--version'], '', { DSH_OPENAI_CODEX_ACCESS_B64: '' })
  expect(result.code).toBe(0)
  expect(result.stdout.trim()).toBe(adapter === 'pi' ? '0.68.0' : '0.1.1-rc.2')
})
it('preserves the Pi prompt and emits native JSON events', async () => {
  const { entry, root } = await wrapper('pi')
  const prompt = '--literal\n题目\n'
  const result = await invoke(entry, ['--mode', 'json', '--no-session', '--model', 'gpt-5.6-luna'], prompt)
  expect(result.code).toBe(0)
  const [call, event] = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(call).toMatchObject({ adapter: 'pi', model: 'gpt-5.6-luna', prompt, target: join(root, 'target') })
  expect(event.type).toBe('message_end')
})
it('preserves the DSH prompt, uses its observed runtime home, and enables native internals', async () => {
  const { entry, root } = await wrapper('dsh')
  const prompt = '--literal\n题目\n'
  const result = await invoke(
    entry,
    ['--profile', 'headless', '--gear-model=gpt-5.6-luna', '--patch', 'unread-patch', '--', '--', prompt],
    '',
    { DSH_HOME: join(root, 'home') },
  )
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    adapter: 'dsh',
    model: 'gpt-5.6-luna',
    prompt,
    target: join(root, 'target'),
    runtimeHome: join(root, 'home'),
    flags: ['--expose-internals'],
  })
})
it('rejects oversized stdin and unexpected adapter arguments without invoking the native runtime', async () => {
  const { entry } = await wrapper('pi')
  for (const [args, input] of [
    [['--mode', 'json', '--no-session', '--model', 'gpt-5.6-luna'], 'x'.repeat(1024 * 1024 + 1)],
    [['--mode', 'json', '--no-session', '--model', 'gpt-5.6-luna', '--extension', '/private/extra'], 'task'],
  ] as const) {
    const result = await invoke(entry, [...args], input)
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
  }
})

it('forwards DSH cancellation to the native child and propagates its exit', async () => {
  const { entry, root } = await wrapper('dsh')
  await writeFile(
    join(root, 'native/run.mjs'),
    `export async function runNative() {
    const timer=setInterval(()=>{},1000);
    process.once('SIGTERM',()=>{clearInterval(timer); process.exit(23)});
    process.stdout.write('READY\\n');
    await new Promise(()=>{});
  }`,
  )
  const child = spawn(
    process.execPath,
    [entry, '--profile', 'headless', '--gear-model=gpt-5.6-luna', '--patch', 'unused', '--', '--', 'task'],
    {
      env: { ...process.env, DSH_HOME: join(root, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  child.stderr.resume()
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native child did not start')), 5000)
      child.stdout.once('data', () => {
        clearTimeout(timer)
        resolve()
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    child.kill('SIGTERM')
    expect(await closed).toBe(23)
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
  }
}, 10000)
