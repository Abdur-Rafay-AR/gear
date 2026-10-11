import type { RefineStateStore } from '../state/store.js'
import type { CandidateRecord, ChampionState, RefinementRound } from '../types.js'
import { type CandidatePatch, type RoundPatch } from './service-contracts.js'
import { now } from './generation-state.js'

export async function reconcileCommitIntent(store: RefineStateStore, round: RefinementRound): Promise<void> {
    const intent = round.commitIntent
    if (intent === undefined) throw new Error('round has no commit intent')
    const population = await store.readPopulation()
    if (population?.digest === intent.expectedPopulationDigest) {
      await store.compareAndSwapPopulation(intent.expectedPopulationDigest, intent.nextPopulation)
    } else if (population?.digest !== intent.nextPopulation.digest) {
      throw new Error('population does not match either side of the commit intent')
    }
    const champion = await requireChampion(store)
    if (intent.nextChampion !== undefined) {
      if (champion.ref === intent.expectedChampionRef) {
        await store.compareAndSwapChampion(intent.expectedChampionRef, intent.nextChampion)
      } else if (champion.ref !== intent.nextChampion.ref) {
        throw new Error('champion does not match either side of the commit intent')
      }
    } else if (champion.ref !== intent.expectedChampionRef) {
      throw new Error('rejected commit intent observed an unexpected champion')
    }
    const { failure: _failure, ...recovered } = round
    await store.writeRound({
      ...recovered,
      status: intent.decision,
      decision: intent.decision,
      ...(intent.decision === 'accepted' ? { promotedCandidateId: intent.promotionCandidateId } : {}),
      commitIntent: { ...intent, phase: 'champion-committed' },
      updatedAt: now(),
    })
  }

export async function transition(store: RefineStateStore, roundId: string, patch: RoundPatch): Promise<RefinementRound> {
    const round = await requireRound(store, roundId)
    const updated = { ...round, ...patch, updatedAt: now() } as RefinementRound & Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete updated[key]
    }
    await store.writeRound(updated)
    return updated
  }

export async function requireRound(store: RefineStateStore, roundId: string): Promise<RefinementRound> {
    const round = await store.readRound(roundId)
    if (round === undefined) throw new Error(`unknown refinement round: ${roundId}`)
    return round
  }

export async function requireChampion(store: RefineStateStore): Promise<ChampionState> {
    const champion = await store.readChampion()
    if (champion === undefined) throw new Error('evolution has no champion')
    return champion
  }

export function patchCandidate(
    round: Readonly<RefinementRound>,
    candidateId: string,
    patch: CandidatePatch,
  ): CandidateRecord[] {
    let found = false
    const candidates = round.candidatePool.map(candidate => {
      if (candidate.candidateId !== candidateId) return candidate
      found = true
      const updated = { ...candidate, ...patch, candidateId: candidate.candidateId, roundId: candidate.roundId } as CandidateRecord & Record<string, unknown>
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete updated[key]
      }
      return updated
    })
    if (!found) throw new Error(`unknown candidate in round ${round.roundId}: ${candidateId}`)
    return candidates
  }
