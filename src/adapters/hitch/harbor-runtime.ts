import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { canonicalDigest } from '../../domain/canonical.js'
import { snapshotCheckout } from '../storage/git-checkout.js'
import { GitSnapshots } from '../storage/git-snapshots.js'

const execute = promisify(execFile)
const assets = ['launch.mjs', 'harbor_cli.py', 'gear_harbor_artifacts.py'] as const
const fields = ['harborVersion', 'harborSource', 'pythonVersion', 'pythonBinary', 'platform', 'architecture'] as const
export type HarborInstallation = Record<(typeof fields)[number], string>
export interface GuardedHarborRuntime {
  identity: string
  executable: string
  /** Same byte hash recorded by Hitch as backend.identity. */
  executableDigest: string
  python: string
  installation: HarborInstallation
  environment: { HITCH_HARBOR_PATH: string; HITCH_HARBOR_PYTHON_PATH: string }
}

/** Seal the guard and CLI entry together. Never patch the caller's Harbor installation. */
export async function prepareHarborRuntime(
  repository: string,
  python: string,
  signal: AbortSignal,
): Promise<GuardedHarborRuntime> {
  signal.throwIfAborted()
  if (!isAbsolute(python) || /[\0\r\n]/u.test(python)) throw new TypeError('harbor-python-must-be-absolute')
  // Preserve the virtualenv shim; realpath would select the base Python's packages.
  python = resolve(python)
  const files: Record<string, string> = {}
  for (const name of assets)
    files[name] = await readFile(new URL(`../../../assets/harbor-runtime/${name}`, import.meta.url), 'utf8')
  const result = await execute(
    python,
    [
      '-P',
      fileURLToPath(new URL('../../../assets/harbor-runtime/harbor_cli.py', import.meta.url)),
      '--gear-runtime-inspect',
    ],
    { signal, timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  )
  const value: unknown = JSON.parse(result.stdout)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...fields].sort().join() ||
    !fields.every((field) => typeof (value as Record<string, unknown>)[field] === 'string')
  )
    throw new TypeError('invalid-harbor-runtime-installation')
  const installation = value as HarborInstallation
  if (
    installation.harborVersion !== '0.21.0' ||
    !/^sha256:[a-f0-9]{64}$/u.test(installation.harborSource) ||
    !/^sha256:[a-f0-9]{64}$/u.test(installation.pythonBinary) ||
    !/^3\.(?:1[2-9]|[2-9][0-9])\.\d+$/u.test(installation.pythonVersion) ||
    !['linux', 'darwin'].includes(installation.platform) ||
    !installation.architecture
  )
    throw new TypeError('unsupported-harbor-runtime-installation')
  const binding = {
    version: 1,
    python,
    installation,
    assets: Object.fromEntries(
      assets.map((name) => [name, `sha256:${createHash('sha256').update(files[name]!).digest('hex')}`]),
    ),
  }
  // The code enforcing asset hashes belongs to the executable Hitch fingerprints.
  // Do not import a mutable sibling before checking that sibling's hash.
  files.harbor = `#!/usr/bin/env node\n${files['launch.mjs']}\nawait launch(${JSON.stringify(binding)});\n`
  const identity = canonicalDigest({ version: 1, files, executables: ['harbor'] })
  const commit = await new GitSnapshots(repository).publish(files, identity, undefined, ['harbor'])
  // Hitch resolves executable aliases (notably /var -> /private/var on macOS).
  // Return that same location for later backend provenance comparison.
  const executable = await realpath(join(await snapshotCheckout(repository, commit), 'harbor'))
  return {
    identity,
    executable,
    executableDigest: `sha256:${createHash('sha256').update(files.harbor).digest('hex')}`,
    python,
    installation,
    environment: { HITCH_HARBOR_PATH: executable, HITCH_HARBOR_PYTHON_PATH: python },
  }
}
