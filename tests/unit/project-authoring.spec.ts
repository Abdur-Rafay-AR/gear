import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { piTarget } from '../../src/adapters/pi/target.js'
import { ProjectApplication } from '../../src/application/project.js'
import { initProject } from '../../src/application/project-init.js'
import { projectCommand } from '../../src/cli/project.js'
import { renderProjectResult } from '../../src/cli/project-output.js'
import type { ProjectRun } from '../../src/runtime/project.js'

const roots: string[] = []
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'gear-author-test-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('public algorithm author commands', () => {
  it('checks a factory and one-file parent policy without setup, and renders an author result', async () => {
    const root = await temporary()
    vi.stubEnv('GEAR_PYTHON', process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3')
    await writeFile(
      join(root, 'policy.py'),
      `from gear.algorithms import GEPA
print('author output stays off the JSON channel')
def parent(view): return view.champion
def build(): return GEPA(parent_policy=parent)
`,
    )
    const factory = await projectCommand(['algorithm', 'test', 'policy:build', '--json'], root)
    const parent = await projectCommand(['algorithm', 'test', 'policy:parent', '--kind', 'parent'], root)
    expect(factory).toMatchObject({ ok: true, kind: 'algorithm', nominee: 'candidate-1', scope: 'cpu-toy-contract' })
    expect(parent).toMatchObject({ ok: true, kind: 'parent', nominee: 'candidate-1' })
    expect(renderProjectResult(factory)).toContain('Algorithm offline contract passed: policy:build')
    expect(renderProjectResult(factory)).not.toContain('Environment needs attention')
    await writeFile(
      join(root, 'policy.py'),
      `from gear.algorithms import Decision, Operation
class Invalid:
    def step(self, view, state):
        view.candidates[0].scores['sum'] = 1
        return Decision({}, (Operation('stop'),), 'mutating input')
def build(): return Invalid()
`,
    )
    await expect(projectCommand(['algorithm', 'test', 'policy:build'], root)).rejects.toThrow('algorithm-mutated-input')
  })

  it('validates paired override options and passes a resolved source to the application', async () => {
    const root = await temporary()
    await expect(projectCommand(['refine', '--algorithm-source', './policy'], root)).rejects.toThrow(
      'supplied together',
    )
    await expect(projectCommand(['refine', '--algorithm-entrypoint', 'policy:build'], root)).rejects.toThrow(
      'supplied together',
    )
    await expect(projectCommand(['algorithm', 'test'], root)).rejects.toThrow('requires module:factory')
    await expect(projectCommand(['algorithm', 'test', 'bad-entrypoint'], root)).rejects.toThrow('module:factory')
    const run = vi.spyOn(ProjectApplication.prototype, 'run').mockResolvedValue({} as never)
    await projectCommand(
      ['refine', '--rounds', '2', '--algorithm-source', './policy', '--algorithm-entrypoint', 'policy:build'],
      root,
    )
    expect(run).toHaveBeenCalledWith(
      'refine',
      expect.objectContaining({
        rounds: 2,
        algorithm: { source: resolve(root, 'policy'), entrypoint: 'policy:build' },
      }),
      expect.any(AbortSignal),
    )
  })

  it('persists an override as the run binding without changing gear.yaml', async () => {
    const root = await temporary()
    await initProject(root, piTarget, 'text')
    const original = await readFile(join(root, 'gear.yaml'), 'utf8')
    const app = new ProjectApplication(root, {
      provider: {
        identity: 'author-fixture-provider',
        capabilities: { meteredAttempts: true, recovery: true, isolatedMeta: true, isolatedTarget: true },
        async evaluate() {
          return { status: 'completed', physicalAttempts: 1, output: 'wrong' }
        },
        async inspectEvaluation() {
          return undefined
        },
        async generate(input) {
          return input.parent.files
        },
        async inspectGeneration() {
          return undefined
        },
        async cancel() {},
      },
      algorithm: {
        identity: 'author-fixture-algorithm',
        async step() {
          return {
            state: {},
            operations: [{ kind: 'stop', candidate: '', parent: '', tasks: [] }],
            reason: 'retain baseline',
          }
        },
      },
    })
    const override = { source: './sealed', entrypoint: 'policy:build' }
    const result = await app.run('refine', { algorithm: override }, new AbortController().signal)
    const state = await app.store.read<ProjectRun>(result.run_id)
    expect(state?.plan.binding?.algorithm).toEqual({ ...override, source: join(root, 'sealed') })
    expect(await readFile(join(root, 'gear.yaml'), 'utf8')).toBe(original)
    expect(await app.resume(result.run_id, new AbortController().signal)).toEqual(result)
  })
})
