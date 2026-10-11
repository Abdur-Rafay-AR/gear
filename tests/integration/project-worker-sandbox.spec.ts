import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createPythonWorker } from '../../src/adapters/python/worker.js'

// Exercise real OS isolation explicitly, alongside the existing platform suite.
describe.skipIf(process.env.GEAR_TEST_PROJECT_SANDBOX !== 'required')('managed Python isolation', () => {
  it('executes an SDK-frozen policy and rejects changed admitted source', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-frozen-policy-')))
    const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? '/usr/bin/python3'
    try {
      await writeFile(
        join(root, 'policy.py'),
        `from gear.algorithms import GEPA
def parent(view): return view.candidates[-1].id
`,
      )
      const result = await promisify(execFile)(
        python,
        [
          '-c',
          `import json
from pathlib import Path
from gear.algorithms import GEPA
from gear.algorithms.source import freeze_algorithm
from policy import parent
frozen = freeze_algorithm(GEPA(parent_policy=parent), Path('sealed'))
print(json.dumps({'source':str(Path(frozen.source).resolve()), 'entrypoint':frozen.entrypoint}))
`,
        ],
        { cwd: root, env: { ...process.env, PYTHONPATH: resolve(import.meta.dirname, '../../python') } },
      )
      const frozen = JSON.parse(result.stdout) as { source: string; entrypoint: string }
      const worker = await createPythonWorker(python, frozen)
      const view = {
        seed_tasks: ['seed'],
        candidates: [
          { id: 'initial', scores: { seed: 0 } },
          { id: 'other', scores: { seed: 0 } },
        ],
        champion: 'initial',
        max_candidates: 2,
        remaining_evaluations: 10,
        random_seed: 'frozen',
        completed: {},
      }
      const run = () => worker.step(view, {}, { runId: 'frozen-author', stepId: 0 }, new AbortController().signal)
      expect((await run()).state.parent).toBe('other')
      await writeFile(join(root, 'policy.py'), 'raise AssertionError("original source is no longer needed")\n')
      expect((await run()).state.parent).toBe('other')
      await writeFile(join(frozen.source, 'policy.py'), 'raise AssertionError("tampered frozen source")\n')
      await expect(run()).rejects.toThrow('Algorithm source changed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 45_000)
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
