import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type DockerProfile, validateProfile } from '../adapters/docker/provider.js'
import { atomicJSON } from '../adapters/storage/atomic.js'

const execute = promisify(execFile)
export const gearHome = (): string => process.env.GEAR_HOME ?? join(homedir(), '.config/gear')
export interface Environment {
  python: string
  profiles: Record<string, DockerProfile>
}
export async function environment(): Promise<Environment> {
  const config = JSON.parse(await readFile(join(gearHome(), 'environment.json'), 'utf8')) as { python: string }
  const profiles = JSON.parse(await readFile(join(gearHome(), 'profiles.json'), 'utf8')) as Record<
    string,
    DockerProfile
  >
  return { python: config.python, profiles }
}
async function supportedPython(): Promise<string> {
  for (const command of process.env.GEAR_PYTHON
    ? [process.env.GEAR_PYTHON]
    : ['python3.12', 'python3.11', 'python3.13', 'python3']) {
    try {
      const result = await execute(
        command,
        ['-c', 'import sys; assert sys.version_info >= (3,10); print(sys.executable)'],
        { timeout: 10_000 },
      )
      return result.stdout.trim()
    } catch {
      /* Try the next supported interpreter before reporting a missing prerequisite. */
    }
  }
  throw new Error('Python >=3.10 is required; set GEAR_PYTHON to its executable')
}
export async function doctor() {
  const checks: Array<{ name: string; ready: boolean; detail: string }> = []
  const [node, minor] = process.versions.node.split('.').map(Number)
  checks.push({ name: 'node', ready: node! >= 24 || (node === 22 && minor! >= 19), detail: process.version })
  let pythonCommand = 'python3'
  try {
    pythonCommand = await supportedPython()
  } catch {
    /* Missing Python is reported with the other checks. */
  }
  for (const [name, command, args] of [
    ['python', pythonCommand, ['-c', 'import sys; assert sys.version_info >= (3,10); print(sys.executable)']],
    ['docker', 'docker', ['info', '--format', '{{.ServerVersion}}']],
    ['hitch', 'hitch', ['--version']],
  ] as const) {
    try {
      const result = await execute(command, [...args], { timeout: 10_000 })
      checks.push({
        name,
        ready: result.stdout.trim().length > 0,
        detail: result.stdout.trim() || 'Runtime did not report a ready version',
      })
    } catch {
      checks.push({ name, ready: false, detail: `${name} unavailable` })
    }
  }
  try {
    const env = await environment()
    await access(env.python)
    checks.push({ name: 'managed-python', ready: true, detail: env.python })
    for (const [name, profile] of Object.entries(env.profiles)) {
      const missing = profile.environment.filter((key) => !process.env[key])
      checks.push({
        name: `authentication:${name}`,
        ready: missing.length === 0,
        detail: missing.length
          ? `Missing environment references: ${missing.join(', ')}`
          : 'Environment references present; provider login has not been probed',
      })
    }
  } catch {
    checks.push({ name: 'profiles', ready: false, detail: 'Run gear setup --profiles profiles.json' })
  }
  return {
    ready: checks.filter((c) => c.name !== 'hitch').every((c) => c.ready),
    checks,
    next_action:
      'Prepare pinned native runtime images and authentication profiles; environment checks do not constitute a model execution.',
  }
}
export async function setup(profilesPath?: string, native?: { adapter: 'dsh' | 'pi'; model: string }) {
  const root = gearHome()
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (profilesPath) {
    const value: unknown = JSON.parse(await readFile(resolve(profilesPath), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profiles must be a JSON object')
    for (const profile of Object.values(value)) validateProfile(profile as DockerProfile)
    await copyFile(resolve(profilesPath), join(root, 'profiles.json'))
  }
  if (native) {
    const source = fileURLToPath(new URL('../../assets/native-runtime', import.meta.url))
    await execute('docker', ['build', '-t', 'gear-native:1', source], { timeout: 900_000, maxBuffer: 4 * 1024 * 1024 })
    const image = (await execute('docker', ['image', 'inspect', 'gear-native:1', '--format', '{{.Id}}'])).stdout.trim()
    const profile: DockerProfile = {
      image,
      command: [
        'node',
        ...(native.adapter === 'dsh' ? ['--expose-internals'] : []),
        '/opt/gear/native/run.mjs',
        native.adapter,
        '{model}',
      ],
      model: native.model,
      environment: ['DSH_OPENAI_CODEX_ACCESS_B64'],
    }
    validateProfile(profile)
    await atomicJSON(join(root, 'profiles.json'), { 'default-target': profile, 'default-meta': profile })
  }
  const python = await supportedPython()
  await execute(python, ['-c', 'import sys; assert sys.version_info >= (3,10)'], { timeout: 10_000 })
  const managed = join(root, 'python')
  await execute(python, ['-m', 'venv', managed], { timeout: 60_000 })
  const executable = join(managed, 'bin/python')
  const source = fileURLToPath(new URL('../../python', import.meta.url))
  await execute(executable, ['-m', 'pip', 'install', source], { timeout: 180_000, maxBuffer: 1024 * 1024 })
  await atomicJSON(join(root, 'environment.json'), { version: 1, python: executable })
  return doctor()
}
