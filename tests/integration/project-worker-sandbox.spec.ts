import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPythonWorker } from '../../src/adapters/python/worker.js'

// Exercise real OS isolation explicitly, alongside the existing platform suite.
describe.skipIf(process.env.GEAR_TEST_PROJECT_SANDBOX !== 'required')('managed Python isolation', () => {
  it('cannot read an unrelated project, host credentials, or loopback, even outside the caller cwd', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-python-isolation-')))
    const listener = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as AddressInfo).port
    const source = join(root, 'algorithm'),
      secret = join(root, 'private-heldout.txt')
    await mkdir(source)
    await writeFile(secret, 'PRIVATE_HELDOUT_SENTINEL')
    await writeFile(
      join(source, 'policy.py'),
      `from gear.algorithms import Decision, Operation
import os, socket
class Probe:
    def step(self, view, state):
        try:
            open(${JSON.stringify(secret)}).read()
            raise AssertionError('host-file-leak')
        except (PermissionError, FileNotFoundError): pass
        assert 'GEAR_ISOLATION_SECRET' not in os.environ
        try:
            socket.create_connection(('127.0.0.1', ${port}), timeout=0.2)
            raise AssertionError('network-leak')
        except OSError: pass
        return Decision({'isolated': True}, (Operation('stop'),), 'denied host access')
def build_algorithm(): return Probe()
`,
    )
    process.env.GEAR_ISOLATION_SECRET = 'PRIVATE_CREDENTIAL_SENTINEL'
    try {
      const worker = await createPythonWorker(process.env.GEAR_TRAINING_TEST_PYTHON ?? '/usr/bin/python3', {
        source,
        entrypoint: 'policy:build_algorithm',
      })
      const decision = await worker.step(
        {
          seed_tasks: ['seed'],
          candidates: [{ id: 'initial', scores: { seed: 0 } }],
          champion: 'initial',
          max_candidates: 1,
          remaining_evaluations: 10,
          random_seed: 'fixed',
          completed: {},
        },
        {},
        { runId: 'sandbox-test', stepId: 0 },
        new AbortController().signal,
      )
      expect(decision.state).toEqual({ isolated: true })
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()))
      delete process.env.GEAR_ISOLATION_SECRET
      await rm(root, { recursive: true, force: true })
    }
  }, 45_000)
})
