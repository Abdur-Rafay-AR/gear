import { digestDatasetRef } from '../state/dataset.js'
import type { RefineStateStore } from '../state/store.js'
import type { EvaluationEvidence, RefineEvaluator, RefinementRound, RoundEvaluationAttempt } from '../types.js'
import { BaselineReuseBlockedError } from './baseline-reuse.js'
import { now } from './generation-state.js'
import { transition, requireRound } from './round-state.js'

export interface ReusableBaseline {
  evidence: EvaluationEvidence
  sourceRoundId: string
  sourceEvolutionId?: string
  currentInvocationFingerprint?: string
}

export function reuseInvocationAudit(reusable: ReusableBaseline): Pick<RoundEvaluationAttempt, 'reuseAudit'> {
  const source = reusable.evidence.invocationFingerprint
  const current = reusable.currentInvocationFingerprint
  if (source === undefined || current === undefined) return {}
  return {
    reuseAudit: {
      sourceInvocationFingerprint: source,
      currentInvocationFingerprint: current,
      invocationFingerprintChanged: source !== current,
    },
  }
}

export async function findReusableBaseline(
    store: RefineStateStore,
    evaluator: RefineEvaluator,
    round: RefinementRound,
    harnessRef: string,
    partition: 'seed' | 'held-out',
    signal: AbortSignal,
    parentCandidateId?: string,
  ): Promise<ReusableBaseline | undefined> {
    signal.throwIfAborted()
    const condition = partition === 'seed' ? round.plan.seed : round.plan.heldOut
    const dataset = partition === 'seed' ? round.seedTaskRef : round.heldOutRef
    const championHead = await store.readChampion()
    const preferredRoundId = championHead?.ref === harnessRef
      ? championHead.roundId?.replace(/^rollback:/u, '')
      : undefined
    const historyRounds = (await store.listRounds())
      // Prefer the promotion's original evidence, then stable history order.
      // A later cancelled duplicate must not displace the champion's results.
      .sort((left, right) => Number(right.roundId === preferredRoundId)
        - Number(left.roundId === preferredRoundId)
        || left.createdAt.localeCompare(right.createdAt)
        || left.roundId.localeCompare(right.roundId))
    const sources: Array<{
      previous: RefinementRound
      evidence: EvaluationEvidence
      attempt?: RoundEvaluationAttempt
      sourceEvolutionId?: string
      sourceRoundId?: string
    }> = []
    let hasPriorAttempt = false
    for (const previous of historyRounds) {
      signal.throwIfAborted()
      hasPriorAttempt ||= previous.evaluationStarts?.some(start => (
        start.harnessRef === harnessRef && start.phase.startsWith(`${partition}-`)
      )) ?? false
      hasPriorAttempt ||= previous.evaluationAttempts?.some(attempt => (
        attempt.owner.harnessRef === harnessRef && attempt.phase.startsWith(`${partition}-`)
      )) ?? false
      hasPriorAttempt ||= previous.pendingEvaluationSubmissions?.some(pending => (
        pending.request.harnessRef === harnessRef && pending.request.phase.startsWith(`${partition}-`)
      )) ?? false
      hasPriorAttempt ||= previous.failedEvaluations?.some(failed => (
        failed.owner.harnessRef === harnessRef && failed.phase.startsWith(`${partition}-`)
      )) ?? false
      // The resumed round may already own a failed baseline. It must prevent
      // fresh execution even though it cannot be its own historical reuse source.
      if (previous.roundId === round.roundId) continue
      const matchingParent = partition === 'seed' && parentCandidateId !== undefined
        ? previous.parentBaselines
          ?.filter(value => value.parentCandidateId === parentCandidateId && value.parentHarnessRef === harnessRef)
          .map(value => value.evidence) ?? []
        : []
      const matchingHarness = partition === 'seed'
        ? previous.parentBaselines
          ?.filter(value => value.parentCandidateId !== parentCandidateId && value.parentHarnessRef === harnessRef)
          .map(value => value.evidence) ?? []
        : []
      const champion = previous.targetHarnessRef === harnessRef
        ? partition === 'seed'
          ? previous.baseline === undefined ? [] : [previous.baseline]
          : previous.evaluation?.heldOutBaseline === undefined ? [] : [previous.evaluation.heldOutBaseline]
        : []
      const candidates = previous.candidatePool.flatMap(candidate => candidate.sealedVersion?.commitOid !== harnessRef
        ? []
        : partition === 'seed'
          ? candidate.seedEvaluation === undefined ? [] : [candidate.seedEvaluation]
          : candidate.heldOutEvaluation === undefined ? [] : [candidate.heldOutEvaluation])
      for (const evidence of [...matchingParent, ...matchingHarness, ...champion, ...candidates]) {
        const attempt = previous.evaluationAttempts?.find(value => (
          value.provider === evidence.provider && value.evalId === evidence.evalId
        ))
        sources.push({ previous, evidence, ...(attempt === undefined ? {} : { attempt }) })
      }
      const imported = partition === 'seed'
        ? previous.baselineSource?.partitions.seed
        : previous.baselineSource?.partitions.heldOut
      if (imported !== undefined && previous.baselineSource?.target.harnessRef === harnessRef) {
        sources.push({
          previous,
          evidence: imported.evidence,
          attempt: imported.sourceAttempt,
          sourceEvolutionId: previous.baselineSource.source.evolutionId,
          sourceRoundId: previous.baselineSource.source.roundId,
        })
      }
    }
    // Only genuinely missing history authorizes a fresh baseline. Identity
    // resolution failures, partial results and failed attempts are not misses.
    if (sources.length === 0 && !hasPriorAttempt) return undefined
    let evaluationIdentity: Awaited<ReturnType<NonNullable<RefineEvaluator['evaluationIdentity']>>>
    try {
      if (await digestDatasetRef(dataset, round.workspaceRoot) !== condition.dataset.digest) {
        throw new BaselineReuseBlockedError({
          code: 'BASELINE_CONDITION_MISMATCH',
          reason: `The frozen ${partition} dataset has changed; no baseline refresh was started.`,
          requiredAction: 'Restore the frozen dataset, or explicitly start a new evolution for changed conditions.',
        })
      }
      evaluationIdentity = await evaluator.evaluationIdentity?.(round, {
        phase: partition === 'seed' ? 'seed-baseline' : 'held-out-baseline',
        dataset, harnessRef, condition,
      }, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof BaselineReuseBlockedError) throw error
      throw new BaselineReuseBlockedError({
        code: 'BASELINE_IDENTITY_UNRESOLVED',
        reason: `Cannot verify the existing ${partition} baseline identity; no baseline refresh was started.`,
        requiredAction: 'Restore evaluator identity resolution before continuing this evolution.',
      }, { cause: error })
    }
    signal.throwIfAborted()
    if (evaluationIdentity === undefined) {
      throw new BaselineReuseBlockedError({
        code: 'BASELINE_IDENTITY_UNRESOLVED',
        reason: `Cannot verify the existing ${partition} baseline identity before execution; no baseline refresh was started.`,
        requiredAction: 'Use an evaluator that can resolve the frozen evaluation identity without starting Target trials.',
      })
    }
    let hasCompatibleEvidence = false
    for (const { previous, evidence, attempt, sourceEvolutionId, sourceRoundId } of sources) {
      if (evidence.provider !== evaluationIdentity.provider
        || evidence.conditionId !== condition.conditionId
        || evidence.dataset !== dataset
        || evidence.effectiveConfigDigest !== evaluationIdentity.effectiveConfigDigest
        || evidence.requestedCommit !== harnessRef
        || evidence.actualCommit !== harnessRef) continue
      hasCompatibleEvidence = true
      if (evidence.trials.length === 0
        || attempt?.status !== 'settled'
        || attempt.phase !== `${partition}-${attempt.owner.role}`
        || attempt.owner.harnessRef !== harnessRef
        || attempt.requestedModelId !== condition.model) continue
      return {
        evidence: structuredClone(evidence),
        sourceRoundId: sourceRoundId ?? previous.roundId,
        ...(sourceEvolutionId === undefined ? {} : { sourceEvolutionId }),
        ...(evaluationIdentity.invocationFingerprint === undefined
          ? {}
          : { currentInvocationFingerprint: evaluationIdentity.invocationFingerprint }),
      }
    }
    if (hasCompatibleEvidence || sources.length === 0) {
      throw new BaselineReuseBlockedError({
        code: 'BASELINE_EVIDENCE_UNAVAILABLE',
        reason: `The existing ${partition} evaluation has no verifiable settled baseline with a valid trial; no baseline refresh was started.`,
        requiredAction: 'Recover settled evidence with at least one valid trial for the original evaluation. Unsettled or zero-valid evidence requires a provider-supported repair that preserves valid trials.',
      })
    }
    throw new BaselineReuseBlockedError({
      code: 'BASELINE_CONDITION_MISMATCH',
      reason: `The existing ${partition} baseline is incompatible with the frozen evaluation identity; no baseline refresh was started.`,
      requiredAction: 'Restore compatible evaluation conditions, or explicitly start a new evolution for changed conditions.',
    })
  }

export async function persistReusableSeedBaseline(
    store: RefineStateStore,
    round: RefinementRound,
    parentCandidateId: string,
    parentHarnessRef: string,
    reusable: ReusableBaseline,
    champion: boolean,
  ): Promise<RefinementRound> {
    const current = await requireRound(store, round.roundId)
    const evidence = structuredClone(reusable.evidence)
    const existingAttempt = current.evaluationAttempts?.find(value => (
      value.provider === evidence.provider && value.evalId === evidence.evalId
    ))
    if (existingAttempt !== undefined && existingAttempt.owner.harnessRef !== parentHarnessRef) {
      throw new Error(`reused evaluation identity has conflicting ownership: ${evidence.provider}/${evidence.evalId}`)
    }
    const timestamp = now()
    const evaluationAttempts = existingAttempt === undefined
      ? [...(current.evaluationAttempts ?? []), {
          provider: evidence.provider,
          evalId: evidence.evalId,
          phase: 'seed-baseline' as const,
          owner: { candidateId: parentCandidateId, role: 'baseline' as const, harnessRef: parentHarnessRef },
          conditionId: current.plan.seed.conditionId,
          dataset: current.seedTaskRef,
          requestedModelId: current.plan.seed.model,
          requestedCommit: parentHarnessRef,
          status: 'settled' as const,
          startedAt: timestamp,
          completedAt: timestamp,
          ...(reusable.sourceEvolutionId === undefined
            ? {}
            : { reusedFromEvolutionId: reusable.sourceEvolutionId }),
          reusedFromRoundId: reusable.sourceRoundId,
          ...reuseInvocationAudit(reusable),
        }]
      : current.evaluationAttempts
    return transition(store, current.roundId, {
      ...(champion ? { baseline: evidence } : {}),
      parentBaselines: [
        ...(current.parentBaselines ?? []).filter(value => value.parentCandidateId !== parentCandidateId),
        { parentCandidateId, parentHarnessRef, evidence },
      ],
      evaluationAttempts,
    })
  }

export async function persistReusableHeldOutBaseline(
    store: RefineStateStore,
    round: RefinementRound,
    championCandidateId: string,
    championHarnessRef: string,
    reusable: ReusableBaseline,
  ): Promise<RefinementRound> {
    const current = await requireRound(store, round.roundId)
    if (current.evaluation === undefined) throw new Error('held-out baseline reuse requires seed evaluation state')
    const evidence = structuredClone(reusable.evidence)
    const existingAttempt = current.evaluationAttempts?.find(value => (
      value.provider === evidence.provider && value.evalId === evidence.evalId
    ))
    if (existingAttempt !== undefined && existingAttempt.owner.harnessRef !== championHarnessRef) {
      throw new Error(`reused evaluation identity has conflicting ownership: ${evidence.provider}/${evidence.evalId}`)
    }
    const timestamp = now()
    const evaluationAttempts = existingAttempt === undefined
      ? [...(current.evaluationAttempts ?? []), {
          provider: evidence.provider,
          evalId: evidence.evalId,
          phase: 'held-out-baseline' as const,
          owner: { candidateId: championCandidateId, role: 'baseline' as const, harnessRef: championHarnessRef },
          conditionId: current.plan.heldOut.conditionId,
          dataset: current.heldOutRef,
          requestedModelId: current.plan.heldOut.model,
          requestedCommit: championHarnessRef,
          status: 'settled' as const,
          startedAt: timestamp,
          completedAt: timestamp,
          ...(reusable.sourceEvolutionId === undefined
            ? {}
            : { reusedFromEvolutionId: reusable.sourceEvolutionId }),
          reusedFromRoundId: reusable.sourceRoundId,
          ...reuseInvocationAudit(reusable),
        }]
      : current.evaluationAttempts
    return transition(store, current.roundId, {
      evaluation: { ...current.evaluation, heldOutBaseline: evidence },
      evaluationAttempts,
    })
  }
