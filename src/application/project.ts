import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DockerProjectProvider } from '../adapters/docker/provider.js'
import { dshTarget } from '../adapters/dsh/target.js'
import { compileHarbor } from '../adapters/hitch/benchmark.js'
import { piTarget } from '../adapters/pi/target.js'
import { createPythonWorker } from '../adapters/python/worker.js'
import { atomicJSON } from '../adapters/storage/atomic.js'
import { ProjectEvidenceCache } from '../adapters/storage/evidence-cache.js'
import { ProjectRunStore } from '../adapters/storage/project-store.js'
import { TargetSnapshots } from '../adapters/storage/target-snapshots.js'
import type { AlgorithmWorker } from '../domain/algorithm.js'
import type { Split } from '../domain/benchmark.js'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError, invalid } from '../domain/errors.js'
import type { ProjectProvider } from '../ports/project.js'
import { type ProjectRun, ProjectRuntime, type RunPlan } from '../runtime/project.js'
import { loadBenchmark } from './benchmark.js'
import { environment } from './environment.js'
import { type ProjectConfig, readProject, resolveProjectAlgorithm } from './project-config.js'
import { projectReport } from './project-report.js'
import { projectRuntimeIdentity } from './runtime-identity.js'
import { targetFiles, validateTargetFiles } from './target-files.js'

export const targetAdapter = (name: 'dsh' | 'pi') => (name === 'dsh' ? dshTarget : piTarget)
export interface ProjectDependencies {
  provider: ProjectProvider
  algorithm: AlgorithmWorker
}
export class ProjectApplication {
  readonly store: ProjectRunStore
  constructor(
    readonly root: string,
    readonly dependencies?: ProjectDependencies,
  ) {
    this.store = new ProjectRunStore(join(root, '.gear'))
  }
  async check(view: 'operator' | 'meta' = 'operator') {
    const config = await readProject(this.root),
      benchmark = await loadBenchmark(config.benchmark, config.validation.mode)
    const adapter = targetAdapter(config.target.adapter)
    await targetFiles(config.target.path, adapter)
    return {
      ok: true,
      digest: benchmark.digest,
      checks: { static: 'passed', verifierFixtures: 'passed', runtime: 'not_run' },
      tasks: benchmark.tasks
        .filter((task) => view === 'operator' || task.split === 'seed')
        .map((task) => ({
          id: task.id,
          split: task.split,
          instruction: task.instruction,
          scorer: task.scorer,
          fixtures: task.fixtures,
          inputs: task.inputs?.map(({ path, digest }) => ({ path, digest })) ?? [],
        })),
      target: adapter.describe(),
    }
  }
  async compile() {
    const config = await readProject(this.root),
      spec = await loadBenchmark(config.benchmark, config.validation.mode)
    const root = join(this.root, '.gear/benchmarks', spec.digest.slice(7))
    for (const split of ['seed', 'held_out'] as const) await compileHarbor(spec, join(root, split), split)
    await atomicJSON(join(root, 'manifest.json'), spec)
    return { root, digest: spec.digest }
  }
  private async runtime(
    adapterId: 'dsh' | 'pi',
    targetProfile: string,
    metaProfile: string,
    algorithmConfig: ProjectConfig['algorithm'],
  ) {
    if (this.dependencies)
      return new ProjectRuntime(this.store, this.dependencies.provider, this.dependencies.algorithm, (files) =>
        validateTargetFiles(files, targetAdapter(adapterId)),
      )
    let env: Awaited<ReturnType<typeof environment>>
    try {
      env = await environment()
    } catch {
      throw new GearError({
        code: 'setup-required',
        message: 'Managed Python and runtime profiles are not configured',
        retryable: false,
        next_action: 'gear setup --profiles profiles.json',
      })
    }
    const target = env.profiles[targetProfile],
      meta = env.profiles[metaProfile]
    if (!target || !meta) invalid('Target and Meta profile names must exist in gear setup profiles', 'profiles')
    const provider = new DockerProjectProvider(join(this.root, '.gear/provider-operations'), target, meta, adapterId)
    const algorithm = await createPythonWorker(env.python, algorithmConfig === 'gepa' ? undefined : algorithmConfig)
    const adapter = targetAdapter(adapterId)
    const snapshots = new TargetSnapshots(join(this.root, '.gear/targets.git'), adapter, provider.identity)
    return new ProjectRuntime(
      this.store,
      provider,
      algorithm,
      (files) => validateTargetFiles(files, adapter),
      (snapshot, parent) => snapshots.seal(snapshot, parent),
      new ProjectEvidenceCache(join(this.root, '.gear/evidence')),
      await projectRuntimeIdentity(),
    )
  }
  async run(
    kind: 'evaluate' | 'refine',
    options: {
      split?: Split
      limit?: number
      rounds?: number
      view?: 'operator' | 'meta'
      algorithm?: ProjectConfig['algorithm']
    },
    signal: AbortSignal,
  ) {
    const config = await readProject(this.root),
      benchmark = await loadBenchmark(config.benchmark, config.validation.mode)
    const files = await targetFiles(config.target.path, targetAdapter(config.target.adapter))
    const algorithm = resolveProjectAlgorithm(options.algorithm ?? config.algorithm, this.root)
    const runtime = await this.runtime(config.target.adapter, config.target.profile, config.meta.profile, algorithm)
    const split = options.split ?? 'seed'
    if (options.view === 'meta' && split !== 'seed')
      invalid('Meta evaluation is limited to seed; the runtime owns the final gate', 'split')
    const ids = benchmark.tasks
      .filter((t) => t.split === split)
      .map((t) => t.id)
      .slice(0, options.limit)
    if (!ids.length) invalid('Requested evaluation scope is empty', 'split')
    const plan: RunPlan = {
      kind,
      binding: {
        adapter: config.target.adapter,
        targetProfile: config.target.profile,
        metaProfile: config.meta.profile,
        algorithm,
      },
      benchmark,
      target: { id: 'initial', files, digest: canonicalDigest(files) },
      providerIdentity: runtime.provider.identity,
      algorithmIdentity: runtime.algorithm.identity,
      validation: config.validation.mode,
      maxCandidates: options.rounds ?? config.budget.rounds,
      maxEvaluations: config.budget.max_evaluations,
      ...(kind === 'refine' && config.budget.diagnosis
        ? {
            diagnosis: {
              providerIdentity: runtime.provider.diagnosis?.identity ?? 'unavailable',
              limits: {
                requests: config.budget.diagnosis.max_requests,
                inputTokens: config.budget.diagnosis.max_input_tokens,
                outputTokens: config.budget.diagnosis.max_output_tokens,
              },
            },
          }
        : {}),
      split,
      taskIds: ids,
    }
    const result = await runtime.start(plan, signal)
    return projectReport(result, options.view)
  }
  async report(id?: string, view: 'operator' | 'meta' = 'operator') {
    const selected = id ?? (await this.latest())
    const run = await this.store.read<ProjectRun>(selected)
    if (!run) invalid('Run does not exist', selected)
    return projectReport(run, view)
  }
  private async latest(): Promise<string> {
    const entries = await readdir(join(this.root, '.gear/runs'), { withFileTypes: true })
    const { stat } = await import('node:fs/promises')
    const runs = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => ({
          name: e.name,
          time: (await stat(join(this.root, '.gear/runs', e.name, 'state.json'))).mtimeMs,
        })),
    )
    const id = runs.sort((a, b) => b.time - a.time)[0]?.name
    if (!id) invalid('No runs yet', '.gear/runs')
    return id
  }
  async resume(id: string, signal: AbortSignal, view: 'operator' | 'meta' = 'operator') {
    // Configuration changes never change a saved plan. Profile identity is rechecked by runtime.
    const run = await this.store.read<ProjectRun>(id)
    const binding = run?.plan.binding
    if (!binding) invalid('Run has no sealed project binding', id)
    const runtime = await this.runtime(binding.adapter, binding.targetProfile, binding.metaProfile, binding.algorithm)
    return projectReport(await runtime.resume(id, signal), view)
  }
  async cancel(id: string) {
    const run = await this.store.read<ProjectRun>(id)
    if (!run) invalid('Run does not exist', id)
    if (run.status !== 'running')
      return { run_id: id, cancellation: 'already-terminal', next_action: `gear report ${id}` }
    await this.store.requestCancel(id)
    const binding = run.plan.binding
    if (!binding) invalid('Run has no sealed project binding', id)
    const runtime = await this.runtime(binding.adapter, binding.targetProfile, binding.metaProfile, binding.algorithm)
    for (const operation of run.operations.filter((op) => op.status === 'reserved')) {
      await runtime.provider.cancel(operation.id, AbortSignal.timeout(30_000))
    }
    return { run_id: id, cancellation: 'requested', next_action: `gear resume ${id}` }
  }
  async export(id: string) {
    const run = await this.store.read<ProjectRun>(id)
    if (!run) invalid('Run does not exist', id)
    const root = join(this.root, '.gear/exports', id)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await atomicJSON(join(root, 'report.json'), projectReport(run))
    await atomicJSON(
      join(root, 'target.json'),
      run.candidates.find((c) => c.id === run.champion),
    )
    return { run_id: id, root }
  }
}
