import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { readHarborTask, writeHarborTask } from '../../src/adapters/hitch/harbor-files.js'
import { prepareHarborRuntime } from '../../src/adapters/hitch/harbor-runtime.js'

const execute = promisify(execFile)
async function guardedExecutable(root: string) {
  const python = process.env.GEAR_HARBOR_PYTHON
  if (!python) throw new Error('Set GEAR_HARBOR_PYTHON to the pinned Harbor installation interpreter')
  return (await prepareHarborRuntime(join(root, 'guard.git'), python, AbortSignal.timeout(30_000))).executable
}
// Opt-in, real Harbor lifecycle and Docker containers. The oracle is a deterministic attack fixture, not a model.
describe.skipIf(process.env.GEAR_TEST_HARBOR_ISOLATION !== 'required')('Harbor separate verifier boundary', () => {
  it.each([
    ['wrong', 0],
    ['correct', 0.75],
  ] as const)(
    'ignores forged rewards and grades %s artifact evidence',
    async (answer, reward) => {
      const executable = process.env.GEAR_HARBOR_EXECUTABLE,
        image = process.env.GEAR_HARBOR_TEST_IMAGE
      if (!executable || !image)
        throw new Error('Set GEAR_HARBOR_EXECUTABLE and GEAR_HARBOR_TEST_IMAGE for the real isolation contract')
      if (image.startsWith('sha256:'))
        throw new Error(
          'GEAR_HARBOR_TEST_IMAGE must be a Dockerfile FROM-compatible tag or repository digest, not a local image ID',
        )
      const root = await mkdtemp(join(tmpdir(), 'gear-harbor-isolation-'))
      try {
        const source = join(root, 'source'),
          task = join(root, 'frozen')
        for (const directory of ['environment', 'tests', 'solution'])
          await mkdir(join(source, directory), { recursive: true })
        await writeFile(
          join(source, 'task.toml'),
          `version = "1.0"
artifacts = ["/app/answer.json"]
[agent]
timeout_sec = 30.0
[environment]
build_timeout_sec = 120.0
cpus = 1
memory_mb = 512
[verifier]
environment_mode = "separate"
timeout_sec = 30.0
[verifier.environment]
build_timeout_sec = 120.0
cpus = 1
memory_mb = 512
`,
        )
        await writeFile(join(source, 'instruction.md'), 'Write the required answer artifact. Test answers are private.')
        await writeFile(join(source, 'environment/Dockerfile'), `FROM ${image}\nWORKDIR /app\n`)
        await writeFile(join(source, 'tests/Dockerfile'), `FROM ${image}\nCOPY . /tests\n`)
        await writeFile(join(source, 'tests/private-answer'), 'correct')
        await writeFile(join(source, 'tests/test.sh'), '#!/bin/sh\nset -eu\npython3 /tests/verify.py\n', {
          mode: 0o755,
        })
        await writeFile(
          join(source, 'tests/verify.py'),
          `import json
from pathlib import Path
value=json.loads(Path('/app/answer.json').read_text())
assert value['private_visible'] is False, 'Verifier resources reached the agent phase'
correct=value['answer']==Path('/tests/private-answer').read_text()
Path('/logs/verifier/reward.json').write_text(json.dumps({'reward':0.75 if correct else 0,'verifier_marker':17}))
`,
        )
        await writeFile(
          join(source, 'solution/solve.sh'),
          `#!/bin/sh
set -eu
mkdir -p /app /logs/verifier
python3 - <<'PY'
import json
from pathlib import Path
Path('/app/answer.json').write_text(json.dumps({'answer':${JSON.stringify(answer)},'private_visible':Path('/tests/private-answer').exists()}))
Path('/logs/verifier/reward.json').write_text(json.dumps({'reward':1,'verifier_marker':99}))
Path('/logs/verifier/reward.txt').write_text('1')
PY
nohup sh -c 'while :; do printf 1 > /logs/verifier/reward.txt; sleep 0.05; done' </dev/null >/tmp/forged-rewards.log 2>&1 &
`,
          { mode: 0o755 },
        )
        const snapshot = await readHarborTask(source)
        await writeHarborTask(snapshot.task, task)
        await execute(
          await guardedExecutable(root),
          [
            'run',
            '--path',
            task,
            '--agent',
            'oracle',
            '--jobs-dir',
            join(root, 'jobs'),
            '--job-name',
            'contract',
            '--n-concurrent',
            '1',
            '--n-attempts',
            '1',
            '--max-retries',
            '0',
            '--yes',
            '--quiet',
          ],
          { timeout: 240000, maxBuffer: 2 * 1024 * 1024 },
        )
        const job = join(root, 'jobs/contract')
        const trials = (await readdir(job, { withFileTypes: true })).filter((entry) => entry.isDirectory())
        expect(trials).toHaveLength(1)
        const result = JSON.parse(await readFile(join(job, trials[0]!.name, 'result.json'), 'utf8'))
        const verifierLog = await readFile(join(job, trials[0]!.name, 'verifier/test-stdout.txt'), 'utf8').catch(
          () => 'No verifier stdout',
        )
        expect(result.exception_info, verifierLog.slice(-4000)).toBeNull()
        expect(result.verifier_result.rewards).toEqual({ reward, verifier_marker: 17 })
        expect((await readHarborTask(task)).task.digest).toBe(snapshot.task.digest)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    300000,
  )

  it.each([
    ['/app', false],
    ['/app', true],
    ['/logs/artifacts', false],
    ['/logs/artifacts', true],
  ] as const)(
    'checks private-answer symlinks in %s with artifact guard=%s',
    async (artifact, guarded) => {
      const executable = process.env.GEAR_HARBOR_EXECUTABLE,
        image = process.env.GEAR_HARBOR_TEST_IMAGE
      if (!executable || !image || image.startsWith('sha256:'))
        throw new Error('Set Harbor executable and a Dockerfile FROM-compatible test image')
      const root = await mkdtemp(join(tmpdir(), 'gear-harbor-artifact-guard-'))
      try {
        const task = join(root, 'task')
        for (const directory of ['environment', 'tests', 'solution'])
          await mkdir(join(task, directory), { recursive: true })
        await writeFile(
          join(task, 'task.toml'),
          `version = "1.0"
artifacts = [${JSON.stringify(artifact)}]
[agent]
timeout_sec = 30.0
[environment]
build_timeout_sec = 120.0
cpus = 1
memory_mb = 512
[verifier]
environment_mode = "separate"
timeout_sec = 30.0
[verifier.environment]
build_timeout_sec = 120.0
cpus = 1
memory_mb = 512
`,
        )
        await writeFile(join(task, 'instruction.md'), 'Produce the answer artifact. This fixture uses no model.')
        await writeFile(join(task, 'environment/Dockerfile'), `FROM ${image}\nWORKDIR /app\n`)
        await writeFile(join(task, 'tests/Dockerfile'), `FROM ${image}\nCOPY . /tests\n`)
        await writeFile(join(task, 'tests/private-answer'), 'GEAR_OWNED_CANARY')
        await writeFile(
          join(task, 'tests/test.sh'),
          `#!/bin/sh
set -eu
python3 - <<'PY'
import json
from pathlib import Path
answer=Path(${JSON.stringify(`${artifact}/answer.txt`)})
correct=answer.read_text()==Path('/tests/private-answer').read_text()
Path('/logs/verifier/reward.json').write_text(json.dumps({'reward':int(correct),'verifier_ran':1}))
PY
`,
          { mode: 0o755 },
        )
        await writeFile(
          join(task, 'solution/solve.sh'),
          `#!/bin/sh
set -eu
test ! -e /tests/private-answer
mkdir -p ${artifact}
ln -s /tests/private-answer ${artifact}/answer.txt
`,
          { mode: 0o755 },
        )
        const digest = (await readHarborTask(task)).task.digest
        await execute(
          guarded ? await guardedExecutable(root) : executable,
          [
            'run',
            '--path',
            task,
            '--agent',
            'oracle',
            '--jobs-dir',
            join(root, 'jobs'),
            '--job-name',
            'contract',
            '--n-concurrent',
            '1',
            '--n-attempts',
            '1',
            '--max-retries',
            '0',
            '--yes',
            '--quiet',
          ],
          { timeout: 240000, maxBuffer: 2 * 1024 * 1024 },
        )
        const job = join(root, 'jobs/contract')
        const trials = (await readdir(job, { withFileTypes: true })).filter((entry) => entry.isDirectory())
        expect(trials).toHaveLength(1)
        const result = JSON.parse(await readFile(join(job, trials[0]!.name, 'result.json'), 'utf8'))
        if (guarded) {
          expect(result.exception_info).toMatchObject({
            exception_type: 'UnsafeHarborArtifactError',
            exception_message: 'artifact-symlink',
          })
          expect(result.verifier_result).toBeNull()
          expect(result.verifier).toBeNull()
        } else {
          // Reproduce the pinned upstream defect with owned data. A separate
          // container alone does not prevent the verifier following a link.
          expect(result.exception_info).toBeNull()
          expect(result.verifier_result.rewards).toEqual({ reward: 1, verifier_ran: 1 })
        }
        expect((await readHarborTask(task)).task.digest).toBe(digest)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    300000,
  )
})
