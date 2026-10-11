import { execFile } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { invalid } from '../domain/errors.js'
import { supportedPython } from './environment.js'
import { resolveProjectAlgorithm } from './project-config.js'

/** Explicit local author check: CPU toy inputs, no managed provider or model. */
export async function testProjectAlgorithm(entrypoint: string, source: string, kind = 'auto') {
  resolveProjectAlgorithm({ source, entrypoint }, source)
  if (!['auto', 'algorithm', 'parent'].includes(kind)) invalid('kind must be auto, algorithm or parent')
  const python = await supportedPython()
  const code = fileURLToPath(new URL('../../python', import.meta.url))
  const result = await promisify(execFile)(
    python,
    ['-m', 'gear', 'algorithm', 'test', entrypoint, '--source', resolve(source), '--kind', kind],
    {
      cwd: resolve(source),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONPATH: [code, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
    },
  )
  return JSON.parse(result.stdout) as Record<string, unknown>
}
