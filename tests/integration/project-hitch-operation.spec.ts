import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HitchEvaluationClient } from '../../src/adapters/hitch/evaluation-client.js'
import { HitchEvaluationOperations, type HitchOperationBinding } from '../../src/adapters/hitch/evaluation-operation.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const hitchRoot = process.env.HITCH_CONTRACT_ROOT
// Real CLI, HTTP, scheduler, idempotency index, disk state and cancellation.
// Only the expensive Harbor executor is replaced; this is not verifier/model certification.
describe.skipIf(!hitchRoot)('durable operations against the pinned Hitch daemon', () => {
  it.each(['resume', 'cancel', 'process-crash'] as const)(
    'handles a lost submission response followed by %s without another launch',
    async (scenario) => {
      const source = resolve(hitchRoot!)
      const { DaemonServer, daemonClient } = await import(pathToFileURL(join(source, 'dist/src/daemon/index.js')).href)
      const root = await mkdtemp(join(tmpdir(), 'gear-hitch-operation-contract-')),
        daemonRoot = join(root, 'daemon')
      let started = 0,
        stopped = 0
      const server = new DaemonServer({
        root: daemonRoot,
        port: 0,
        maxConcurrent: 1,
        logger: () => {},
        evalExecutor: async (options: { signal: AbortSignal; evalId: string }) => {
          started++
          if (!options.signal.aborted)
            await new Promise<void>((resolve) =>
              options.signal.addEventListener('abort', () => resolve(), { once: true }),
            )
          stopped++
          const now = new Date().toISOString()
          return {
            schema_version: '1',
            eval_id: options.evalId,
            status: 'cancelled',
            exit_code: 9,
            error: { code: 'cancelled', message: 'Stopped contract executor' },
            started_at: now,
            completed_at: now,
          }
        },
      })
      await server.start()
      const executable = join(root, 'hitch.mjs')
      await writeFile(
        executable,
        `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(join(source, 'dist/bin/hitch.js')).href)})\n`,
      )
      await chmod(executable, 0o755)
      const id = canonicalDigest(root),
        dataset = 'demo@1.0'
      const binding: HitchOperationBinding = {
        context: {
          evolutionId: 'project',
          roundId: id,
          workspaceRoot: root,
          taskBudgetMs: 10000,
          sandboxProfileRef: 'fixed',
        },
        options: {
          executable,
          root: daemonRoot,
          repositoryPath: root,
          harnessId: 'pi',
          model: 'gpt-5.6-luna',
          attempts: 1,
          maxConcurrent: 1,
          setupTimeoutMs: 10000,
          terminationGraceMs: 100,
          maxOutputBytes: 1024 * 1024,
          maxTrajectoryOutputBytes: 1024 * 1024,
          sampling: {},
          agentArgs: [],
          passEnv: [],
          controlPlane: { mode: 'daemon', requireModelCapture: false },
        },
        request: {
          phase: 'seed-candidate',
          dataset,
          harnessRef: 'a'.repeat(40),
          condition: {
            conditionId: id,
            partition: 'seed',
            dataset: { ref: dataset, digest: canonicalDigest('task') },
            repetitions: 1,
            model: 'gpt-5.6-luna',
            sampling: {},
            timeoutMs: 10000,
            rolloutProviderDigest: canonicalDigest('provider'),
          },
        },
      }
      class LostResponseClient extends HitchEvaluationClient {
        override async reserve(...args: Parameters<HitchEvaluationClient['reserve']>): Promise<never> {
          await super.reserve(...args)
          throw new Error('contract dropped the accepted response')
        }
      }
      const journal = join(root, 'operations'),
        signal = new AbortController().signal
      try {
        const client = new HitchEvaluationClient(binding.options)
        const intent = client.prepareSubmission(binding.context, binding.request)!
        expect(await client.lookupReservation(intent, signal)).toBeUndefined()
        expect(started).toBe(0)
        const first = new HitchEvaluationOperations(journal, (options) => new LostResponseClient(options))
        if (scenario === 'process-crash') {
          const script = join(root, 'crash.mjs')
          await writeFile(
            script,
            `
          import {HitchEvaluationOperations} from ${JSON.stringify(new URL('../../lib/adapters/hitch/evaluation-operation.js', import.meta.url).href)};
          import {HitchEvaluationClient} from ${JSON.stringify(new URL('../../lib/adapters/hitch/evaluation-client.js', import.meta.url).href)};
          class CrashClient extends HitchEvaluationClient {
            async reserve(...args) {await super.reserve(...args); process.kill(process.pid, 'SIGKILL'); await new Promise(()=>{});}
          }
          await new HitchEvaluationOperations(${JSON.stringify(journal)}, options=>new CrashClient(options))
            .execute(${JSON.stringify(id)},${JSON.stringify(binding)},new AbortController().signal);
        `,
          )
          const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
          let stderr = ''
          child.stdout.resume()
          child.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', (code, signal) => resolve({ code, signal }))
          })
          expect({ ...exit, stderr }).toEqual({ code: null, signal: 'SIGKILL', stderr: '' })
        } else {
          await expect(first.execute(id, binding, signal)).rejects.toThrow('dropped the accepted response')
        }
        await expect.poll(() => started).toBe(1)
        const saved = JSON.parse(await readFile(join(journal, `${id.slice(7)}.json`), 'utf8'))
        expect(saved.reservation).toBeUndefined()
        expect(saved.intent).toEqual(intent)
        const resumed = new HitchEvaluationOperations(journal)
        if (scenario === 'resume') expect(await resumed.inspect(id, signal)).toBeUndefined()
        await resumed.cancel(id, signal)
        await expect.poll(() => stopped).toBe(1)
        const evals = (await readdir(join(daemonRoot, 'evals'))).filter((name) => name.startsWith('eval_'))
        expect(evals).toHaveLength(1)
        expect(started).toBe(1)
        expect(JSON.parse(await readFile(join(journal, `${id.slice(7)}.json`), 'utf8')).cancelled).toBe(true)
        const remote = await daemonClient(daemonRoot)
        await expect.poll(async () => (await remote.request(`/v1/evals/${evals[0]}`)).control.state).toBe('cancelled')
        await expect(first.execute(id, binding, signal)).rejects.toMatchObject({ code: 'hitch_operation_cancelled' })
      } finally {
        await server.close()
        await rm(root, { recursive: true, force: true })
      }
    },
    30000,
  )
})
