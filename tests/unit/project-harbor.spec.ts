import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compileHarbor } from '../../src/adapters/hitch/benchmark.js'
import { readHarborTask, writeHarborTask } from '../../src/adapters/hitch/harbor-files.js'
import { loadBenchmark } from '../../src/application/benchmark.js'
import { ProjectApplication } from '../../src/application/project.js'
import { projectReport } from '../../src/application/project-report.js'
import { projectCommand } from '../../src/cli/project.js'
import type { AlgorithmWorker, SearchView } from '../../src/domain/algorithm.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { harborScore, harborTaskDigest, validateHarborTask } from '../../src/domain/harbor.js'
import { scoreOutput } from '../../src/domain/scoring.js'
import type { CachedTrial } from '../../src/ports/evidence-cache.js'
import type { EvaluationInput, ProjectProvider, TrialResult } from '../../src/ports/project.js'
import type { RunStore } from '../../src/ports/run-store.js'
import { type ProjectRun, ProjectRuntime, type RunPlan } from '../../src/runtime/project.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-harbor-'))
  roots.push(root)
  for (const id of ['seed', 'held']) {
    const task = join(root, 'source', id)
    for (const dir of ['environment/empty', 'tests', 'solution']) await mkdir(join(task, dir), { recursive: true })
    await writeFile(
      join(task, 'task.toml'),
      'version = "1.0"\n[metadata]\nauthor = "preserve metadata"\n[environment]\ncpus = 1\n',
    )
    await writeFile(join(task, 'instruction.md'), id === 'held' ? 'PRIVATE-HOLDOUT' : 'Read the public input')
    await writeFile(join(task, 'environment/Dockerfile'), 'FROM scratch\nCOPY data.bin /app/data.bin\n')
    await writeFile(join(task, 'environment/data.bin'), Buffer.from([0, 255, 13, 128]))
    await writeFile(join(task, 'tests/test.sh'), '#!/bin/sh\nexit 71 # static import must never execute this\n')
    await chmod(join(task, 'tests/test.sh'), 0o751)
    await writeFile(join(task, 'tests/oracle.json'), '{"private":"VERIFIER-ANSWER"}')
    await writeFile(join(task, 'solution/solve.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(task, 'environment/empty'), 0o750)
  }
  await writeFile(join(root, 'manifest.csv'), 'id,family,split\nseed,a,seed\nheld,b,held_out\n')
  await writeFile(
    join(root, 'benchmark.yaml'),
    'version: 1\ntemplate: harbor\nsource: ./source\nmanifest: ./manifest.csv\n',
  )
  const load = () => loadBenchmark(join(root, 'benchmark.yaml'), 'holdout')
  return { root, load, task: join(root, 'source/seed') }
}

class MemoryStore implements RunStore {
  values = new Map<string, ProjectRun>()
  async read<T>(id: string) {
    return structuredClone(this.values.get(id)) as T | undefined
  }
  async write(id: string, state: unknown) {
    this.values.set(id, structuredClone(state) as ProjectRun)
  }
  async locked<T>(_id: string, operation: () => Promise<T>) {
    return operation()
  }
  async cancelRequested() {
    return false
  }
  async requestCancel() {}
  get run() {
    return [...this.values.values()].at(-1)!
  }
}
async function runtimeFixture() {
  const f = await fixture(),
    benchmark = await f.load(),
    store = new MemoryStore()
  const results = new Map<string, TrialResult>(),
    calls: EvaluationInput[] = [],
    views: SearchView[] = []
  const cache = new Map<string, CachedTrial>()
  const provider: ProjectProvider = {
    identity: 'trusted-harbor-fixture-v1',
    capabilities: {
      meteredAttempts: true,
      recovery: true,
      isolatedTarget: true,
      isolatedMeta: true,
      harborVerification: true,
      observedConditions: true,
    },
    async evaluate(input) {
      calls.push(structuredClone(input))
      const result: TrialResult = {
        status: 'completed',
        physicalAttempts: 1,
        conditionDigest: canonicalDigest(['environment', input.task.id]),
        output: '1',
        verification: {
          operationId: input.operationId,
          taskDigest: input.task.harbor!.digest,
          metrics: { reward: input.target.id === 'initial' ? 0 : 0.75, auxiliary: -3 },
        },
      }
      results.set(input.operationId, result)
      return result
    },
    async inspectEvaluation(id) {
      return results.get(id)
    },
    async generate(input) {
      expect(JSON.stringify(input)).not.toMatch(/PRIVATE-HOLDOUT|VERIFIER-ANSWER|oracle.json|base64/)
      return { 'AGENTS.md': 'better' }
    },
    async inspectGeneration() {
      return undefined
    },
    async cancel() {},
  }
  const algorithm: AlgorithmWorker = {
    identity: 'harbor-fixture-algorithm-v1',
    async step(view, state) {
      views.push(view)
      const n = Number(state.n ?? 0)
      const operations = [
        { kind: 'generate' as const, candidate: 'next', parent: 'initial', tasks: [] },
        { kind: 'evaluate_seed' as const, candidate: 'next', parent: '', tasks: ['seed'] },
        { kind: 'nominate' as const, candidate: 'next', parent: '', tasks: [] },
      ]
      return { state: { n: n + 1 }, operations: [operations[n]!], reason: 'fixture' }
    },
  }
  const plan: RunPlan = {
    kind: 'refine',
    target: { id: 'initial', digest: 'initial', files: { 'AGENTS.md': 'initial' } },
    providerIdentity: provider.identity,
    algorithmIdentity: algorithm.identity,
    validation: 'holdout',
    maxEvaluations: 4,
    maxCandidates: 1,
    split: 'seed',
    taskIds: ['seed'],
    benchmark,
  }
  const runtime = new ProjectRuntime(store, provider, algorithm, async () => {}, undefined, {
    async find(id) {
      return cache.get(id)
    },
    async save(trial) {
      cache.set(trial.identity, structuredClone(trial))
    },
  })
  return { ...f, benchmark, store, results, calls, views, provider, algorithm, plan, runtime, cache }
}
const signal = () => new AbortController().signal

async function observedFixture() {
  const f = await runtimeFixture()
  f.provider.capabilities.observedConditions = true
  const evaluate = f.provider.evaluate.bind(f.provider)
  f.provider.evaluate = async (input, signal) => {
    const result = await evaluate(input, signal)
    result.conditionDigest = canonicalDigest(['environment', input.task.id])
    return result
  }
  return {
    ...f,
    runtime: new ProjectRuntime(f.store, f.provider, f.algorithm, async () => {}, undefined, {
      async find() {
        throw new Error('static cache cannot certify observed conditions')
      },
      async save() {
        throw new Error('observed conditions must not enter the static cache')
      },
    }),
  }
}

describe('observed execution conditions', () => {
  it('pairs within each task, binds seed views, and executes a fresh run without static cache reuse', async () => {
    const f = await observedFixture()
    const first = await f.runtime.start(f.plan, signal())
    expect(first.plan.conditionEvidence).toBe('required')
    expect(first.champion).toBe('next')
    expect(first.trials[0]!.result.conditionDigest).not.toBe(first.trials[2]!.result.conditionDigest)
    expect(await f.runtime.resume(first.id, signal())).toEqual(first)
    await f.runtime.start(f.plan, signal())
    expect(f.calls).toHaveLength(8)
    const before = f.views[0]!.evidence_condition
    const evaluate = f.provider.evaluate.bind(f.provider)
    f.provider.evaluate = async (input, s) => {
      const result = await evaluate(input, s)
      result.conditionDigest = canonicalDigest(['new-environment', input.task.id])
      return result
    }
    await f.runtime.start(f.plan, signal())
    expect(f.views.at(-1)!.evidence_condition).not.toBe(before)
    expect(f.calls).toHaveLength(12)
  })
  it.each(['seed', 'held'] as const)(
    'persists a %s mismatch as invalid and never promotes or resubmits it',
    async (taskId) => {
      const f = await observedFixture()
      const evaluate = f.provider.evaluate.bind(f.provider)
      f.provider.evaluate = async (input, s) => {
        const result = await evaluate(input, s)
        if (input.target.id === 'next' && input.task.id === taskId)
          result.conditionDigest = canonicalDigest('changed image')
        return result
      }
      await expect(f.runtime.start(f.plan, signal())).rejects.toMatchObject({
        details: { code: 'incomplete-evidence' },
      })
      const run = f.store.run
      const invalid = run.trials.find((t) => t.taskId === taskId && t.candidate === 'next')!
      expect(invalid.score).toBeNull()
      expect(invalid.scoreDetails).toEqual({ valid: false, reason: 'execution-condition-mismatch' })
      expect(run.champion).toBe('initial')
      expect(run.gate).toBeUndefined()
      expect(projectReport(run)).toMatchObject({ physicalAttempts: taskId === 'seed' ? 2 : 4, reservedAttempts: 0 })
      const count = f.calls.length
      await expect(f.runtime.resume(run.id, signal())).rejects.toMatchObject({
        details: { code: 'incomplete-evidence' },
      })
      expect(f.calls).toHaveLength(count)
      expect(
        f.views.every(
          (view) => taskId !== 'seed' || view.candidates.every((c) => c.id !== 'next' || !Object.keys(c.scores).length),
        ),
      ).toBe(true)
    },
  )
  it('accounts a missing baseline attestation as invalid and never starts the algorithm', async () => {
    const f = await observedFixture()
    const evaluate = f.provider.evaluate.bind(f.provider)
    f.provider.evaluate = async (input, s) => {
      const result = await evaluate(input, s)
      delete result.conditionDigest
      return result
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toMatchObject({ details: { code: 'incomplete-evidence' } })
    expect(f.store.run.trials[0]).toMatchObject({
      score: null,
      scoreDetails: { reason: 'execution-condition-missing' },
    })
    expect(projectReport(f.store.run)).toMatchObject({ physicalAttempts: 1, reservedAttempts: 0 })
    expect(f.views).toHaveLength(0)
  })
  it.each(['array', 'malformed'] as const)(
    'rejects a %s attestation without releasing the reservation',
    async (kind) => {
      const f = await observedFixture()
      const evaluate = f.provider.evaluate.bind(f.provider)
      f.provider.evaluate = async (input, s) => {
        const result = await evaluate(input, s)
        result.conditionDigest = (kind === 'array' ? [canonicalDigest('environment')] : 'not-a-digest') as never
        return result
      }
      await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('invalid-provider-result')
      expect(f.store.run.trials).toHaveLength(0)
      expect(projectReport(f.store.run)).toMatchObject({ physicalAttempts: 0, reservedAttempts: 1 })
      expect(f.calls).toHaveLength(1)
    },
  )
  it('keeps held-out condition details out of the seed condition identity', async () => {
    const f = await observedFixture()
    await f.runtime.start(f.plan, signal())
    const condition = f.views[0]!.evidence_condition
    const evaluate = f.provider.evaluate.bind(f.provider)
    f.provider.evaluate = async (input, s) => {
      const result = await evaluate(input, s)
      if (input.task.id === 'held') result.conditionDigest = canonicalDigest('different held-out environment')
      return result
    }
    expect((await f.runtime.start(f.plan, signal())).champion).toBe('next')
    expect(f.views.at(-1)!.evidence_condition).toBe(condition)
  })
  it('preserves infrastructure failure classification when there is no scorable observation', async () => {
    const f = await observedFixture()
    f.provider.evaluate = async () => ({ status: 'infrastructure-failed', physicalAttempts: 1, reason: 'build failed' })
    const run = await f.runtime.start({ ...f.plan, kind: 'evaluate' }, signal())
    expect(run.trials[0]).toMatchObject({ score: null, scoreDetails: { reason: 'infrastructure-failed' } })
    expect(projectReport(run)).toMatchObject({ physicalAttempts: 1, reservedAttempts: 0 })
  })
  it('validates recovered conditions before comparison without another physical attempt', async () => {
    const f = await observedFixture()
    const evaluate = f.provider.evaluate.bind(f.provider)
    f.provider.evaluate = async (input, s) => {
      const result = await evaluate(input, s)
      if (input.target.id === 'next') {
        result.conditionDigest = canonicalDigest('drift before response loss')
        throw new Error('response lost')
      }
      return result
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('response lost')
    expect(projectReport(f.store.run)).toMatchObject({ physicalAttempts: 1, reservedAttempts: 1 })
    await expect(f.runtime.resume(f.store.run.id, signal())).rejects.toMatchObject({
      details: { code: 'incomplete-evidence' },
    })
    expect(projectReport(f.store.run)).toMatchObject({ physicalAttempts: 2, reservedAttempts: 0 })
    expect(f.store.run.trials[1]!.scoreDetails?.reason).toBe('execution-condition-mismatch')
    expect(f.calls).toHaveLength(2)
  })
  it('freezes the attestation requirement across recovery even if provider identity is incorrectly reused', async () => {
    const f = await observedFixture()
    const run = await f.runtime.start({ ...f.plan, kind: 'evaluate' }, signal())
    delete f.provider.capabilities.observedConditions
    await expect(f.runtime.resume(run.id, signal())).rejects.toMatchObject({ details: { code: 'identity-mismatch' } })
    expect(f.calls).toHaveLength(1)
  })
})

describe('existing Harbor task import', () => {
  for (const adapter of ['dsh', 'pi'])
    it(`imports complete resources with ${adapter} and survives removal of source`, async () => {
      const f = await fixture(),
        original = await f.load(),
        root = join(f.root, 'project')
      await projectCommand(
        [
          'init',
          root,
          '--adapter',
          adapter,
          '--template',
          'harbor',
          '--from',
          join(f.root, 'source'),
          '--manifest',
          join(f.root, 'manifest.csv'),
        ],
        f.root,
      )
      await rm(join(f.root, 'source'), { recursive: true })
      const imported = await loadBenchmark(join(root, 'benchmark.yaml'), 'holdout')
      expect(imported.tasks.map((t) => t.harbor)).toEqual(original.tasks.map((t) => t.harbor))
      expect(imported.tasks.every((t) => !t.fixtures)).toBe(true)
      const app = new ProjectApplication(root),
        checked = await app.check('meta')
      expect(checked.checks).toEqual({ static: 'passed', verifierFixtures: 'not_run', runtime: 'not_run' })
      expect(JSON.stringify(checked)).not.toMatch(/PRIVATE-HOLDOUT|VERIFIER-ANSWER|base64|oracle.json/)
      const compiled = await app.compile()
      expect((await readHarborTask(join(compiled.root, 'seed/seed'))).task).toEqual(original.tasks[0]!.harbor)
      expect((await readHarborTask(join(compiled.root, 'held_out/held'))).task).toEqual(original.tasks[1]!.harbor)
      expect(await app.compile()).toEqual(compiled)
    })
  it('supports explicit JSONL paths, named metrics and research-only imports', async () => {
    const f = await fixture()
    await writeFile(
      join(f.root, 'manifest.jsonl'),
      JSON.stringify({ id: 'renamed', path: 'seed', family: 'f', split: 'seed', metric: 'correctness' }),
    )
    await writeFile(
      join(f.root, 'benchmark.yaml'),
      'version: 1\ntemplate: harbor\nsource: ./source\nmanifest: ./manifest.jsonl\n',
    )
    await expect(f.load()).rejects.toThrow(/independent/)
    const spec = await loadBenchmark(join(f.root, 'benchmark.yaml'), 'research')
    expect(spec.tasks[0]).toMatchObject({ id: 'renamed', scorer: { kind: 'harbor', metric: 'correctness' } })
  })
  it('rejects an explicit project objective that disagrees with the imported metric', async () => {
    const f = await fixture(),
      root = join(f.root, 'project')
    await projectCommand(
      [
        'init',
        root,
        '--adapter',
        'pi',
        '--template',
        'harbor',
        '--from',
        join(f.root, 'source'),
        '--manifest',
        join(f.root, 'manifest.csv'),
      ],
      f.root,
    )
    const config = join(root, 'gear.yaml')
    await writeFile(config, (await readFile(config, 'utf8')).replace('metric: reward', 'metric: pass_rate'))
    const app = new ProjectApplication(root)
    await expect(app.check()).rejects.toThrow(/objective must match/)
    await expect(app.compile()).rejects.toThrow(/objective must match/)
    await expect(app.run('evaluate', {}, signal())).rejects.toThrow(/objective must match/)
  })
  it.each(['bytes', 'mode', 'empty-directory'] as const)(
    'changes identity when private resource %s changes',
    async (change) => {
      const f = await fixture(),
        before = await f.load()
      if (change === 'bytes') await writeFile(join(f.task, 'tests/oracle.json'), 'changed')
      if (change === 'mode') await chmod(join(f.task, 'tests/test.sh'), 0o700)
      if (change === 'empty-directory') await mkdir(join(f.task, 'environment/another-empty'))
      const after = await f.load()
      expect(after.digest).not.toBe(before.digest)
      expect(after.tasks[0]!.harbor!.digest).not.toBe(before.tasks[0]!.harbor!.digest)
    },
  )
  it.each([
    'duplicate',
    'case-collision',
    'family-leak',
    'escape',
    'symlink',
    'hardlink',
    'missing-verifier',
    'bad-toml',
  ] as const)('rejects %s without executing task code', async (problem) => {
    const f = await fixture()
    if (problem === 'duplicate')
      await writeFile(join(f.root, 'manifest.csv'), 'id,family,split\nseed,a,seed\nseed,b,held_out\n')
    if (problem === 'case-collision')
      await writeFile(join(f.root, 'manifest.csv'), 'id,path,family,split\nseed,seed,a,seed\nSEED,held,b,held_out\n')
    if (problem === 'family-leak')
      await writeFile(join(f.root, 'manifest.csv'), 'id,family,split\nseed,a,seed\nheld,a,held_out\n')
    if (problem === 'escape')
      await writeFile(join(f.root, 'manifest.csv'), 'id,path,family,split\nseed,../seed,a,seed\nheld,held,b,held_out\n')
    if (problem === 'symlink') await symlink(join(f.task, 'task.toml'), join(f.task, 'environment/link'))
    if (problem === 'hardlink') await link(join(f.task, 'task.toml'), join(f.task, 'environment/link'))
    if (problem === 'missing-verifier') await rm(join(f.task, 'tests/test.sh'))
    if (problem === 'bad-toml') await writeFile(join(f.task, 'task.toml'), 'version = "unterminated')
    await expect(f.load()).rejects.toThrow()
  })
  it('rejects a linked ancestor selected through the manifest', async () => {
    const f = await fixture()
    await symlink(join(f.root, 'source'), join(f.root, 'source/link'))
    await writeFile(join(f.root, 'manifest.csv'), 'id,path,family,split\nseed,link/seed,a,seed\nheld,held,b,held_out\n')
    await expect(f.load()).rejects.toThrow(/symbolic/)
  })
  it('rejects forged bytes, unsafe paths, missing directories and destination drift', async () => {
    const f = await fixture(),
      spec = await f.load(),
      task = spec.tasks[0]!.harbor!
    for (const mutate of [
      (t: typeof task) => {
        t.files[0]!.base64 += ' '
      },
      (t: typeof task) => {
        t.files[0]!.path = '../escape'
      },
      (t: typeof task) => {
        t.files[0]!.path = 'bad\npath'
      },
      (t: typeof task) => {
        t.files[0]!.mode = 0o4777
      },
      (t: typeof task) => {
        t.directories = []
      },
    ]) {
      const changed = structuredClone(task)
      mutate(changed)
      changed.digest = harborTaskDigest(changed.files, changed.directories)
      expect(() => validateHarborTask(changed)).toThrow()
    }
    const dest = join(f.root, 'compiled')
    await compileHarbor(spec, dest, 'seed')
    await writeFile(join(dest, 'seed/extra'), 'untracked verifier resource')
    await expect(writeHarborTask(task, join(dest, 'seed'))).rejects.toThrow(/conflict/)
    await rm(join(dest, 'seed/extra'))
    await chmod(join(dest, 'seed/environment/empty'), 0o700)
    await expect(writeHarborTask(task, join(dest, 'seed'))).rejects.toThrow(/conflict/)
    expect(await readFile(join(dest, 'seed/tests/oracle.json'), 'utf8')).toContain('VERIFIER-ANSWER')
  })
})

describe('Harbor verifier evidence', () => {
  it('requires explicit provider capability before reserving or running any evaluation', async () => {
    const f = await runtimeFixture()
    delete f.provider.capabilities.harborVerification
    await expect(f.runtime.start(f.plan, signal())).rejects.toMatchObject({
      details: { code: 'harbor-provider-required' },
    })
    expect(f.calls).toHaveLength(0)
    expect(f.store.values.size).toBe(0)
  })
  it('requires actual-condition evidence capability before accepting a Harbor provider', async () => {
    const f = await runtimeFixture()
    delete f.provider.capabilities.observedConditions
    const runtime = new ProjectRuntime(f.store, f.provider, f.algorithm, async () => {})
    await expect(runtime.start(f.plan, signal())).rejects.toMatchObject({
      details: { code: 'harbor-condition-evidence-required' },
    })
    expect(f.calls).toHaveLength(0)
    expect(f.store.values.size).toBe(0)
  })
  it('preserves valid zero, fractional rewards, terminal recovery and private resources', async () => {
    const f = await runtimeFixture(),
      run = await f.runtime.start(f.plan, signal()),
      report = projectReport(run)
    expect(run.champion).toBe('next')
    expect(run.gate).toMatchObject({ policy: 'paired-mean-reward-v1', accepted: true, before: 0, after: 0.75 })
    expect(report.candidates[0]!.partitions[0]).toMatchObject({ validZero: 1, meanScore: 0, passRate: null })
    expect(report.verifierMetrics[1]!.verification!.metrics).toEqual({ reward: 0.75, auxiliary: -3 })
    expect(JSON.stringify(f.views)).not.toMatch(/PRIVATE-HOLDOUT|VERIFIER-ANSWER|oracle.json|base64/)
    expect(JSON.stringify(projectReport(run, 'meta'))).not.toMatch(/held_out|PRIVATE-HOLDOUT/)
    f.results.values().next().value!.verification!.metrics.reward = 1
    expect(run.trials[0]!.result.verification!.metrics.reward).toBe(0)
    const resumed = await f.runtime.resume(run.id, signal())
    expect(resumed.gate).toEqual(run.gate)
    const nextRun = await f.runtime.start(f.plan, signal())
    expect(nextRun.trials.map((t) => t.score)).toEqual([0, 0.75, 0, 0.75])
    expect(nextRun.trials.every((t) => t.reusedFrom === undefined)).toBe(true)
    expect(projectReport(nextRun).physicalAttempts).toBe(4)
    expect(f.calls).toHaveLength(8)
    expect(f.cache.size).toBe(0)
  })
  it.each(['missing', 'operation', 'task', 'out-of-range', 'missing-metric', 'task-failed', 'scorer-failed'] as const)(
    'accounts %s evidence as invalid, never an invented zero or cached result',
    async (problem) => {
      const f = await runtimeFixture(),
        evaluate = f.provider.evaluate.bind(f.provider)
      f.provider.evaluate = async (input, s) => {
        const r = await evaluate(input, s)
        if (problem === 'missing' || problem === 'task-failed') delete r.verification
        if (problem === 'task-failed') r.status = 'task-failed'
        if (problem === 'scorer-failed') r.status = 'scorer-failed'
        if (problem === 'operation') r.verification!.operationId = 'foreign'
        if (problem === 'task') r.verification!.taskDigest = 'foreign'
        if (problem === 'out-of-range') r.verification!.metrics.reward = 7
        if (problem === 'missing-metric') delete r.verification!.metrics.reward
        return r
      }
      const run = await f.runtime.start({ ...f.plan, kind: 'evaluate' }, signal())
      expect(run.trials[0]!.score).toBeNull()
      expect(projectReport(run)).toMatchObject({
        physicalAttempts: 1,
        reservedAttempts: 0,
        failures: [{ scoringStatus: 'invalid' }],
      })
      expect(f.cache.size).toBe(0)
      expect(scoreOutput(f.benchmark.tasks[0]!.scorer, '1').valid).toBe(false)
    },
  )
  it('recovers a lost response from the verifier journal without a second paid attempt', async () => {
    const f = await runtimeFixture(),
      evaluate = f.provider.evaluate.bind(f.provider)
    f.provider.evaluate = async (input, s) => {
      await evaluate(input, s)
      throw new Error('lost response')
    }
    await expect(f.runtime.start({ ...f.plan, kind: 'evaluate' }, signal())).rejects.toThrow('lost response')
    expect(projectReport(f.store.run)).toMatchObject({ physicalAttempts: 0, reservedAttempts: 1 })
    const run = await f.runtime.resume(f.store.run.id, signal())
    expect(run.trials[0]!.score).toBe(0)
    expect(projectReport(run)).toMatchObject({ physicalAttempts: 1, reservedAttempts: 0 })
    expect(f.calls).toHaveLength(1)
  })
  it('keeps unknown attempts reserved and never resubmits them', async () => {
    const f = await runtimeFixture()
    f.provider.evaluate = async (input) => {
      f.calls.push(input)
      throw new Error('unknown submission')
    }
    await expect(f.runtime.start({ ...f.plan, kind: 'evaluate' }, signal())).rejects.toThrow('unknown submission')
    await expect(f.runtime.resume(f.store.run.id, signal())).rejects.toThrow('will not be resubmitted')
    expect(projectReport(f.store.run)).toMatchObject({ physicalAttempts: 0, reservedAttempts: 1 })
    expect(f.calls).toHaveLength(1)
  })
  it('isolates provider input mutations from the frozen task and Target', async () => {
    const f = await runtimeFixture(),
      evaluate = f.provider.evaluate.bind(f.provider)
    f.provider.evaluate = async (input, s) => {
      const result = await evaluate(input, s)
      input.task.harbor!.files.length = 0
      input.target.files['AGENTS.md'] = 'provider mutation'
      return result
    }
    const run = await f.runtime.start({ ...f.plan, kind: 'evaluate' }, signal())
    expect(run.plan.target.files['AGENTS.md']).toBe('initial')
    expect(run.plan.benchmark.tasks[0]!.harbor).toEqual(f.benchmark.tasks[0]!.harbor)
    expect(run.trials[0]!.score).toBe(0)
    expect(await f.runtime.resume(run.id, signal())).toEqual(run)
  })
  it('rejects nonfinite, string and malformed metric values', () => {
    for (const metrics of [{ reward: NaN }, { reward: Infinity }, { reward: '1' }, []])
      expect(
        harborScore({ operationId: 'op', taskDigest: 'task', metrics } as never, 'op', 'task', 'reward').valid,
      ).toBe(false)
  })
})
