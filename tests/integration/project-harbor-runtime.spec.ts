import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { prepareHarborRuntime } from '../../src/adapters/hitch/harbor-runtime.js'

const execute = promisify(execFile)
const hitchRoot = process.env.HITCH_CONTRACT_ROOT,
  python = process.env.GEAR_HARBOR_PYTHON
describe.skipIf(!hitchRoot || !python)('pinned Hitch discovers guarded Harbor', () => {
  it('uses the sealed entry and the original virtualenv for its resource bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-hitch-guarded-harbor-'))
    try {
      const runtime = await prepareHarborRuntime(join(root, 'runtime.git'), python!, AbortSignal.timeout(30000))
      const shadow = join(root, 'shadow')
      await mkdir(shadow)
      await writeFile(join(shadow, 'gear_harbor_artifacts.py'), 'raise RuntimeError("WRONG_PLUGIN_LOADED")\n')
      const source = resolve(hitchRoot!),
        env = {
          ...process.env,
          ...runtime.environment,
          HITCH_PYTHON_PATH: python,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: [shadow, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
        }
      const result = await execute(
        process.execPath,
        [join(source, 'dist/bin/hitch.js'), '--root', join(root, 'hitch'), 'eval', 'doctor', '--json'],
        { env, timeout: 30000, maxBuffer: 64 * 1024 },
      )
      const doctor = JSON.parse(result.stdout)
      expect(doctor.checks.harbor).toMatchObject({
        status: 'ok',
        executable: runtime.executable,
        source: 'environment',
      })
      expect(doctor.checks.harbor.version).toContain('0.21.0')
      // This dependency import is contract-test-only. Production uses the CLI.
      const { inspectHarborTaskResources } = await import(
        pathToFileURL(join(source, 'dist/src/backends/harbor/task-resources.js')).href
      )
      const { fingerprintExecutable } = await import(pathToFileURL(join(source, 'dist/src/foundation/index.js')).href)
      expect(await fingerprintExecutable(runtime.executable)).toBe(runtime.executableDigest)
      const task = join(root, 'task')
      await mkdir(task)
      await writeFile(
        join(task, 'task.toml'),
        `version = "1.0"
[environment]
cpus = 1
memory_mb = 512
docker_image = "python:3.12-slim"
[verifier]
environment_mode = "separate"
[verifier.environment]
cpus = 2
memory_mb = 768
docker_image = "python:3.12-slim"
`,
      )
      const resources = await inspectHarborTaskResources({ root: join(root, 'hitch'), taskDirectory: task, env })
      expect(resources).toMatchObject({
        schema_version: '1',
        task: { cpu_millis: 1000, memory_bytes: 512 * 1024 * 1024 },
        verifier: { separate: true, environment: { cpu_millis: 2000, memory_bytes: 768 * 1024 * 1024 } },
      })
      expect(await prepareHarborRuntime(join(root, 'runtime.git'), python!, AbortSignal.timeout(30000))).toEqual(
        runtime,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
})
