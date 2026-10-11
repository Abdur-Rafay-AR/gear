import type { CandidateWorkspaceHandle } from '../candidate/workspace.js'
import type { MetaSessionController } from '../meta/controller.js'
import { type MetaExecutionState } from '../meta/offloading-store.js'
import type { RefineStateStore, WorkspaceLock } from '../state/store.js'
import type { CandidateDecline, CandidateDiffSummary, CandidateFinalization, CandidateRecord, ChampionState, CandidateGenerationSpec, ComponentRef, MetaAgentSpec, EvaluationEvidence, EvaluationRerunResult, EvolutionSpec, MetaAttribution, ProposalEvidenceAudit, PromotionPolicy, RefineEvaluator, RefinementRound, RolloutSpec, RoundEvaluationAttempt, SemanticTarget } from '../types.js'
import type { SearchSettings } from '../search/types.js'
import type { CandidateGenerationBudgetStatus } from '../types.js'
import type { ExperienceUsageReader } from '../experience/usage.js'
import { type BaselineSourceRequest } from './baseline-source.js'

export interface RefineServiceOptions {
  datasetStorage?: import('../state/materialize-tree.js').MaterializationPolicy
  searchSettings?: SearchSettings
  workspaceRoot: string
  metaAgent: MetaAgentSpec
  candidateGeneration: CandidateGenerationSpec
  rollout: RolloutSpec
  evaluation: EvolutionSpec['evaluation']
  selection: EvolutionSpec['selection']
  promotion: { policy: ComponentRef<PromotionPolicy> }
  toolchainRef: string
  sandboxProfileRef: string
  seedTaskRef: string
  heldOutRef: string
  taskBudgetMs: number
  initialChampion?: ChampionState
  publishedPointer: boolean
  maxLiveMetaSessions: number
  /** Enables the sealed V1 policy for newly-created skill-first evolutions. */
  experienceMemoryEnabled?: boolean
  /** Optional read-only observer used to enrich newly prepared experience snapshots. */
  experienceUsageReader?: ExperienceUsageReader
  createEvaluator?: (spec: EvolutionSpec) => RefineEvaluator
  validateRuntime?: (spec: EvolutionSpec) => void | Promise<void>
}

export interface AdmissionOptions {
  objective?: import('../objective/types.js').ObjectiveDefinition
  seedTaskRef?: string
  rounds?: number
  taskBudgetMs?: number
  focus?: SemanticTarget[]
  from?: 'initial' | 'published' | string
  name?: string
  baselineSource?: BaselineSourceRequest
}

export interface ContinueOptions { rounds?: number; focus?: SemanticTarget[]; roundId?: string }

/** Construct an inert controller; admission inspects capabilities before creating its state directory. */
export type MetaSessionFactory = (
  spec: EvolutionSpec,
  specDigest: string,
  store: RefineStateStore,
) => MetaSessionController | Promise<MetaSessionController>

export interface EvolutionRuntime {
  spec: EvolutionSpec
  specDigest: string
  store: RefineStateStore
  meta: MetaSessionController
  evaluator: RefineEvaluator
  lastUsedAt: number
}

export interface FinalizationValue {
  finalization: CandidateFinalization | null
  decline?: CandidateDecline
  diff?: CandidateDiffSummary
  meta: MetaAttribution
  evidence: ProposalEvidenceAudit
}

export interface CandidateExecution {
  candidateId: string
  abort: AbortController
  signal: AbortSignal
  finalization: PromiseWithResolvers<FinalizationValue>
  finalizationPersisted: PromiseWithResolvers<void>
  finalizationSubmitted: boolean
  workspace?: CandidateWorkspaceHandle
  metaSessionId?: string
  baseline?: EvaluationEvidence
  preserveWorkspace?: boolean
  generationBudget?: CandidateGenerationBudgetStatus
  evidenceWrites?: Set<Promise<void>>
  prerequisiteWrite?: Promise<void>
}

export type CandidatePatch = { [Key in keyof CandidateRecord]?: CandidateRecord[Key] | undefined }

export type RoundPatch = { [Key in keyof RefinementRound]?: RefinementRound[Key] | undefined }

export interface ActiveRound {
  evolution: EvolutionRuntime
  lock: WorkspaceLock
  abort: AbortController
  executions: Map<string, CandidateExecution>
  currentCandidateId?: string
  contextResume?: MetaExecutionState
  batchId: string
  roundIndex: number
  roundCount: number
  advisoryFocus?: SemanticTarget[]
  source: RefinementRound['source']
  repairAttempt?: Pick<RoundEvaluationAttempt, 'provider' | 'evalId'>
  resumeHeldOut?: boolean
  drive?: Promise<void>
}

export interface ActiveRepair {
  evolution: EvolutionRuntime
  roundId: string
  lock: WorkspaceLock
  abort: AbortController
  handedToDrive: boolean
  completion?: Promise<unknown>
}

export interface ActiveEvaluationRepair extends ActiveRepair {
  attempt: RoundEvaluationAttempt
  completion?: Promise<EvaluationRerunResult>
}

export interface ActiveSearchRepair extends ActiveRepair {
  completion?: Promise<import('../search/types.js').StageResult>
}

export interface PendingEvaluationResume {
  evolutionId: string
  roundId: string
  attempt: Pick<RoundEvaluationAttempt, 'provider' | 'evalId'>
}
