import { randomBytes } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  EXPERIENCE_V1_MAX_CARD_BYTES,
  EXPERIENCE_V1_MAX_QUERY_BYTES,
  EXPERIENCE_V1_MAX_QUERY_RESULTS,
  EXPERIENCE_V1_MAX_READ_BYTES,
  EXPERIENCE_V1_MAX_READ_ITEMS,
  experienceDigestFromRef,
  loadSeedExperienceSnapshot,
  rankSeedExperience,
  renderSeedExperienceCard,
  type SeedExperienceQuery,
} from '../experience/memory.js'
import type { HarnessBuilder } from '../harness/builder.js'
import { digestJson } from '../state/digest.js'
import type { RefineStateStore } from '../state/store.js'
import type { RefinementRound, SeedExperienceEffect, SeedExperienceRecord, SemanticTarget } from '../types.js'
import { assertOnlyKeys, optionalInteger, optionalString, optionalStrings, string } from './params.js'
import { boundedUtf8, publicJson } from './text.js'

interface ExperienceQueryCursor {
  sessionId: string
  roundId: string
  snapshotDigest: string
  queryDigest: string
  query: SeedExperienceQuery
  offset: number
  limit: number
}

export class ExperienceCapabilities {
  private readonly experienceQueryCursors = new Map<string, ExperienceQueryCursor>()

  constructor(
    private readonly builder: Pick<HarnessBuilder, 'readHarnessDiff'>,
    private readonly sanitize: (value: unknown, heldOutRef: string) => JsonValue,
    private readonly readTrajectory: (
      sessionId: string,
      round: RefinementRound,
      experience: SeedExperienceRecord,
      base: Record<string, unknown>,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}

  async query(
    sessionId: string,
    store: RefineStateStore,
    round: RefinementRound,
    parentHarnessRef: string | undefined,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const snapshot = round.experienceSnapshot!
    let query: SeedExperienceQuery
    let queryDigest: string
    let offset = 0
    let limit: number
    const cursorRef = optionalString(args, 'cursor')
    if (cursorRef !== undefined) {
      assertOnlyKeys(args, ['cursor'])
      const cursor = this.experienceQueryCursors.get(cursorRef)
      if (
        cursor === undefined ||
        cursor.sessionId !== sessionId ||
        cursor.roundId !== round.roundId ||
        cursor.snapshotDigest !== snapshot.digest
      ) {
        throw new Error('experience cursor is unknown or no longer valid for this Meta task')
      }
      query = structuredClone(cursor.query)
      queryDigest = cursor.queryDigest
      offset = cursor.offset
      limit = cursor.limit
    } else {
      assertOnlyKeys(args, ['query', 'taskNames', 'semanticTargets', 'paths', 'effects', 'limit', 'cursor'])
      const text = optionalString(args, 'query')
      if (text !== undefined && Buffer.byteLength(text) > 1_000)
        throw new TypeError('experience query is limited to 1000 bytes')
      const taskNames = optionalStrings(args, 'taskNames')
      const semanticTargets = optionalStrings(args, 'semanticTargets')
      const paths = optionalStrings(args, 'paths')
      const effects = optionalStrings(args, 'effects')
      for (const [name, values, maxLength] of [
        ['taskNames', taskNames, 240],
        ['semanticTargets', semanticTargets, 32],
        ['paths', paths, 500],
        ['effects', effects, 32],
      ] as const) {
        if ((values?.length ?? 0) > 20 || values?.some((value) => value.length > maxLength)) {
          throw new TypeError(`${name} accepts at most 20 bounded values`)
        }
      }
      const allowedTargets = new Set<SemanticTarget>([
        'context',
        'pre_action',
        'routing',
        'post_action',
        'action_verifier',
        'skill',
        'tool',
        'workflow',
        'compaction',
      ])
      if (semanticTargets?.some((value) => !allowedTargets.has(value as SemanticTarget))) {
        throw new TypeError('semanticTargets contains an unknown target')
      }
      const allowedEffects = new Set<SeedExperienceEffect>([
        'improved',
        'regressed',
        'mixed',
        'unchanged',
        'insufficient',
      ])
      if (effects?.some((value) => !allowedEffects.has(value as SeedExperienceEffect))) {
        throw new TypeError('effects contains an unknown seed outcome')
      }
      if (
        paths?.some(
          (path) =>
            path.startsWith('/') ||
            path.includes('\\') ||
            path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..'),
        )
      ) {
        throw new TypeError('paths must contain normalized relative harness paths')
      }
      query = {
        ...(text === undefined ? {} : { query: text }),
        ...(taskNames === undefined ? {} : { taskNames: [...new Set(taskNames)].sort() }),
        ...(semanticTargets === undefined
          ? {}
          : {
              semanticTargets: [...new Set(semanticTargets)].sort() as SemanticTarget[],
            }),
        ...(paths === undefined ? {} : { paths: [...new Set(paths)].sort() }),
        ...(effects === undefined
          ? {}
          : {
              effects: [...new Set(effects)].sort() as SeedExperienceEffect[],
            }),
      }
      const requestedLimit = optionalInteger(args, 'limit') ?? 5
      if (requestedLimit < 1 || requestedLimit > EXPERIENCE_V1_MAX_QUERY_RESULTS) {
        throw new TypeError(`experience query limit must be between 1 and ${EXPERIENCE_V1_MAX_QUERY_RESULTS}`)
      }
      limit = requestedLimit
      queryDigest = digestJson({ snapshotDigest: snapshot.digest, query })
    }

    const loaded = await loadSeedExperienceSnapshot(store, snapshot)
    if (loaded.unavailableRecordIds.length > 0) {
      throw new Error(
        `seed experience snapshot is incomplete; unavailable record IDs: ${loaded.unavailableRecordIds.join(', ')}`,
      )
    }
    const ranked = rankSeedExperience(loaded.records, query, parentHarnessRef)
    const results: Array<Record<string, unknown>> = []
    let nextOffset = offset
    for (const item of ranked.slice(offset, offset + limit)) {
      const card = renderSeedExperienceCard(item.record, item.matchReasons)
      const result = {
        ...card,
        markdown: this.experienceText(card.markdown, round.heldOutRef, EXPERIENCE_V1_MAX_CARD_BYTES),
        matchReasons: card.matchReasons.map((reason) => this.experienceText(reason, round.heldOutRef, 300)),
        recordDigest: item.record.recordDigest,
        seedProjectionDigest: item.record.seedProjectionDigest,
        relevanceScore: item.score,
      }
      const trial = {
        schemaVersion: 1,
        snapshotDigest: snapshot.digest,
        queryDigest,
        results: [...results, result],
      }
      if (this.experienceResponseBytes(trial, round.heldOutRef) > EXPERIENCE_V1_MAX_QUERY_BYTES - 256) break
      results.push(result)
      nextOffset += 1
    }
    let nextCursor: string | undefined
    if (nextOffset < ranked.length) {
      nextCursor = `experience_cursor_${randomBytes(16).toString('hex')}`
      this.experienceQueryCursors.set(nextCursor, {
        sessionId,
        roundId: round.roundId,
        snapshotDigest: snapshot.digest,
        queryDigest,
        query: structuredClone(query),
        offset: nextOffset,
        limit,
      })
      while (this.experienceQueryCursors.size > 4_096) {
        const oldest = this.experienceQueryCursors.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.experienceQueryCursors.delete(oldest)
      }
    }
    const response = {
      schemaVersion: 1,
      snapshotDigest: snapshot.digest,
      queryDigest,
      results,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
    return response
  }

  async read(
    sessionId: string,
    store: RefineStateStore,
    round: RefinementRound,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    assertOnlyKeys(args, ['ref', 'view', 'offset', 'limit', 'runId', 'detailRef', 'find'])
    const ref = string(args, 'ref')
    const view = string(args, 'view')
    if (!['record', 'card', 'task-results', 'diff', 'trajectory'].includes(view)) {
      throw new TypeError('experience read view must be record, card, task-results, diff, or trajectory')
    }
    const digest = experienceDigestFromRef(ref)
    const snapshot = round.experienceSnapshot!
    const member = digest === undefined ? undefined : snapshot.members.find((item) => item.recordDigest === digest)
    if (member === undefined) throw new Error('experience ref is not authorized by the active round snapshot')
    let experience: SeedExperienceRecord | undefined
    try {
      experience = await store.readExperienceRecord(member.recordDigest)
    } catch {
      experience = undefined
    }
    if (
      experience === undefined ||
      experience.recordId !== member.recordId ||
      experience.source.evolutionId !== round.evolutionId ||
      experience.source.roundId !== member.sourceRoundId ||
      experience.source.candidateId !== member.candidateId ||
      experience.source.candidateHarnessRef !== member.candidateHarnessRef
    ) {
      return {
        schemaVersion: 1,
        available: false,
        snapshotDigest: snapshot.digest,
        ref,
        reason: 'The exact seed experience revision sealed into this round is unavailable.',
      }
    }
    const base = {
      schemaVersion: 1,
      available: true,
      snapshotDigest: snapshot.digest,
      ref,
      recordId: experience.recordId,
      recordDigest: experience.recordDigest,
      seedProjectionDigest: experience.seedProjectionDigest,
      view,
    }
    if (view === 'card') {
      const card = renderSeedExperienceCard(experience)
      return {
        ...base,
        card: {
          ...card,
          markdown: this.experienceText(card.markdown, round.heldOutRef, EXPERIENCE_V1_MAX_CARD_BYTES),
        },
      }
    }

    const offset = optionalInteger(args, 'offset') ?? 0
    const limit = optionalInteger(args, 'limit') ?? 20
    if (limit < 1 || limit > EXPERIENCE_V1_MAX_READ_ITEMS) {
      throw new TypeError(`experience read limit must be between 1 and ${EXPERIENCE_V1_MAX_READ_ITEMS}`)
    }
    if (view === 'record') {
      const files = experience.change.files.map((file) => ({
        ...file,
        path: this.experienceText(file.path, round.heldOutRef, 500),
      }))
      const rationale = this.experienceText(experience.proposal.rationale, round.heldOutRef, 8 * 1024)
      const expectedOutcome = this.experienceText(experience.proposal.expectedOutcome, round.heldOutRef, 8 * 1024)
      const response = (visibleFiles: readonly unknown[], nextOffset?: number) => ({
        ...base,
        record: {
          schemaVersion: experience.schemaVersion,
          source: experience.source,
          applicability: experience.applicability,
          proposal: {
            rationale,
            expectedOutcome,
            semanticTargets: experience.proposal.semanticTargets,
            ...(rationale !== experience.proposal.rationale || expectedOutcome !== experience.proposal.expectedOutcome
              ? { claimsTruncated: true }
              : {}),
          },
          change: {
            patchDigest: experience.change.patchDigest,
            totalBytes: experience.change.totalBytes,
            files: visibleFiles,
          },
          observation: {
            comparison: experience.observation.comparison,
            planned: experience.observation.planned,
            valid: experience.observation.valid,
            excluded: experience.observation.excluded,
            baselineInvalid: experience.observation.baselineInvalid,
            candidateInvalid: experience.observation.candidateInvalid,
            ...(experience.observation.baselineMean === undefined
              ? {}
              : {
                  baselineMean: experience.observation.baselineMean,
                  candidateMean: experience.observation.candidateMean,
                  meanRewardDelta: experience.observation.meanRewardDelta,
                }),
            ...(experience.observation.modificationUse === undefined
              ? {}
              : {
                  modificationUse: {
                    ...experience.observation.modificationUse,
                    artifacts: experience.observation.modificationUse.artifacts
                      .slice(offset, offset + visibleFiles.length)
                      .map((artifact) => ({
                        ...artifact,
                        path: this.experienceText(artifact.path, round.heldOutRef, 500),
                      })),
                  },
                }),
          },
          classification: experience.classification,
        },
        offset,
        ...(nextOffset === undefined ? {} : { nextOffset }),
      })
      const visibleFiles: unknown[] = []
      let index = offset
      while (index < files.length && visibleFiles.length < limit) {
        const nextFiles = [...visibleFiles, files[index]]
        const nextOffset = index + 1 < files.length ? index + 1 : undefined
        if (
          this.experienceResponseBytes(response(nextFiles, nextOffset), round.heldOutRef) >
          EXPERIENCE_V1_MAX_READ_BYTES - 256
        )
          break
        visibleFiles.push(files[index])
        index += 1
      }
      if (index < files.length && visibleFiles.length === 0) {
        throw new Error('one seed experience record file exceeds the fixed response limit')
      }
      return response(visibleFiles, index < files.length ? index : undefined)
    }
    if (view === 'task-results') {
      const items = [...experience.observation.taskResults, ...experience.observation.excludedTaskResults]
        .sort((left, right) => left.trialKey.localeCompare(right.trialKey))
        .map((item) => this.publicExperienceTask(item, round.heldOutRef))
      const pageBase = {
        ...base,
        coverage: {
          planned: experience.observation.planned,
          valid: experience.observation.valid,
          excluded: experience.observation.excluded,
        },
        ...(experience.observation.modificationUse === undefined
          ? {}
          : {
              modificationUse: {
                schemaVersion: experience.observation.modificationUse.schemaVersion,
                extractorVersion: experience.observation.modificationUse.extractorVersion,
                candidateTrials: experience.observation.modificationUse.candidateTrials,
                statusCounts: experience.observation.modificationUse.statusCounts,
                validPairStatusCounts: experience.observation.modificationUse.validPairStatusCounts,
                conditionedResults: experience.observation.modificationUse.conditionedResults,
              },
            }),
        offset,
      }
      const page = this.experiencePage(pageBase, items, offset, limit)
      return {
        ...pageBase,
        results: page.items,
        ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
      }
    }
    if (view === 'diff') {
      const selectedFiles = experience.change.files.slice(offset, offset + limit)
      if (selectedFiles.length === 0) throw new TypeError('experience diff offset is outside the changed-file list')
      const visibleFiles = selectedFiles.map((file) => ({
        ...file,
        path: this.experienceText(file.path, round.heldOutRef, 500),
      }))
      const nextOffset =
        offset + selectedFiles.length < experience.change.files.length ? offset + selectedFiles.length : undefined
      try {
        const diff = await this.builder.readHarnessDiff(
          experience.source.parentHarnessRef,
          experience.source.candidateHarnessRef,
          selectedFiles.map((file) => file.path),
          EXPERIENCE_V1_MAX_READ_BYTES,
          signal,
        )
        const safePatch = this.sanitize(diff.patch, round.heldOutRef) as string
        const responseForPatch = (patch: string): Record<string, unknown> => ({
          ...base,
          change: {
            patchDigest: experience.change.patchDigest,
            totalBytes: experience.change.totalBytes,
            fileCount: experience.change.files.length,
            files: visibleFiles,
          },
          offset,
          ...(nextOffset === undefined ? {} : { nextOffset }),
          diff: {
            parentRef: diff.parentRef,
            candidateRef: diff.candidateRef,
            paths: visibleFiles.map((file) => file.path),
            patch,
            patchBytes: diff.patchBytes,
            contentDigest: diff.contentDigest,
            truncated: diff.truncated || patch !== safePatch,
          },
        })
        const complete = responseForPatch(safePatch)
        if (this.experienceResponseBytes(complete, round.heldOutRef) <= EXPERIENCE_V1_MAX_READ_BYTES) return complete

        let low = 0
        let high = Buffer.byteLength(safePatch)
        let visiblePatch = ''
        while (low <= high) {
          const middle = Math.floor((low + high) / 2)
          const candidatePatch = middle === 0 ? '' : boundedUtf8(safePatch, middle)
          if (
            this.experienceResponseBytes(responseForPatch(candidatePatch), round.heldOutRef) <=
            EXPERIENCE_V1_MAX_READ_BYTES
          ) {
            visiblePatch = candidatePatch
            low = middle + 1
          } else {
            high = middle - 1
          }
        }
        return responseForPatch(visiblePatch)
      } catch {
        signal.throwIfAborted()
        return {
          ...base,
          available: false,
          reason: 'The verified candidate/parent Git objects for this historical diff are unavailable.',
        }
      }
    }
    return this.readTrajectory(sessionId, round, experience, base, args, signal)
  }

  private experiencePage(
    base: Record<string, unknown>,
    items: readonly unknown[],
    offset: number,
    limit: number,
  ): { items: unknown[]; nextOffset?: number } {
    const visible: unknown[] = []
    let index = offset
    while (index < items.length && visible.length < limit) {
      const next = [...visible, items[index]]
      if (Buffer.byteLength(JSON.stringify({ ...base, results: next })) > EXPERIENCE_V1_MAX_READ_BYTES - 512) {
        if (visible.length === 0) throw new Error('one seed experience item exceeds the fixed response limit')
        break
      }
      visible.push(items[index])
      index += 1
    }
    return { items: visible, ...(index < items.length ? { nextOffset: index } : {}) }
  }

  private publicExperienceTask(
    item:
      | SeedExperienceRecord['observation']['taskResults'][number]
      | SeedExperienceRecord['observation']['excludedTaskResults'][number],
    heldOutRef: string,
  ): Record<string, unknown> {
    const side = (value: typeof item.baseline): Record<string, unknown> => {
      const modificationUse = value.modificationUse
      const prioritizedArtifacts =
        modificationUse === undefined
          ? []
          : [...modificationUse.artifacts].sort((left, right) => {
              const priority = { observed: 0, 'attempted-failure': 1, unknown: 2, 'not-observed': 3 }
              return priority[left.status] - priority[right.status] || left.path.localeCompare(right.path)
            })
      let actionExamples = 8
      const visibleArtifacts = prioritizedArtifacts.slice(0, 12).map((artifact) => {
        const actions = artifact.actions.slice(0, actionExamples)
        actionExamples -= actions.length
        return {
          ...artifact,
          path: this.experienceText(artifact.path, heldOutRef, 500),
          actions: actions.map((action) => ({
            ...action,
            sessionId: boundedUtf8(action.sessionId, 200),
            sourcePath: this.experienceText(action.sourcePath, heldOutRef, 500),
            ...(action.callId === undefined ? {} : { callId: boundedUtf8(action.callId, 300) }),
            ...(action.toolName === undefined ? {} : { toolName: boundedUtf8(action.toolName, 100) }),
          })),
          ...(artifact.observedActionCount + artifact.failedActionCount <= actions.length
            ? {}
            : {
                actionExamplesOmitted: artifact.observedActionCount + artifact.failedActionCount - actions.length,
              }),
        }
      })
      return {
        status: value.status,
        ...(value.trialName === undefined ? {} : { trialName: this.experienceText(value.trialName, heldOutRef, 300) }),
        ...(value.runId === undefined ? {} : { runId: boundedUtf8(value.runId, 160) }),
        ...(value.attempt === undefined ? {} : { attempt: value.attempt }),
        ...(value.reward === undefined ? {} : { reward: value.reward }),
        ...(modificationUse === undefined
          ? {}
          : {
              modificationUse: {
                ...modificationUse,
                artifactCount: modificationUse.artifacts.length,
                artifacts: visibleArtifacts,
                ...(prioritizedArtifacts.length <= visibleArtifacts.length
                  ? {}
                  : {
                      artifactsOmitted: prioritizedArtifacts.length - visibleArtifacts.length,
                    }),
              },
            }),
      }
    }
    return {
      valid: item.valid,
      trialKey: boundedUtf8(item.trialKey, 600),
      taskName: this.experienceText(item.taskName, heldOutRef, 300),
      ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
      baseline: side(item.baseline),
      candidate: side(item.candidate),
      ...(item.valid ? { rewardDelta: item.rewardDelta } : { reasons: item.reasons }),
    }
  }

  private experienceText(value: string, heldOutRef: string, maxBytes: number): string {
    return boundedUtf8(this.sanitize(value, heldOutRef) as string, maxBytes)
  }

  private experienceResponseBytes(value: unknown, heldOutRef: string): number {
    return Buffer.byteLength(JSON.stringify(publicJson(this.sanitize(value, heldOutRef))))
  }

  response(value: unknown, heldOutRef: string, maxBytes: number): JsonValue {
    const response = publicJson(this.sanitize(value, heldOutRef))
    if (Buffer.byteLength(JSON.stringify(response)) > maxBytes) {
      throw new Error(`bounded seed experience response exceeded its fixed ${maxBytes}-byte limit`)
    }
    return response
  }
}
