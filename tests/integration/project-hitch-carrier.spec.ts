import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { dshTarget } from '../../src/adapters/dsh/target.js'
import { HitchCarrier } from '../../src/adapters/hitch/carrier.js'
import { piTarget } from '../../src/adapters/pi/target.js'
import { targetFiles } from '../../src/application/target-files.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const execute = promisify(execFile)
// Explicit build opt-in. A second, separate opt-in enables two Luna model calls.
async function writableDirectories(root: string): Promise<void> {
  await chmod(root, 0o700)
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink()) await writableDirectories(join(root, entry.name))
}
describe.skipIf(process.env.GEAR_TEST_HITCH_CARRIER !== 'required')('real Hitch Harbor carrier build', () => {
  it.each([
    ['deepseek', dshTarget, '0.1.1-rc.2'],
    ['pi', piTarget, '0.68.0'],
  ] as const)(
    'prepares %s through the fixed Hitch recipe and preserves artifact integrity',
    async (harnessId, adapter, version) => {
      if (!process.env.HITCH_CONTRACT_ROOT)
        throw new Error('HITCH_CONTRACT_ROOT must point to the built, pinned Hitch source')
      const hitch = resolve(process.env.HITCH_CONTRACT_ROOT)
      const load = (name: string) => import(pathToFileURL(join(hitch, 'dist/src', name, 'index.js')).href)
      const { resolveHarness } = await load('artifacts')
      const { buildLocalGitTransport, harborTrialRuntimeContract } = await load('backends')
      const { ensureControllerRuntime } = await load('controller-runtime')
      const { prepareHarborArtifact } = await load('evals')
      const root = await mkdtemp(join(tmpdir(), 'gear-hitch-linux-carrier-'))
      try {
        await adapter.prepare(join(root, 'target'))
        const modelTest = process.env.GEAR_TEST_HITCH_CARRIER_MODEL === 'luna'
        if (modelTest) {
          if (!process.env.DSH_OPENAI_CODEX_ACCESS_B64)
            throw new Error('Luna carrier test requires the credential environment reference')
          const policy =
            'Write exactly GEAR_HITCH_NATIVE_OK to /app/answer.txt when asked for an answer. Do not add a newline.'
          await writeFile(
            join(root, 'target', harnessId === 'pi' ? 'extensions/policy.ts' : 'plugins/policy.js'),
            harnessId === 'pi'
              ? `export default function(pi) {pi.on('before_agent_start', () => ({systemPrompt:${JSON.stringify(policy)}}))}`
              : `export const inject=['systemPrompt']; export function apply(ctx) {ctx.systemPrompt.section({name:'carrier-contract',order:99,text:${JSON.stringify(policy)}})}`,
          )
        }
        const files = await targetFiles(join(root, 'target'), adapter)
        const carrier = await HitchCarrier.create(join(root, 'carrier.git'), adapter)
        const revision = await carrier.prepare({ id: 'initial', files, digest: canonicalDigest(files) })
        const reference = `${harnessId}@git+${pathToFileURL(revision.repository).href}#${revision.commit}`
        const state = join(root, 'hitch')
        const resolvedRevision = await resolveHarness(reference, { root: state })
        const evalDirectory = join(root, 'eval')
        await mkdir(evalDirectory)
        const localTransport = await buildLocalGitTransport({
          evalDirectory,
          resolvedRevision,
          sourceDirectory: revision.repository,
        })
        const runtime = await ensureControllerRuntime({ root: state })
        const input = {
          root: state,
          resolvedRevision,
          runtimeDirectory: runtime.directory,
          runtimeId: runtime.runtime_id,
          runtimeContract: harborTrialRuntimeContract('linux/amd64'),
          localTransport,
          env: process.env,
        }
        const first = await prepareHarborArtifact(input)
        expect(first.source).toBe('dedicated-builder')
        expect(first.cacheHit).toBe(false)
        expect(first.artifact.platform).toBe('linux-x64')
        const second = await prepareHarborArtifact(input)
        expect(second.cacheHit).toBe(true)
        expect(second.artifact.artifact_id).toBe(first.artifact.artifact_id)
        const manifest = JSON.parse(await readFile(join(first.artifact.directory, 'artifact.json'), 'utf8'))
        const { stdout } = await execute(
          'docker',
          [
            'run',
            '--rm',
            '--platform',
            'linux/amd64',
            '--network=none',
            '--mount',
            `type=bind,source=${first.artifact.directory},target=/artifact,readonly`,
            first.builderImage,
            'node',
            `/artifact/${manifest.entrypoint}`,
            '--version',
          ],
          { timeout: 60_000 },
        )
        expect(stdout.trim()).toBe(version)
        if (modelTest) {
          const workspace = join(root, 'workspace')
          await mkdir(workspace)
          const runtimeArgs =
            harnessId === 'pi'
              ? ['--mode', 'json', '--no-session', '--model', 'gpt-5.6-luna']
              : [
                  '--profile',
                  'headless',
                  '--gear-model=gpt-5.6-luna',
                  '--patch',
                  '/unused',
                  '--',
                  '--',
                  'Write the required answer.',
                ]
          const { spawn } = await import('node:child_process')
          const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
            const child = spawn(
              'docker',
              [
                'run',
                '--rm',
                '-i',
                '--platform',
                'linux/amd64',
                '--mount',
                `type=bind,source=${first.artifact.directory},target=/artifact,readonly`,
                '--mount',
                `type=bind,source=${workspace},target=/app`,
                '--workdir',
                '/app',
                '--env',
                'DSH_OPENAI_CODEX_ACCESS_B64',
                '--env',
                'DSH_HOME=/tmp/hitch-home',
                first.builderImage,
                'node',
                `/artifact/${manifest.entrypoint}`,
                ...runtimeArgs,
              ],
              { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 },
            )
            let output = ''
            child.stdout.on('data', (chunk) => {
              output += chunk
            })
            child.stderr.resume()
            child.stdin.on('error', () => {})
            child.once('error', reject)
            child.once('close', (code) => resolve({ code, output }))
            child.stdin.end(harnessId === 'pi' ? 'Write the required answer.' : '')
          })
          expect(result.code).toBe(0)
          expect(await readFile(join(workspace, 'answer.txt'), 'utf8')).toBe('GEAR_HITCH_NATIVE_OK')
          if (harnessId === 'pi')
            expect(
              result.output
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line).type),
            ).toContain('message_end')
        }
      } finally {
        await writableDirectories(root)
        await rm(root, { recursive: true, force: true })
      }
    },
    1_200_000,
  )
})
