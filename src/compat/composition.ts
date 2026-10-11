import type { Config, HitchConfig } from '../config.js'
import { builtinComponentRef, componentRef, ComponentRegistry, rolloutProviderSemanticDigest } from '../evolution/components.js'
import { hitchCliImplementation, stableLlmVerifierImplementation } from '../evolution/component-identity.js'
import { HitchCliEvaluator } from '../evaluator/hitch-cli.js'
import { LlmVerifierCandidateAssessor, resolveLlmVerifierRuntime, type LlmVerifierAssessorConfig } from '../selection/llm-verifier.js'
import type { RefineEvaluator } from '../types.js'

function positive(value: number | undefined, name: string, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive safe integer`)
  return result
}

/** Compatibility composition: the DSH plugin and standalone Skill use identical defaults. */
export async function composeLegacyComponents(config: Config, components: ComponentRegistry, dependencies: { evaluator?: RefineEvaluator } = {}) {
  const attemptTimeoutMs = positive(
    config.candidateGeneration.attemptTimeoutMs ?? config.candidateGeneration.timeoutMs,
    'candidateGeneration.attemptTimeoutMs',
    900_000,
  )
  const legacyBudget = config.candidateGeneration.timeoutMs !== undefined
    && config.candidateGeneration.attemptTimeoutMs === undefined
    && config.candidateGeneration.maxAttemptsPerCandidate === undefined
    && config.candidateGeneration.roundTimeoutMs === undefined
  const maxAttemptsPerCandidate = positive(
    config.candidateGeneration.maxAttemptsPerCandidate,
    'candidateGeneration.maxAttemptsPerCandidate',
    legacyBudget ? 1 : 2,
  )
  const maxCandidates = positive(config.candidateGeneration.maxCandidates, 'candidateGeneration.maxCandidates', 1)
  const roundTimeoutMs = positive(
    config.candidateGeneration.roundTimeoutMs ?? (legacyBudget ? config.candidateGeneration.timeoutMs : undefined),
    'candidateGeneration.roundTimeoutMs',
    attemptTimeoutMs * maxAttemptsPerCandidate * maxCandidates,
  )
  const candidateGeneration = {
    strategy: builtinComponentRef('candidate-generator', config.metaAdapter.kind === 'dsh' ? 'dsh-meta-forked-proposals' : 'meta-forked-proposals', {}),
    maxCandidates,
    budget: {
      ...(config.candidateGeneration.maxModelRequests === undefined ? {} : { maxModelRequests: config.candidateGeneration.maxModelRequests }),
      ...(config.candidateGeneration.maxTokens === undefined ? {} : { maxTokens: config.candidateGeneration.maxTokens }),
      attemptTimeoutMs,
      maxAttemptsPerCandidate,
      roundTimeoutMs,
      ...(config.candidateGeneration.finalizationReserveMs === undefined ? {} : { finalizationReserveMs: config.candidateGeneration.finalizationReserveMs }),
    },
  }
  const rolloutProvider = componentRef('rollout-provider', 'hitch-cli', hitchCliImplementation(), structuredClone(config.hitch))
  const rolloutAgentConfig = { agentArgs: [...config.hitch.agentArgs] }
  const rollout = {
    provider: rolloutProvider,
    providerSemanticDigest: rolloutProviderSemanticDigest(
      rolloutProvider,
      { harnessId: config.hitch.harnessId },
      rolloutAgentConfig,
    ),
    taskSampler: builtinComponentRef('task-sampler', 'dataset', {}),
    repetitions: config.hitch.attempts,
    ...(config.hitch.seeds === undefined || config.hitch.seeds.length === 0 ? {} : { seeds: [...config.hitch.seeds] }),
    model: config.hitch.model,
    sampling: { ...config.hitch.sampling },
    agentConfig: rolloutAgentConfig,
  }
  const evaluator = dependencies.evaluator ?? new HitchCliEvaluator({ ...config.hitch, repositoryPath: config.dshRepository })
  if (dependencies.evaluator === undefined) {
    components.registerRolloutProvider('hitch-cli', rollout.provider.implementation, ref => ({
      ref,
      createEvaluator: spec => new HitchCliEvaluator({
        ...(spec.rollout.provider.config as unknown as HitchConfig),
        repositoryPath: config.dshRepository,
      }),
    }))
  }
  const evaluation = {
    ...(config.evaluationMode === undefined ? {} : { mode: config.evaluationMode }),
    judges: [builtinComponentRef('judge', 'task-reward', {})],
    primaryMetric: 'primaryReward',
  }
  let selectionAssessor = builtinComponentRef('candidate-assessor', 'evaluation-metrics', {})
  if (config.selection.llmVerifier !== undefined) {
    const selected = config.selection.llmVerifier
    const assessorConfig: LlmVerifierAssessorConfig = {
      pythonExecutable: selected.pythonExecutable,
      runtime: await resolveLlmVerifierRuntime(selected.pythonExecutable),
      model: selected.model,
      criteria: structuredClone(selected.criteria),
      ...(selected.groundTruthNote === undefined ? {} : { groundTruthNote: selected.groundTruthNote }),
      nEvaluations: selected.nEvaluations,
      pivots: selected.pivots,
      seed: selected.seed,
      maxWorkers: selected.maxWorkers,
      maxOutputBytes: selected.maxOutputBytes,
      maxTrajectoryEvents: selected.maxTrajectoryEvents,
      maxTrajectoryChars: selected.maxTrajectoryChars,
      passEnv: [...selected.passEnv],
    }
    const implementation = stableLlmVerifierImplementation()
    selectionAssessor = componentRef('candidate-assessor', 'llm-verifier', implementation, assessorConfig)
    components.registerCandidateAssessor('llm-verifier', implementation, ref => new LlmVerifierCandidateAssessor(ref))
  }
  return { candidateGeneration, rollout, evaluation, selectionAssessor, evaluator }
}
