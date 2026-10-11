import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { dshTarget } from '../../src/adapters/dsh/target.js'
import { HitchCarrier } from '../../src/adapters/hitch/carrier.js'
import { HitchExecutionContract } from '../../src/adapters/hitch/execution-contract.js'
import { piTarget } from '../../src/adapters/pi/target.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { EvaluationRequest } from '../../src/types.js'

const execute = promisify(execFile)
const hitchRoot = process.env.HITCH_CONTRACT_ROOT
describe.skipIf(!hitchRoot)('pinned Hitch reads a stable candidate source', () => {
  it.each([
    ['deepseek', dshTarget, 'prompts/system.md'],
    ['pi', piTarget, 'AGENTS.md'],
  ] as const)(
    'resolves and exports new %s commits without changing the comparison condition',
    async (harnessId, adapter, path) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-hitch-stable-source-')))
      try {
        const source = resolve(hitchRoot!)
        const carrier = await HitchCarrier.create(join(root, 'carrier.git'), adapter)
        const target = (text: string) => ({
          id: text,
          files: { [path]: text },
          digest: canonicalDigest({ [path]: text }),
        })
        const initial = await carrier.prepare(target('initial'))
        const state = join(root, 'hitch')
        const resolveRevision = async (commit: string) =>
          JSON.parse(
            (
              await execute(
                process.execPath,
                [
                  join(source, 'dist/bin/hitch.js'),
                  '--root',
                  state,
                  'resolve',
                  `${harnessId}@git+${pathToFileURL(initial.repository).href}#${commit}`,
                  '--json',
                ],
                { timeout: 30000, maxBuffer: 1024 * 1024 },
              )
            ).stdout,
          )
        const firstResolution = await resolveRevision(initial.commit)
        // Publish only after Hitch has cached the first source and revision.
        const candidate = await carrier.prepare(target('candidate'))
        expect(candidate.repository).toBe(initial.repository)
        const candidateResolution = await resolveRevision(candidate.commit)
        expect(firstResolution.revision.commit).toBe(initial.commit)
        expect(candidateResolution.revision.commit).toBe(candidate.commit)
        expect(candidateResolution.source).toEqual(firstResolution.source)
        expect(candidateResolution.identity).not.toBe(firstResolution.identity)
        expect((await resolveRevision(initial.commit)).identity).toBe(firstResolution.identity)
        // This dependency import exercises the pinned transport only in a contract test.
        const { buildLocalGitTransport, verifyLocalGitTransport } = await import(
          pathToFileURL(join(source, 'dist/src/backends/index.js')).href
        )
        for (const [name, resolvedRevision] of [
          ['initial', firstResolution],
          ['candidate', candidateResolution],
        ] as const) {
          const evalDirectory = join(root, name)
          await mkdir(evalDirectory)
          const transport = await buildLocalGitTransport({
            evalDirectory,
            resolvedRevision,
            sourceDirectory: initial.repository,
          })
          expect(transport.manifest.commit).toBe(resolvedRevision.revision.commit)
          // Validate the same sealed pack that the Harbor builder receives.
          const expected = {
            harnessId,
            resolutionIdentity: resolvedRevision.identity,
            commit: resolvedRevision.revision.commit,
          }
          await verifyLocalGitTransport(transport, { expected })
          await expect(
            verifyLocalGitTransport(transport, { expected: { ...expected, commit: '0'.repeat(40) } }),
          ).rejects.toThrow('commit does not match')
          expect((await readFile(transport.payloadPath)).length).toBe(transport.manifest.payload_bytes)
        }
        const context = {
          evolutionId: 'project',
          roundId: 'trial',
          workspaceRoot: root,
          taskBudgetMs: 10000,
          sandboxProfileRef: 'fixed',
        }
        const options = {
          executable: join(source, 'dist/bin/hitch.js'),
          root: state,
          harnessId,
          model: 'gpt-5.6-luna',
          attempts: 1,
          infrastructureRetries: 0,
          maxConcurrent: 1,
          setupTimeoutMs: 10000,
          terminationGraceMs: 100,
          maxOutputBytes: 1024 * 1024,
          maxTrajectoryOutputBytes: 1024 * 1024,
          sampling: {},
          agentArgs: [],
          passEnv: [],
          controlPlane: { mode: 'daemon' as const, requireModelCapture: false },
        }
        const request: EvaluationRequest = {
          phase: 'seed-candidate',
          dataset: join(root, 'task'),
          harnessRef: initial.commit,
          condition: {
            conditionId: canonicalDigest('condition'),
            partition: 'seed',
            dataset: { ref: join(root, 'task'), digest: canonicalDigest('task') },
            repetitions: 1,
            model: options.model,
            sampling: {},
            timeoutMs: context.taskBudgetMs,
            rolloutProviderDigest: canonicalDigest('provider'),
          },
        }
        const before = new HitchExecutionContract(options, initial.repository)
        const after = new HitchExecutionContract(options, candidate.repository)
        const changed = { ...request, harnessRef: candidate.commit }
        expect(after.baseParity(context, changed)).toEqual(before.baseParity(context, request))
        expect(after.daemonIdempotencyKey(context, changed)).not.toBe(before.daemonIdempotencyKey(context, request))
        expect(await (await HitchCarrier.create(carrier.root, adapter)).prepare(target('initial'))).toEqual(initial)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60000,
  )
})
