import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { DockerProjectProvider } from '../../src/adapters/docker/provider.js'
import { dshTarget } from '../../src/adapters/dsh/target.js'
import { piTarget } from '../../src/adapters/pi/target.js'
import { targetFiles } from '../../src/application/target-files.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { scoreOutput } from '../../src/domain/scoring.js'

const execute = promisify(execFile)
const image = process.env.GEAR_NATIVE_RUNTIME_IMAGE
// Explicit opt-in: this suite makes two model calls. Offline CI never enables it.
describe.skipIf(!image || !process.env.DSH_OPENAI_CODEX_ACCESS_B64)('packaged native Target behavior (Luna)', () => {
  it.each(['dsh', 'pi'] as const)(
    'loads a %s extension and scores its observable behavior',
    async (adapterId) => {
      const root = await mkdtemp(join(tmpdir(), 'gear-native-contract-'))
      const adapter = adapterId === 'dsh' ? dshTarget : piTarget
      const targetRoot = join(root, 'target')
      const operationId = canonicalDigest([root, adapterId])
      try {
        await adapter.prepare(targetRoot)
        const policy =
          'Whenever asked for an answer, write exactly GEAR_NATIVE_OK to the requested output file. Do not add a newline or explanation.'
        if (adapterId === 'dsh')
          await writeFile(
            join(targetRoot, 'plugins/policy.js'),
            `export const inject=['systemPrompt']; export function apply(ctx) {ctx.systemPrompt.section({name:'native-contract',order:99,text:${JSON.stringify(policy)}})}`,
          )
        else
          await writeFile(
            join(targetRoot, 'extensions/policy.ts'),
            `export default function(pi) {pi.on('before_agent_start', () => ({systemPrompt:${JSON.stringify(policy)}}))}`,
          )
        const files = await targetFiles(targetRoot, adapter)
        const spec = adapter.executionSpec('/target', 'gpt-5.6-luna')
        const profile = {
          image: image!,
          command: [spec.command, ...spec.args],
          model: 'gpt-5.6-luna',
          environment: ['DSH_OPENAI_CODEX_ACCESS_B64'],
        }
        const provider = new DockerProjectProvider(join(root, 'operations'), profile, profile, adapterId)
        const input = {
          operationId,
          task: { id: 'native', instruction: 'Write the required answer.', outputPath: '/app/answer.txt' },
          target: { id: 'native', files, digest: canonicalDigest(files) },
        }
        const result = await provider.evaluate(input, new AbortController().signal)
        expect(result.status).toBe('completed')
        expect(
          scoreOutput({ kind: 'text', expected: 'GEAR_NATIVE_OK', normalization: 'trim' }, result.output).value,
        ).toBe(1)
        expect(await provider.inspectEvaluation(operationId, new AbortController().signal)).toEqual(result)
        const { stdout } = await execute('docker', [
          'inspect',
          '--format',
          '{{json .Mounts}}',
          `gear-${operationId.slice(7, 39)}`,
        ])
        expect(
          JSON.parse(stdout)
            .map((mount: { Destination: string }) => mount.Destination)
            .sort(),
        ).toEqual(['/app', '/target'])
      } finally {
        await execute('docker', ['rm', '-f', `gear-${operationId.slice(7, 39)}`]).catch(() => {})
        await rm(root, { recursive: true, force: true })
      }
    },
    360_000,
  )
})
