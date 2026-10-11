import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BenchmarkSpec, Split } from '../../domain/benchmark.js'

const verifier = `import json, pathlib
spec = json.loads(pathlib.Path('/tests/scorer.json').read_text())
output = pathlib.Path(spec.get('path', '/app/answer.txt'))
def equal(expected, actual):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and equal(v, actual[k]) for k,v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(expected) == len(actual) and all(equal(a,b) for a,b in zip(expected,actual))
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return isinstance(actual, (int, float)) and not isinstance(actual, bool) and expected == actual
    return type(expected) is type(actual) and expected == actual
value = 0
if any(p.is_symlink() for p in (output, *output.parents)):
    raise ValueError('unsafe-output-file')
if output.exists() and (not output.is_file() or output.stat().st_size > 1048576 or output.stat().st_nlink > 1):
    raise ValueError('unsafe-output-file')
if output.is_file():
    text = output.read_text()
    if spec['kind'] == 'json':
        try: value = int(equal(spec['expected'], json.loads(text)))
        except (ValueError, TypeError): pass
    else:
        normalize = (lambda x: x.strip()) if spec['normalization'] == 'trim' else (lambda x: x)
        value = int(normalize(text) == normalize(spec['expected']))
pathlib.Path('/logs/verifier').mkdir(parents=True, exist_ok=True)
pathlib.Path('/logs/verifier/reward.txt').write_text(str(value))
`

/** Expected answers exist only in verifier resources, never instructions or image layers. */
export async function compileHarbor(spec: BenchmarkSpec, destination: string, split: Split): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const task of spec.tasks.filter((item) => item.split === split)) {
    const root = join(destination, task.id)
    await mkdir(join(root, 'environment'), { recursive: true })
    await mkdir(join(root, 'tests'), { recursive: true, mode: 0o700 })
    const path = task.scorer.kind === 'file' ? task.scorer.path : '/app/answer.txt'
    await writeFile(
      join(root, 'instruction.md'),
      `${task.instruction}${task.inputs?.length ? `\nInput files: ${task.inputs.map((f) => `/app/${f.path}`).join(', ')}` : ''}\n\nWrite your result to ${path}.\n`,
    )
    await writeFile(
      join(root, 'task.toml'),
      'version = "1.0"\n[verifier]\ntimeout_sec = 30\n[agent]\ntimeout_sec = 300\n[environment]\nbuild_timeout_sec = 300\ncpus = 1\nmemory_mb = 1024\nstorage_mb = 2048\n',
    )
    await writeFile(
      join(root, 'environment/Dockerfile'),
      `FROM python:3.12-slim\nWORKDIR /app\n${task.inputs?.length ? 'COPY inputs /app/inputs\n' : ''}`,
    )
    for (const input of task.inputs ?? []) {
      await mkdir(dirname(join(root, 'environment', input.path)), { recursive: true })
      await writeFile(join(root, 'environment', input.path), Buffer.from(input.base64, 'base64'))
    }
    await writeFile(join(root, 'tests/scorer.json'), JSON.stringify(task.scorer), { mode: 0o600 })
    await writeFile(join(root, 'tests/verify.py'), verifier)
    await writeFile(join(root, 'tests/test.sh'), '#!/bin/sh\nset -eu\npython3 /tests/verify.py\n', { mode: 0o700 })
  }
}
