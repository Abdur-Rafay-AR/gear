import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { DockerProjectProvider } from '../../src/adapters/docker/provider.js'
import { compileHarbor } from '../../src/adapters/hitch/benchmark.js'
import { readHarborTask, writeHarborTask } from '../../src/adapters/hitch/harbor-files.js'
import { piTarget } from '../../src/adapters/pi/target.js'
import { loadBenchmark } from '../../src/application/benchmark.js'
import { initProject } from '../../src/application/project-init.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const execute = promisify(execFile)
const image = process.env.GEAR_VERIFIER_TEST_IMAGE
// No model calls: run the generated Harbor verifier in a real isolated container.
describe.skipIf(!image)('compiled template verifiers', () => {
  it('executes an imported verifier with its original binary resources and fractional reward contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-imported-verifier-'))
    try {
      const source = join(root, 'source'),
        frozen = join(root, 'frozen'),
        workspace = join(root, 'work'),
        logs = join(root, 'logs')
      for (const path of [join(source, 'tests'), join(source, 'environment'), workspace, logs])
        await mkdir(path, { recursive: true })
      await writeFile(join(source, 'task.toml'), 'version = "1.0"\n')
      await writeFile(join(source, 'instruction.md'), 'Produce the required binary output')
      await writeFile(join(source, 'environment/Dockerfile'), `FROM ${image}\nWORKDIR /app\n`)
      await writeFile(join(source, 'tests/secret.bin'), Buffer.from([0, 255, 13, 128]))
      await writeFile(join(source, 'tests/test.sh'), '#!/bin/sh\nset -eu\npython3 /tests/verify.py\n', { mode: 0o700 })
      await writeFile(
        join(source, 'tests/verify.py'),
        `import json
from pathlib import Path
correct = Path('/app/answer.bin').read_bytes() == Path('/tests/secret.bin').read_bytes()
Path('/logs/reward.json').write_text(json.dumps({'reward': 0.75 if correct else 0, 'count': 2}))
`,
      )
      const snapshot = await readHarborTask(source)
      await writeHarborTask(snapshot.task, frozen)
      await rm(source, { recursive: true })
      for (const [bytes, reward] of [
        [Buffer.from([0, 255, 13, 128]), 0.75],
        [Buffer.from('wrong'), 0],
      ] as const) {
        await writeFile(join(workspace, 'answer.bin'), bytes)
        await execute(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--read-only',
            '--mount',
            `type=bind,src=${workspace},dst=/app,readonly`,
            '--mount',
            `type=bind,src=${join(frozen, 'tests')},dst=/tests,readonly`,
            '--mount',
            `type=bind,src=${logs},dst=/logs`,
            image!,
            'sh',
            '/tests/test.sh',
          ],
          { timeout: 60000 },
        )
        expect(JSON.parse(await readFile(join(logs, 'reward.json'), 'utf8'))).toEqual({ reward, count: 2 })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 90000)
  it.each(['text', 'json', 'file'] as const)(
    'scores %s positive and negative fixtures and rejects unsafe output',
    async (template) => {
      const root = await mkdtemp(join(tmpdir(), 'gear-real-verifier-'))
      try {
        await initProject(root, piTarget, template)
        const spec = await loadBenchmark(join(root, 'benchmark.yaml'), 'holdout')
        const task = spec.tasks[0]!
        await compileHarbor(spec, join(root, 'compiled'), 'seed')
        const tests = join(root, 'compiled', task.id, 'tests'),
          workspace = join(root, 'work'),
          logs = join(root, 'logs')
        await mkdir(workspace)
        await mkdir(logs)
        const output = join(
          workspace,
          task.scorer.kind === 'file' ? task.scorer.path.slice('/app/'.length) : 'answer.txt',
        )
        await mkdir(dirname(output), { recursive: true })
        const run = () =>
          execute(
            'docker',
            [
              'run',
              '--rm',
              '--network',
              'none',
              '--read-only',
              '--mount',
              `type=bind,src=${workspace},dst=/app`,
              '--mount',
              `type=bind,src=${tests},dst=/tests,readonly`,
              '--mount',
              `type=bind,src=${logs},dst=/logs`,
              image!,
              'python3',
              '/tests/verify.py',
            ],
            { timeout: 60000 },
          )
        for (const [fixture, reward] of [
          [task.fixtures!.positive, '1'],
          [task.fixtures!.negative, '0'],
        ] as const) {
          await writeFile(output, fixture)
          await run()
          expect((await readFile(join(logs, 'verifier/reward.txt'), 'utf8')).trim()).toBe(reward)
        }
        await rm(output)
        await symlink('/etc/passwd', output)
        await expect(run()).rejects.toThrow()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    90000,
  )
  it('materializes only the frozen task inputs for a real Target container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-real-input-'))
    const id = canonicalDigest(['input-contract', randomUUID()])
    const name = `gear-${id.slice(7, 39)}`
    try {
      const pinned = (await execute('docker', ['image', 'inspect', image!, '--format', '{{.Id}}'])).stdout.trim()
      const profile = {
        image: pinned,
        model: 'offline-fixture',
        environment: [],
        command: [
          'python3',
          '-c',
          "from pathlib import Path; Path('/app/answer.txt').write_text(Path('/app/inputs/data.txt').read_text())",
        ],
      }
      const provider = new DockerProjectProvider(root, profile, profile, 'pi')
      const bytes = Buffer.from('from the frozen task input')
      const result = await provider.evaluate(
        {
          operationId: id,
          target: { id: 'initial', digest: canonicalDigest({}), files: {} },
          task: {
            id: 'seed',
            instruction: 'Copy the input',
            outputPath: '/app/answer.txt',
            inputs: [
              {
                path: 'inputs/data.txt',
                base64: bytes.toString('base64'),
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              },
            ],
          },
        },
        AbortSignal.timeout(30000),
      )
      expect(result).toMatchObject({ status: 'completed', physicalAttempts: 1, output: bytes.toString() })
      expect(await provider.inspectEvaluation(id, AbortSignal.timeout(30000))).toEqual(result)
    } finally {
      await execute('docker', ['rm', '-f', name]).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
})
