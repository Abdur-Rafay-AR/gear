import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { prepareHarborRuntime } from '../../src/adapters/hitch/harbor-runtime.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const installation = {
  harborVersion: '0.21.0',
  harborSource: canonicalDigest('Harbor fixture'),
  pythonVersion: '3.12.0',
  pythonBinary: canonicalDigest('Python fixture'),
  platform: process.platform,
  architecture: process.arch,
}
async function fixture(value: unknown = installation) {
  const root = await mkdtemp(join(tmpdir(), 'gear-harbor-runtime-'))
  roots.push(root)
  const python = join(root, "interpreter with 'quotes' and spaces")
  await writeFile(
    python,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--gear-runtime-inspect')) process.stdout.write(${JSON.stringify(JSON.stringify(value))});
else {process.stdout.write(JSON.stringify({pid:process.pid,args})); if(args.includes('wait')) {setInterval(()=>{},1000); await new Promise(()=>{});}}
`,
    { mode: 0o755 },
  )
  return { root, python, repository: join(root, 'runtime.git') }
}

it('seals the interpreter, package identity and mandatory guard into an executable snapshot', async () => {
  const f = await fixture()
  const first = await prepareHarborRuntime(f.repository, f.python, AbortSignal.timeout(10000))
  expect(first.environment).toEqual({ HITCH_HARBOR_PATH: first.executable, HITCH_HARBOR_PYTHON_PATH: f.python })
  expect(first.installation).toEqual(installation)
  expect(await prepareHarborRuntime(f.repository, f.python, AbortSignal.timeout(10000))).toEqual(first)
  const other = await prepareHarborRuntime(join(f.root, 'other.git'), f.python, AbortSignal.timeout(10000))
  expect(other.identity).toBe(first.identity)
  expect(other.executable).not.toBe(first.executable)
  const result = await execute(first.executable, ['run', '--config', 'path with spaces.json'])
  expect(JSON.parse(result.stdout).args.slice(-3)).toEqual(['run', '--config', 'path with spaces.json'])
  expect(JSON.parse(JSON.parse(result.stdout).args[3])).toEqual(installation)
  expect((await execute('git', ['-C', dirname(first.executable), 'ls-files', '--stage', 'harbor'])).stdout).toMatch(
    /^100755 /,
  )
  expect((await execute('git', ['-C', dirname(first.executable), 'status', '--porcelain', '--ignored'])).stdout).toBe(
    '',
  )
})

it('replaces the launcher PID and leaves cancellation attached to the same process', async () => {
  const f = await fixture()
  const runtime = await prepareHarborRuntime(f.repository, f.python, AbortSignal.timeout(10000))
  const child = spawn(runtime.executable, ['run', 'wait'], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.resume()
  try {
    const output = await new Promise<string>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.once('data', (chunk) => resolve(String(chunk)))
    })
    expect(JSON.parse(output).pid).toBe(child.pid)
    const stopped = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    child.kill('SIGTERM')
    expect(await stopped).toEqual({ code: null, signal: 'SIGTERM' })
  } finally {
    child.kill('SIGKILL')
  }
})

it.each(['launch.mjs', 'harbor_cli.py', 'gear_harbor_artifacts.py'] as const)(
  'rejects %s drift on invocation and during recovery without overwriting it',
  async (name) => {
    const f = await fixture()
    const runtime = await prepareHarborRuntime(f.repository, f.python, AbortSignal.timeout(10000))
    const path = join(dirname(runtime.executable), name)
    // Replacing a sibling with executable code must fail before that code runs.
    const content = name.endsWith('.mjs')
      ? 'throw new Error("UNVERIFIED_CODE_RAN")\n'
      : 'raise RuntimeError("UNVERIFIED_CODE_RAN")\n'
    await writeFile(path, content)
    await expect(execute(runtime.executable, ['--version'])).rejects.toThrow('asset-digest-mismatch')
    await expect(prepareHarborRuntime(f.repository, f.python, AbortSignal.timeout(10000))).rejects.toThrow(
      'checkout-conflict',
    )
    expect(await readFile(path, 'utf8')).toBe(content)
  },
)

it('rejects a linked guard and preserves the linked file', async () => {
  const f = await fixture()
  const runtime = await prepareHarborRuntime(f.repository, f.python, AbortSignal.timeout(10000))
  const guard = join(dirname(runtime.executable), 'gear_harbor_artifacts.py')
  const outside = join(f.root, 'outside.py')
  await writeFile(outside, await readFile(guard))
  await rm(guard)
  await symlink(outside, guard)
  await expect(execute(runtime.executable, ['--version'])).rejects.toThrow('asset-type-mismatch')
  expect(await readFile(outside, 'utf8')).toContain('ArtifactSafetyPlugin')
})

it('preserves a virtualenv interpreter shim instead of resolving to the base installation', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'venv/bin'), { recursive: true })
  const shim = join(f.root, 'venv/bin/python')
  await symlink(f.python, shim)
  const runtime = await prepareHarborRuntime(f.repository, shim, AbortSignal.timeout(10000))
  expect(runtime.python).toBe(shim)
  expect(runtime.environment.HITCH_HARBOR_PYTHON_PATH).toBe(shim)
})

it.each([{}, { ...installation, harborVersion: '0.22.0' }, { ...installation, pythonBinary: 'mutable' }])(
  'rejects unsupported installation metadata before writing a runtime: %j',
  async (value) => {
    const f = await fixture(value)
    await expect(prepareHarborRuntime(f.repository, f.python, AbortSignal.timeout(10000))).rejects.toThrow()
    await expect(readFile(join(f.repository, 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('does not execute a cancelled request or a relative interpreter command', async () => {
  const f = await fixture()
  await chmod(f.python, 0o644)
  await expect(prepareHarborRuntime(f.repository, f.python, AbortSignal.abort())).rejects.toThrow()
  await expect(prepareHarborRuntime(f.repository, 'python', AbortSignal.timeout(1000))).rejects.toThrow('absolute')
})
