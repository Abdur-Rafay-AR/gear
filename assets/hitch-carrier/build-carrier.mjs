import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// Reuse the native runner's one dependency lock, with its exact package manager.
// Hitch's Pi and DSH Git recipes can both build this fixed carrier.
execFileSync(
  'npm',
  ['exec', '--yes', '--package=pnpm@11.7.0', '--', 'pnpm', '--dir', 'native', 'install', '--prod', '--frozen-lockfile'],
  { stdio: 'inherit' },
)
for (const [adapter, entrypoint] of [
  ['pi', 'packages/coding-agent/dist/cli.js'],
  ['dsh', 'apps/cli/lib/bin.js'],
]) {
  await mkdir(dirname(entrypoint), { recursive: true })
  await writeFile(
    entrypoint,
    `#!/usr/bin/env node\nimport { runHitchNative } from '../../../native/hitch-entry.mjs'\nawait runHitchNative('${adapter}')\n`,
    { mode: 0o755 },
  )
}
