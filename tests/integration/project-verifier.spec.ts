import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { DockerProjectProvider } from '../../src/adapters/docker/provider.js'
import { compileHarbor } from '../../src/adapters/hitch/benchmark.js'
import { piTarget } from '../../src/adapters/pi/target.js'
import { loadBenchmark } from '../../src/application/benchmark.js'
import { initProject } from '../../src/application/project-init.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const execute = promisify(execFile)
const image = process.env.GEAR_VERIFIER_TEST_IMAGE
// No model calls: run the generated Harbor verifier in a real isolated container.
describe.skipIf(!image)('compiled template verifiers', () => {
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
          [task.fixtures.positive, '1'],
          [task.fixtures.negative, '0'],
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
