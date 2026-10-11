import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { readHarborTask, writeHarborTask } from '../../src/adapters/hitch/harbor-files.js'

const execute = promisify(execFile)
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
          executable,
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
})
