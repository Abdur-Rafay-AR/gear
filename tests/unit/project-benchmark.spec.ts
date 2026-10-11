import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { piTarget } from '../../src/adapters/pi/target.js'
import { loadBenchmark, parseCSV } from '../../src/application/benchmark.js'
import { ProjectApplication } from '../../src/application/project.js'
import { initProject } from '../../src/application/project-init.js'
import { scoreOutput } from '../../src/application/scoring.js'
import { projectCommand } from '../../src/cli/project.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(template: 'text' | 'json' | 'file' = 'text') {
  const root = await mkdtemp(join(tmpdir(), 'gear-benchmark-test-'))
  roots.push(root)
  await initProject(root, piTarget, template)
  return root
}
describe('benchmark author journey', () => {
  for (const template of ['text', 'json', 'file'] as const)
    it(`checks and compiles ${template} without a model`, async () => {
      const root = await fixture(template),
        app = new ProjectApplication(root)
      expect((await app.check()).checks).toEqual({ static: 'passed', verifierFixtures: 'passed', runtime: 'not_run' })
      expect((await app.check('meta')).tasks.every((task) => task.split === 'seed')).toBe(true)
      const compiled = await app.compile()
      const image = await readFile(join(compiled.root, 'seed/sum-01/environment/Dockerfile'), 'utf8')
      const instruction = await readFile(join(compiled.root, 'seed/sum-01/instruction.md'), 'utf8')
      expect(image).not.toContain('scorer.json')
      expect(instruction).not.toContain('expected')
      expect(
        JSON.parse(await readFile(join(compiled.root, 'seed/sum-01/tests/scorer.json'), 'utf8')).expected,
      ).toBeDefined()
    })
  it('freezes input files and compiles them separately from verifier-only answers', async () => {
    const root = await fixture()
    await writeFile(join(root, 'data.txt'), 'public task input')
    await writeFile(join(root, 'benchmark.yaml'), 'version: 1\nsource: ./tasks.jsonl\ntemplate: text\n')
    const table = [
      {
        id: 'seed',
        instruction: 'Read /app/inputs/data.txt',
        expected: 'private answer',
        family: 'a',
        split: 'seed',
        inputs: 'data.txt',
      },
      { id: 'held', instruction: 'B', expected: 'B', family: 'b', split: 'held_out' },
    ]
    await writeFile(join(root, 'tasks.jsonl'), table.map((t) => JSON.stringify(t)).join('\n'))
    const before = await loadBenchmark(join(root, 'benchmark.yaml'), 'holdout')
    expect(Buffer.from(before.tasks[0]!.inputs![0]!.base64, 'base64').toString()).toBe('public task input')
    const compiled = await new ProjectApplication(root).compile()
    expect(await readFile(join(compiled.root, 'seed/seed/environment/inputs/data.txt'), 'utf8')).toBe(
      'public task input',
    )
    expect(await readFile(join(compiled.root, 'seed/seed/instruction.md'), 'utf8')).not.toContain('private answer')
    await writeFile(join(root, 'data.txt'), 'changed input')
    expect((await loadBenchmark(join(root, 'benchmark.yaml'), 'holdout')).digest).not.toBe(before.digest)
    await rm(join(root, 'data.txt'))
    await symlink('/etc/hosts', join(root, 'data.txt'))
    await expect(loadBenchmark(join(root, 'benchmark.yaml'), 'holdout')).rejects.toThrow(/directory|symbolic/)
  })
  it('imports a task table and its inputs into a self-contained project', async () => {
    const source = await fixture()
    await writeFile(join(source, 'input.txt'), 'portable input')
    await writeFile(
      join(source, 'import.jsonl'),
      [
        { id: 'seed', instruction: 'A', expected: 'A', family: 'a', split: 'seed', inputs: 'input.txt' },
        { id: 'held', instruction: 'B', expected: 'B', family: 'b', split: 'held_out' },
      ]
        .map((t) => JSON.stringify(t))
        .join('\n'),
    )
    const destination = join(source, 'new-project')
    await projectCommand(['init', destination, '--adapter', 'pi', '--from', join(source, 'import.jsonl')], source)
    await rm(join(source, 'input.txt'))
    await rm(join(source, 'import.jsonl'))
    const benchmark = await loadBenchmark(join(destination, 'benchmark.yaml'), 'holdout')
    expect(benchmark.tasks).toHaveLength(2)
    expect(Buffer.from(benchmark.tasks[0]!.inputs![0]!.base64, 'base64').toString()).toBe('portable input')
  })
  it('handles quoted newlines, escaped quotes, CRLF and BOM with locations', () => {
    expect(parseCSV('\uFEFFid,instruction\r\na,"line 1\nline ""2"""\r\n', 'tasks.csv')).toEqual([
      { line: 2, values: { id: 'a', instruction: 'line 1\nline "2"' } },
    ])
    expect(parseCSV('a,b\n,\n', 'x')).toEqual([{ line: 2, values: { a: '', b: '' } }])
    expect(() => parseCSV('id,id\na,b', 'x')).toThrow(/unique/)
    expect(() => parseCSV('id,x\na,"unterminated', 'x')).toThrow(/Unterminated/)
  })
  it('rejects cross-split family leakage and allows only explicit shared-set research', async () => {
    const root = await fixture(),
      path = join(root, 'tasks.csv')
    await writeFile(path, 'id,instruction,expected,family,split\na,A,A,f,seed\nb,B,B,f,held_out\n')
    await expect(loadBenchmark(join(root, 'benchmark.yaml'), 'holdout')).rejects.toThrow(/crosses/)
    await writeFile(path, 'id,instruction,expected,family,split\na,A,A,f,seed\n')
    await expect(loadBenchmark(join(root, 'benchmark.yaml'), 'holdout')).rejects.toThrow(/requires independent/)
    expect((await loadBenchmark(join(root, 'benchmark.yaml'), 'research')).tasks).toHaveLength(1)
  })
  it('distinguishes missing evidence, a valid zero and typed JSON assertions', () => {
    const scorer = { kind: 'json' as const, expected: { answer: 5 } }
    expect(scoreOutput(scorer, '{"answer": "5"}')).toMatchObject({ valid: true, value: 0 })
    expect(scoreOutput(scorer, '{"answer":5,"extra":1}').value).toBe(1)
    expect(scoreOutput(scorer, undefined)).toEqual({ valid: false, reason: 'missing-output' })
  })
  it('rejects unknown options and preserves nonempty directories', async () => {
    const root = await fixture()
    await expect(projectCommand(['benchmark', 'check', '--typo', 'x'], root)).rejects.toThrow(/Unknown/)
    await expect(initProject(root, piTarget, 'text')).rejects.toThrow(/empty/)
  })
})
