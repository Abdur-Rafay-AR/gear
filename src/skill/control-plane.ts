import { composeLegacyComponents } from '../compat/composition.js'
import { resolveSearchSettings } from '../search/config.js'
import { isAbsolute, join } from 'node:path'
import { RefineCapabilities } from '../capabilities.js'
import { CandidateWorkspaceManager } from '../candidate/workspace.js'
import type { Config } from '../config.js'
import {
  builtinComponentRef,
  ComponentRegistry,
} from '../evolution/components.js'
import { HarnessBuilder, type HarnessCompiler } from '../harness/builder.js'
import { SubprocessHarnessCompiler } from '../harness/compiler.js'
import { acquireAirGappedSandbox } from '../sandbox.js'
import { SkillMetaCoordinator, SkillMetaSessionManager } from '../meta/skill.js'
import { compatibleSkillMetaAgent } from '../meta/controller.js'
import { validateMetaSampling } from '../meta/sampling.js'
import { RefineService } from '../refine/service.js'
import {
  resolveLlmVerifierRuntime,
  type LlmVerifierAssessorConfig,
} from '../selection/llm-verifier.js'
import { EvolutionRegistryStore } from '../state/evolution.js'
import type { HitchTrajectoryReader, MetaAgentSpec, RefineEvaluator } from '../types.js'
import { SkillCandidateFiles } from './files.js'
import { RefineSkillGateway } from './gateway.js'
import { RefineSkillServer } from './server.js'

const SHA256 = /^sha256:[0-9a-f]{64}$/u

export interface SkillControlPlaneDependencies {
  evaluator?: RefineEvaluator & Partial<HitchTrajectoryReader>
  compiler?: HarnessCompiler
  components?: ComponentRegistry
}

export interface SkillControlPlane {
  service: RefineService
  gateway: RefineSkillGateway
  server: RefineSkillServer
  socketPath: string
  dispose(): Promise<void>
}

function positive(value: number | undefined, name: string, fallback: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return selected
}

export function skillMetaAgent(config: Config): MetaAgentSpec {
  if (config.metaAdapter.kind !== 'skill') throw new TypeError('standalone Gear requires metaAdapter.kind="skill"')
  if (config.metaPreset !== undefined) throw new TypeError('metaPreset is not valid in standalone skill mode')
  validateMetaSampling(config.metaSampling)
  const fields = {
    runtimeType: config.metaAdapter.runtimeType,
    runtimeVersion: config.metaAdapter.runtimeVersion,
    harnessId: config.metaAdapter.harnessId,
  }
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`metaAdapter.${name} is required`)
  }
  if (!SHA256.test(config.metaAdapter.runtimeIntegrity ?? '')) throw new TypeError('metaAdapter.runtimeIntegrity must be sha256')
  if (!SHA256.test(config.metaAdapter.harnessDigest ?? '')) throw new TypeError('metaAdapter.harnessDigest must be sha256')
  if (config.metaModel.provider === undefined || config.metaModel.provider.length === 0
    || config.metaModel.model === undefined || config.metaModel.model.length === 0) {
    throw new TypeError('metaModel.provider and metaModel.model are required')
  }
  const harnessDigest = config.metaAdapter.harnessDigest!
  return {
    runtime: {
      type: config.metaAdapter.runtimeType!,
      version: config.metaAdapter.runtimeVersion!,
      integrity: config.metaAdapter.runtimeIntegrity!,
    },
    preset: {
      id: config.metaAdapter.harnessId!,
      digest: harnessDigest,
      resources: [{ logicalPath: 'SKILL.md', kind: 'skill', digest: harnessDigest }],
    },
    model: {
      provider: config.metaModel.provider,
      model: config.metaModel.model,
      ...(config.metaModel.maxTokens === undefined ? {} : { maxTokens: config.metaModel.maxTokens }),
    },
    sampling: { ...config.metaSampling },
  }
}

/** Build the full Gear control plane without a DSH Context. */
export async function createSkillControlPlane(
  config: Config,
  dependencies: SkillControlPlaneDependencies = {},
): Promise<SkillControlPlane> {
  const metaAgent = skillMetaAgent(config)
  if (config.hitch.model.length === 0) throw new TypeError('hitch.model is required for reproducible rollout plans')
  if (config.metaSandbox.mode === 'required' && !isAbsolute(config.compiler.command)) {
    throw new TypeError('compiler.command must be absolute when sandboxing is required')
  }
  const stateRoot = config.stateRoot ?? join(config.workspaceRoot, '.gear-refine')
  const registry = new EvolutionRegistryStore(stateRoot)
  const components = dependencies.components ?? new ComponentRegistry({
    legacyComponentRoots: config.evolutionState.legacyComponentRoots,
  })
  const { candidateGeneration, rollout, evaluation, selectionAssessor, evaluator } = await composeLegacyComponents(config, components, dependencies)
  const compiler = dependencies.compiler ?? new SubprocessHarnessCompiler({
    ...config.compiler,
    sandboxMode: config.metaSandbox.mode,
    linuxIsolation: config.metaSandbox.linuxIsolation,
    targetRoot: config.targetRoot,
  })
  const builder = new HarnessBuilder({
    repositoryPath: config.dshRepository,
    targetRoot: config.targetRoot,
    dshBaseRef: config.dshBaseRef,
    toolchainRef: config.toolchainRef,
    sandboxProfileRef: config.sandboxProfileRef,
    allowedImports: config.allowedImports,
    compiler,
  })
  const workspaces = new CandidateWorkspaceManager({
    repositoryPath: config.dshRepository,
    targetRoot: config.targetRoot,
    rootForEvolution: evolutionId => join(registry.evolutionRoot(evolutionId), config.candidateWorkspace.rootName),
    maxFiles: positive(config.candidateWorkspace.maxFiles, 'candidateWorkspace.maxFiles', 64),
    maxBytes: positive(config.candidateWorkspace.maxBytes, 'candidateWorkspace.maxBytes', 2 * 1024 * 1024),
    maxDiffBytes: positive(config.candidateWorkspace.maxDiffBytes, 'candidateWorkspace.maxDiffBytes', 1024 * 1024),
  })
  const coordinator = new SkillMetaCoordinator()
  const validateRuntime = async (spec: import('../types.js').EvolutionSpec): Promise<void> => {
    if (!compatibleSkillMetaAgent(spec.metaAgent, metaAgent)) throw new Error('skill Meta harness identity changed; evolution cannot continue')
    if (spec.selection.assessor.id === 'llm-verifier') {
      const assessorConfig = spec.selection.assessor.config as LlmVerifierAssessorConfig
      const current = await resolveLlmVerifierRuntime(assessorConfig.pythonExecutable)
      if (JSON.stringify(current) !== JSON.stringify(assessorConfig.runtime)) throw new Error('llm-verifier runtime identity changed; evolution cannot continue')
    }
  }
  const secretValues = [...new Set([
    ...config.hitch.passEnv,
    ...(config.selection.llmVerifier?.passEnv ?? []),
  ])].flatMap(name => {
    const value = process.env[name]
    return value === undefined || value.length === 0 ? [] : [value]
  })
  const service = new RefineService(
    registry,
    builder,
    workspaces,
    async (spec, specDigest, store) => {
      await validateRuntime(spec)
      return new SkillMetaSessionManager(store, coordinator, {
        evolutionId: spec.evolutionId,
        specDigest,
        metaAgent: spec.metaAgent,
      }, secretValues)
    },
    evaluator,
    {
      workspaceRoot: config.workspaceRoot,
      metaAgent,
      ...(config.datasetStorage ? { datasetStorage: config.datasetStorage } : {}),
      candidateGeneration,
      rollout,
      evaluation,
      selection: {
        assessor: selectionAssessor,
        strategy: builtinComponentRef('candidate-selector', 'highest-quality', {}),
        survivors: positive(config.selection.survivors, 'selection.survivors', 1),
        timeoutMs: positive(config.selection.timeoutMs, 'selection.timeoutMs', 300_000),
      },
      promotion: { policy: builtinComponentRef('promotion-policy', 'paired-gate', structuredClone(config.promotion)) },
      toolchainRef: config.toolchainRef,
      sandboxProfileRef: config.sandboxProfileRef,
      seedTaskRef: config.seedTaskRef,
      heldOutRef: config.heldOutRef,
      taskBudgetMs: positive(config.taskBudgetMs, 'taskBudgetMs', 3_600_000),
      ...(config.initialChampion === undefined ? {} : { initialChampion: config.initialChampion }),
      ...(config.search === undefined ? {} : { searchSettings: resolveSearchSettings(config)! }),
      publishedPointer: config.evolutionState.publishedPointer,
      maxLiveMetaSessions: positive(config.evolutionState.maxLiveMetaSessions, 'evolutionState.maxLiveMetaSessions', 8),
      validateRuntime,
      ...(dependencies.evaluator === undefined ? {} : { createEvaluator: () => dependencies.evaluator! }),
    },
    components,
  )
  const capabilities = new RefineCapabilities(service, builder, {
    ...(config.seedTasksPath === undefined ? {} : { seedTasksPath: config.seedTasksPath }),
    configuredSeedTaskRef: config.seedTaskRef,
    ...('inspectTrajectoryAnalysis' in evaluator && typeof evaluator.inspectTrajectoryAnalysis === 'function'
      && 'inspectTrajectoryEvents' in evaluator && typeof evaluator.inspectTrajectoryEvents === 'function'
      && 'inspectCapabilities' in evaluator && typeof evaluator.inspectCapabilities === 'function'
      ? { trajectoryReader: evaluator as RefineEvaluator & HitchTrajectoryReader }
      : {}),
    maxTrajectoryPageBytes: config.candidateWorkspace.maxReadBytes,
    maxFailureBundleBytes: config.candidateWorkspace.maxReadBytes,
    ...(config.hitch.trajectoryCacheEntries === undefined ? {} : {
      maxTrajectoryCacheEntries: config.hitch.trajectoryCacheEntries,
    }),
    ...(config.hitch.trajectoryCacheBytes === undefined ? {} : {
      maxTrajectoryProjectionCacheBytes: config.hitch.trajectoryCacheBytes,
    }),
    ...(config.hitch.allowUnavailableVerifierDiagnosis === undefined ? {} : {
      allowUnavailableVerifierDiagnosis: config.hitch.allowUnavailableVerifierDiagnosis,
    }),
    secretValues,
  })
  const gateway = new RefineSkillGateway(
    service,
    coordinator,
    capabilities,
    new SkillCandidateFiles(workspaces, { maxReadBytes: positive(config.candidateWorkspace.maxReadBytes, 'candidateWorkspace.maxReadBytes', 128 * 1024) }),
    { maxRequestBytes: positive(config.metaAdapter.maxRequestBytes, 'metaAdapter.maxRequestBytes', 1024 * 1024) },
  )
  const socketPath = config.metaAdapter.socketPath ?? join(stateRoot, 'refine.sock')
  const server = new RefineSkillServer(socketPath, gateway)
  const sandboxLease = config.metaSandbox.mode === 'required'
    ? await acquireAirGappedSandbox(config.metaSandbox.linuxIsolation, 'refine compiler')
    : undefined
  try {
    await builder.initialize()
    if (config.initialChampion !== undefined) {
      const manifest = await builder.readManifest(config.initialChampion.ref)
      if (manifest.digest !== config.initialChampion.manifestDigest) throw new Error('initial champion manifestDigest does not match its exact Git commit')
    }
    await service.initialize()
    await server.start()
  } catch (error) {
    await service.dispose().catch(() => {})
    await sandboxLease?.release()
    throw error
  }
  let disposed = false
  return {
    service,
    gateway,
    server,
    socketPath,
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await server.dispose()
      } finally {
        try {
          await service.dispose()
        } finally {
          await sandboxLease?.release()
        }
      }
    },
  }
}
