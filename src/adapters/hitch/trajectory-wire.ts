import type {
  HitchTrajectoryAnalysis,
  HitchTrajectoryChunkSummary,
  HitchTrajectoryContentExcerpt,
  HitchTrajectoryEventsPage,
  HitchTrajectoryEventsQuery,
  HitchTrajectoryRequestBoundary,
  HitchTrajectorySurfaceNode,
} from '../../types.js'
import { HitchEvaluationError, type JsonRecord } from './contracts.js'
import {
  booleanValue,
  counts,
  digest,
  exactFields,
  integer,
  record,
  redactions,
  string,
  stringArray,
} from './wire-primitives.js'

export function projectedJsonValue(value: unknown, label: string): import('@deepseek-ai/dsh-session').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => projectedJsonValue(item, `${label}[${index}]`))
  if (typeof value !== 'object') {
    throw new HitchEvaluationError(`${label} must be JSON`, 'invalid_hitch_result')
  }
  const source = value as JsonRecord
  const sourceRef =
    typeof source.source === 'object' && source.source !== null && !Array.isArray(source.source)
      ? (source.source as JsonRecord)
      : undefined
  const excerptFields = ['bytes', 'preview', 'sha256', 'source', 'tail', 'truncated']
  if (
    typeof source.truncated === 'boolean' &&
    sourceRef !== undefined &&
    typeof source.preview === 'string' &&
    Object.keys(source).every((key) => excerptFields.includes(key))
  ) {
    exactFields(sourceRef, ['run_id', 'seq', 'field'], `${label}.source`)
    const bytes = integer(source.bytes, `${label}.bytes`)
    const sha256 = digest(source.sha256, `${label}.sha256`)
    const runId = string(sourceRef.run_id, `${label}.source.run_id`)
    const seq = integer(sourceRef.seq, `${label}.source.seq`)
    const field = string(sourceRef.field, `${label}.source.field`)
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) {
      throw new HitchEvaluationError(`${label}.source.run_id is invalid`, 'invalid_hitch_result')
    }
    if (source.tail !== undefined && typeof source.tail !== 'string') {
      throw new HitchEvaluationError(`${label}.tail must be a string`, 'invalid_hitch_result')
    }
    return {
      preview: source.preview,
      ...(source.tail === undefined ? {} : { tail: source.tail }),
      bytes,
      sha256,
      truncated: source.truncated,
      source: { runId, seq, field },
    }
  }
  return Object.fromEntries(
    Object.entries(source).map(([key, item]) => [key, projectedJsonValue(item, `${label}.${key}`)]),
  )
}

export function surfaceOperation(value: unknown, label: string): HitchTrajectorySurfaceNode['surfaceOp'] {
  if (value === 'append') return value
  const operation = record(value, label)
  exactFields(operation, ['op', 'start', 'end'], label)
  if (operation.op !== 'replace') throw new HitchEvaluationError(`${label}.op is invalid`, 'invalid_hitch_result')
  return {
    op: 'replace',
    start: integer(operation.start, `${label}.start`),
    end: integer(operation.end, `${label}.end`),
  }
}

export function surfaceNode(
  value: unknown,
  index: number,
  runId: string,
  eventCount: number,
): HitchTrajectorySurfaceNode {
  const label = `trajectory analysis surface.nodes[${index}]`
  const node = record(value, label)
  exactFields(node, ['seq', 'event_type', 'surface_op', 'message'], label)
  const seq = integer(node.seq, `${label}.seq`)
  const eventType = node.event_type
  if (eventType !== 'user/message' && eventType !== 'assistant/message' && eventType !== 'tool/result') {
    throw new HitchEvaluationError(`${label}.event_type is invalid`, 'invalid_hitch_result')
  }
  if (seq >= eventCount) throw new HitchEvaluationError(`${label}.seq is out of range`, 'invalid_hitch_result')
  const message = projectedJsonValue(node.message, `${label}.message`)
  validateProjectedSources(message, runId, `${label}.message`)
  return { seq, eventType, surfaceOp: surfaceOperation(node.surface_op, `${label}.surface_op`), message }
}

export function validateProjectedSources(value: unknown, runId: string, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateProjectedSources(item, runId, `${label}[${index}]`)
    })
    return
  }
  if (typeof value !== 'object' || value === null) return
  const item = value as JsonRecord
  const source =
    typeof item.truncated === 'boolean' &&
    typeof item.preview === 'string' &&
    typeof item.source === 'object' &&
    item.source !== null &&
    !Array.isArray(item.source)
      ? (item.source as JsonRecord)
      : undefined
  if (source !== undefined && source.runId !== runId) {
    throw new HitchEvaluationError(`${label} excerpt belongs to another run`, 'invalid_hitch_result')
  }
  for (const [key, child] of Object.entries(item)) validateProjectedSources(child, runId, `${label}.${key}`)
}

export function requestBoundary(
  value: unknown,
  index: number,
  runId: string,
  eventCount: number,
  nodeCount: number,
): HitchTrajectoryRequestBoundary {
  const label = `trajectory analysis surface.request_boundaries[${index}]`
  const boundary = record(value, label)
  exactFields(
    boundary,
    ['turn', 'step', 'attempt', 'retry_id', 'boundary_seq', 'surface_revision', 'request_header_seq'],
    label,
  )
  const boundarySeq = integer(boundary.boundary_seq, `${label}.boundary_seq`)
  const surfaceRevision = integer(boundary.surface_revision, `${label}.surface_revision`)
  if (boundarySeq >= eventCount || surfaceRevision > nodeCount) {
    throw new HitchEvaluationError(`${label} is out of range`, 'invalid_hitch_result')
  }
  const attempt = integer(boundary.attempt, `${label}.attempt`)
  if (attempt < 0) throw new HitchEvaluationError(`${label}.attempt must be non-negative`, 'invalid_hitch_result')
  const retryId =
    boundary.retry_id === undefined ? undefined : projectedJsonValue(boundary.retry_id, `${label}.retry_id`)
  if (retryId !== undefined) validateProjectedSources(retryId, runId, `${label}.retry_id`)
  return {
    turn: integer(boundary.turn, `${label}.turn`),
    step: integer(boundary.step, `${label}.step`),
    attempt,
    ...(retryId === undefined ? {} : { retryId }),
    boundarySeq,
    surfaceRevision,
    ...(boundary.request_header_seq === undefined
      ? {}
      : {
          requestHeaderSeq: integer(boundary.request_header_seq, `${label}.request_header_seq`),
        }),
  }
}

export function hitchContentExcerpt(value: unknown, label: string, runId: string): HitchTrajectoryContentExcerpt {
  const projected = projectedJsonValue(value, label)
  const excerpt = record(projected, label)
  const source = record(excerpt.source, `${label}.source`)
  if (typeof excerpt.truncated !== 'boolean' || typeof excerpt.preview !== 'string' || source.runId !== runId) {
    throw new HitchEvaluationError(`${label} is not a bound content excerpt`, 'invalid_hitch_result')
  }
  return projected as unknown as HitchTrajectoryContentExcerpt
}

export function chunkSummary(
  value: unknown,
  index: number,
  runId: string,
  eventCount: number,
): HitchTrajectoryChunkSummary {
  const label = `trajectory analysis chunk_summaries[${index}]`
  const summary = record(value, label)
  exactFields(
    summary,
    [
      'turn',
      'step',
      'attempt',
      'retry_id',
      'first_seq',
      'last_seq',
      'count',
      'types',
      'model_boundary_seq',
      'usage',
      'finish_reason',
      'partial',
    ],
    label,
  )
  const firstSeq = integer(summary.first_seq, `${label}.first_seq`)
  const lastSeq = integer(summary.last_seq, `${label}.last_seq`)
  const count = integer(summary.count, `${label}.count`)
  const types = counts(summary.types, `${label}.types`)
  const modelBoundarySeq = integer(summary.model_boundary_seq, `${label}.model_boundary_seq`)
  if (
    count < 1 ||
    firstSeq > lastSeq ||
    lastSeq >= eventCount ||
    modelBoundarySeq !== firstSeq ||
    Object.values(types).reduce((sum, item) => sum + item, 0) !== count
  ) {
    throw new HitchEvaluationError(`${label} has inconsistent range or counts`, 'invalid_hitch_result')
  }
  const attempt = integer(summary.attempt, `${label}.attempt`)
  if (attempt < 0) throw new HitchEvaluationError(`${label}.attempt must be non-negative`, 'invalid_hitch_result')
  const retryId = summary.retry_id === undefined ? undefined : projectedJsonValue(summary.retry_id, `${label}.retry_id`)
  if (retryId !== undefined) validateProjectedSources(retryId, runId, `${label}.retry_id`)
  let partial: HitchTrajectoryChunkSummary['partial']
  if (summary.partial !== undefined) {
    const raw = record(summary.partial, `${label}.partial`)
    exactFields(raw, ['status', 'content', 'streams', 'source_seq_count'], `${label}.partial`)
    if (raw.status !== 'incomplete')
      throw new HitchEvaluationError(`${label}.partial.status is invalid`, 'invalid_hitch_result')
    if ((raw.content === undefined) === (raw.streams === undefined)) {
      throw new HitchEvaluationError(
        `${label}.partial requires exactly one of content or streams`,
        'invalid_hitch_result',
      )
    }
    const sourceSeqCount = integer(raw.source_seq_count, `${label}.partial.source_seq_count`)
    if (raw.streams === undefined) {
      partial = {
        status: 'incomplete',
        content: hitchContentExcerpt(raw.content, `${label}.partial.content`, runId),
        sourceSeqCount,
      }
    } else {
      if (!Array.isArray(raw.streams) || raw.streams.length < 2) {
        throw new HitchEvaluationError(`${label}.partial.streams requires at least two streams`, 'invalid_hitch_result')
      }
      const streams = raw.streams.map((item, streamIndex) => {
        const streamLabel = `${label}.partial.streams[${streamIndex}]`
        const stream = record(item, streamLabel)
        exactFields(stream, ['block_index', 'block_start_seq', 'kind', 'content', 'source_seq_count'], streamLabel)
        const blockIndex = integer(stream.block_index, `${streamLabel}.block_index`)
        const blockStartSeq = integer(stream.block_start_seq, `${streamLabel}.block_start_seq`)
        if (stream.kind !== 'text' && stream.kind !== 'reasoning' && stream.kind !== 'tool_arguments') {
          throw new HitchEvaluationError(`${streamLabel}.kind is invalid`, 'invalid_hitch_result')
        }
        const content = hitchContentExcerpt(stream.content, `${streamLabel}.content`, runId)
        if (
          blockStartSeq < firstSeq ||
          blockStartSeq > lastSeq ||
          content.source.seq !== blockStartSeq ||
          content.source.field !== 'data.chunk.delta'
        ) {
          throw new HitchEvaluationError(`${streamLabel} has an inconsistent source`, 'invalid_hitch_result')
        }
        return {
          blockIndex,
          blockStartSeq,
          kind: stream.kind as 'text' | 'reasoning' | 'tool_arguments',
          content,
          sourceSeqCount: integer(stream.source_seq_count, `${streamLabel}.source_seq_count`),
        }
      })
      if (
        streams.some(
          (stream, streamIndex) => streamIndex > 0 && streams[streamIndex - 1]!.blockStartSeq >= stream.blockStartSeq,
        ) ||
        streams.reduce((total, stream) => total + stream.sourceSeqCount, 0) !== sourceSeqCount
      ) {
        throw new HitchEvaluationError(
          `${label}.partial.streams has inconsistent order or source counts`,
          'invalid_hitch_result',
        )
      }
      partial = { status: 'incomplete', streams, sourceSeqCount }
    }
  }
  const usage = summary.usage === undefined ? undefined : projectedJsonValue(summary.usage, `${label}.usage`)
  const finishReason =
    summary.finish_reason === undefined
      ? undefined
      : projectedJsonValue(summary.finish_reason, `${label}.finish_reason`)
  if (usage !== undefined) validateProjectedSources(usage, runId, `${label}.usage`)
  if (finishReason !== undefined) validateProjectedSources(finishReason, runId, `${label}.finish_reason`)
  return {
    turn: integer(summary.turn, `${label}.turn`),
    step: integer(summary.step, `${label}.step`),
    attempt,
    ...(retryId === undefined ? {} : { retryId }),
    firstSeq,
    lastSeq,
    count,
    types,
    modelBoundarySeq,
    ...(usage === undefined ? {} : { usage }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(partial === undefined ? {} : { partial }),
  }
}

export function parseTrajectoryAnalysis(value: unknown, runId: string): HitchTrajectoryAnalysis {
  const result = record(value, 'Hitch trajectory analysis')
  exactFields(
    result,
    [
      'schema_version',
      'kind',
      'run_id',
      'source',
      'header',
      'surface',
      'events',
      'chunk_summaries',
      'omitted_event_types',
      'coverage',
      'redactions',
    ],
    'Hitch trajectory analysis',
  )
  if (result.schema_version !== '1' || result.kind !== 'trajectory-analysis' || result.run_id !== runId) {
    throw new HitchEvaluationError(
      'Hitch trajectory analysis identity does not match the requested run',
      'invalid_hitch_result',
    )
  }
  const source = record(result.source, 'trajectory analysis source')
  exactFields(
    source,
    ['fidelity', 'provider', 'session_id', 'canonical_sha256', 'canonical_bytes', 'event_count', 'event_types'],
    'trajectory analysis source',
  )
  if (source.fidelity !== 'provider_native' && source.fidelity !== 'normalized' && source.fidelity !== 'minimal') {
    throw new HitchEvaluationError('trajectory analysis source fidelity is invalid', 'invalid_hitch_result')
  }
  const canonicalSha256 = digest(source.canonical_sha256, 'trajectory analysis source.canonical_sha256')
  const eventCount = integer(source.event_count, 'trajectory analysis source.event_count')
  const eventTypes = counts(source.event_types, 'trajectory analysis source.event_types')
  if (Object.values(eventTypes).reduce((sum, count) => sum + count, 0) !== eventCount) {
    throw new HitchEvaluationError('trajectory analysis source event counts are inconsistent', 'invalid_hitch_result')
  }
  const surface = record(result.surface, 'trajectory analysis surface')
  exactFields(
    surface,
    ['fidelity', 'nodes', 'current_node_seqs', 'replacements', 'request_boundaries', 'request_headers'],
    'trajectory analysis surface',
  )
  if (surface.fidelity !== 'exact' && surface.fidelity !== 'normalized' && surface.fidelity !== 'partial') {
    throw new HitchEvaluationError('trajectory analysis surface fidelity is invalid', 'invalid_hitch_result')
  }
  if (
    !Array.isArray(surface.nodes) ||
    !Array.isArray(surface.current_node_seqs) ||
    !Array.isArray(surface.replacements) ||
    !Array.isArray(surface.request_boundaries) ||
    !Array.isArray(surface.request_headers)
  ) {
    throw new HitchEvaluationError('trajectory analysis surface arrays are invalid', 'invalid_hitch_result')
  }
  const nodes = surface.nodes.map((item, index) => surfaceNode(item, index, runId, eventCount))
  if (nodes.some((node, index) => index > 0 && nodes[index - 1]!.seq >= node.seq)) {
    throw new HitchEvaluationError('trajectory analysis surface nodes must be increasing', 'invalid_hitch_result')
  }
  const nodeSeqs = new Set(nodes.map((node) => node.seq))
  const currentNodeSeqs = surface.current_node_seqs.map((seq, index) =>
    integer(seq, `surface.current_node_seqs[${index}]`),
  )
  if (currentNodeSeqs.some((seq) => !nodeSeqs.has(seq)) || new Set(currentNodeSeqs).size !== currentNodeSeqs.length) {
    throw new HitchEvaluationError('trajectory analysis current surface nodes are invalid', 'invalid_hitch_result')
  }
  const replacements = surface.replacements.map((item, index) => {
    const label = `trajectory analysis surface.replacements[${index}]`
    const replacement = record(item, label)
    exactFields(replacement, ['seq', 'start', 'end', 'shadowed_seqs'], label)
    if (!Array.isArray(replacement.shadowed_seqs)) {
      throw new HitchEvaluationError(`${label}.shadowed_seqs must be an array`, 'invalid_hitch_result')
    }
    return {
      seq: integer(replacement.seq, `${label}.seq`),
      start: integer(replacement.start, `${label}.start`),
      end: integer(replacement.end, `${label}.end`),
      shadowedSeqs: replacement.shadowed_seqs.map((seq, seqIndex) =>
        integer(seq, `${label}.shadowed_seqs[${seqIndex}]`),
      ),
    }
  })
  const requestBoundaries = surface.request_boundaries.map((item, index) =>
    requestBoundary(item, index, runId, eventCount, nodes.length),
  )
  if (
    requestBoundaries.some((item, index) => index > 0 && requestBoundaries[index - 1]!.boundarySeq >= item.boundarySeq)
  ) {
    throw new HitchEvaluationError('trajectory analysis request boundaries must be increasing', 'invalid_hitch_result')
  }
  if (
    new Set(requestBoundaries.map((item) => `${item.turn}:${item.step}:${item.attempt}`)).size !==
    requestBoundaries.length
  ) {
    throw new HitchEvaluationError('trajectory analysis request attempts must be unique', 'invalid_hitch_result')
  }
  for (const boundary of requestBoundaries) {
    const priorNode = boundary.surfaceRevision === 0 ? undefined : nodes[boundary.surfaceRevision - 1]
    const nextNode = nodes[boundary.surfaceRevision]
    if (
      (priorNode !== undefined && priorNode.seq >= boundary.boundarySeq) ||
      (nextNode !== undefined && nextNode.seq < boundary.boundarySeq)
    ) {
      throw new HitchEvaluationError(
        'trajectory analysis request boundary has an inconsistent surface revision',
        'invalid_hitch_result',
      )
    }
  }
  const requestHeaders = surface.request_headers.map((item, index) => {
    const label = `trajectory analysis surface.request_headers[${index}]`
    const header = record(item, label)
    exactFields(header, ['seq', 'header'], label)
    const seq = integer(header.seq, `${label}.seq`)
    if (seq >= eventCount) throw new HitchEvaluationError(`${label}.seq is out of range`, 'invalid_hitch_result')
    const projected = projectedJsonValue(header.header, `${label}.header`)
    validateProjectedSources(projected, runId, `${label}.header`)
    return { seq, header: projected }
  })
  if (requestHeaders.some((item, index) => index > 0 && requestHeaders[index - 1]!.seq >= item.seq)) {
    throw new HitchEvaluationError('trajectory analysis request headers must be increasing', 'invalid_hitch_result')
  }
  const headerSeqs = new Set(requestHeaders.map((item) => item.seq))
  if (
    requestBoundaries.some(
      (boundary) => boundary.requestHeaderSeq !== undefined && !headerSeqs.has(boundary.requestHeaderSeq),
    )
  ) {
    throw new HitchEvaluationError(
      'trajectory analysis request boundary references an unknown header',
      'invalid_hitch_result',
    )
  }
  if (
    requestBoundaries.some(
      (boundary) => boundary.requestHeaderSeq !== undefined && boundary.requestHeaderSeq >= boundary.boundarySeq,
    )
  ) {
    throw new HitchEvaluationError(
      'trajectory analysis request boundary references a future header',
      'invalid_hitch_result',
    )
  }
  if (!Array.isArray(result.events) || !Array.isArray(result.chunk_summaries)) {
    throw new HitchEvaluationError(
      'trajectory analysis events and chunk summaries must be arrays',
      'invalid_hitch_result',
    )
  }
  const events = result.events.map((event, index) => {
    const projected = projectedJsonValue(event, `trajectory analysis events[${index}]`)
    validateProjectedSources(projected, runId, `trajectory analysis events[${index}]`)
    const item = record(projected, `trajectory analysis events[${index}]`)
    if (item.type === 'assistant/chunk') {
      throw new HitchEvaluationError(
        'trajectory analysis must not include raw assistant chunks',
        'invalid_hitch_result',
      )
    }
    if (typeof item.type !== 'string' || item.type.length === 0 || eventTypes[item.type] === undefined) {
      throw new HitchEvaluationError(`trajectory analysis events[${index}].type is invalid`, 'invalid_hitch_result')
    }
    const seq = integer(item.seq, `trajectory analysis events[${index}].seq`)
    if (seq >= eventCount)
      throw new HitchEvaluationError(`trajectory analysis events[${index}].seq is out of range`, 'invalid_hitch_result')
    return projected
  })
  if (
    events.some(
      (event, index) =>
        index > 0 &&
        (record(events[index - 1], 'trajectory analysis event').seq as number) >=
          (record(event, 'trajectory analysis event').seq as number),
    )
  ) {
    throw new HitchEvaluationError('trajectory analysis diagnostic events must be increasing', 'invalid_hitch_result')
  }
  const chunkSummaries = result.chunk_summaries.map((item, index) => chunkSummary(item, index, runId, eventCount))
  if (chunkSummaries.some((item, index) => index > 0 && chunkSummaries[index - 1]!.firstSeq >= item.firstSeq)) {
    throw new HitchEvaluationError('trajectory analysis chunk summaries must be increasing', 'invalid_hitch_result')
  }
  const boundariesByAttempt = new Map(
    requestBoundaries.map((item) => [`${item.turn}:${item.step}:${item.attempt}`, item]),
  )
  for (const summary of chunkSummaries) {
    const boundary = boundariesByAttempt.get(`${summary.turn}:${summary.step}:${summary.attempt}`)
    if (
      boundary === undefined ||
      boundary.boundarySeq !== summary.modelBoundarySeq ||
      JSON.stringify(boundary.retryId) !== JSON.stringify(summary.retryId)
    ) {
      throw new HitchEvaluationError(
        'trajectory analysis chunk summary does not match its request boundary',
        'invalid_hitch_result',
      )
    }
  }
  const omittedEventTypes = counts(result.omitted_event_types, 'trajectory analysis omitted_event_types')
  for (const [type, count] of Object.entries(omittedEventTypes)) {
    if (count > (eventTypes[type] ?? 0)) {
      throw new HitchEvaluationError(
        `trajectory analysis omitted count exceeds source count for ${type}`,
        'invalid_hitch_result',
      )
    }
  }
  if ((eventTypes['assistant/chunk'] ?? 0) !== (omittedEventTypes['assistant/chunk'] ?? 0)) {
    throw new HitchEvaluationError(
      'trajectory analysis must account for every assistant chunk as omitted',
      'invalid_hitch_result',
    )
  }
  const coverage = record(result.coverage, 'trajectory analysis coverage')
  exactFields(coverage, ['surface', 'chunks', 'content', 'child_sessions'], 'trajectory analysis coverage')
  if (coverage.surface !== 'complete' && coverage.surface !== 'partial') {
    throw new HitchEvaluationError('trajectory analysis surface coverage is invalid', 'invalid_hitch_result')
  }
  if (coverage.chunks !== 'coalesced' && coverage.chunks !== 'omitted' && coverage.chunks !== 'partial') {
    throw new HitchEvaluationError('trajectory analysis chunk coverage is invalid', 'invalid_hitch_result')
  }
  if (coverage.content !== 'complete' && coverage.content !== 'excerpted' && coverage.content !== 'partial') {
    throw new HitchEvaluationError('trajectory analysis content coverage is invalid', 'invalid_hitch_result')
  }
  if (
    coverage.child_sessions !== 'complete' &&
    coverage.child_sessions !== 'partial' &&
    coverage.child_sessions !== 'none' &&
    coverage.child_sessions !== 'unavailable'
  ) {
    throw new HitchEvaluationError('trajectory analysis child session coverage is invalid', 'invalid_hitch_result')
  }
  const latestHeader = projectedJsonValue(result.header, 'trajectory analysis header')
  validateProjectedSources(latestHeader, runId, 'trajectory analysis header')
  return {
    schemaVersion: 1,
    kind: 'trajectory-analysis',
    runId,
    source: {
      fidelity: source.fidelity,
      ...(source.provider === undefined
        ? {}
        : { provider: string(source.provider, 'trajectory analysis source.provider') }),
      sessionId: string(source.session_id, 'trajectory analysis source.session_id'),
      canonicalSha256,
      canonicalBytes: integer(source.canonical_bytes, 'trajectory analysis source.canonical_bytes'),
      eventCount,
      eventTypes,
    },
    header: latestHeader,
    surface: {
      fidelity: surface.fidelity,
      nodes,
      currentNodeSeqs,
      replacements,
      requestBoundaries,
      requestHeaders,
    },
    events,
    chunkSummaries,
    omittedEventTypes,
    coverage: {
      surface: coverage.surface,
      chunks: coverage.chunks,
      content: coverage.content,
      childSessions: coverage.child_sessions,
    },
    ...(result.redactions === undefined
      ? {}
      : { redactions: redactions(result.redactions, 'trajectory analysis redactions') }),
  }
}

export function parseTrajectoryEventsPage(
  value: unknown,
  runId: string,
  query: Readonly<HitchTrajectoryEventsQuery>,
  limit: number,
): HitchTrajectoryEventsPage {
  const result = record(value, 'Hitch trajectory events page')
  exactFields(
    result,
    [
      'schema_version',
      'kind',
      'run_id',
      'canonical_sha256',
      'filter',
      'events',
      'total_matches',
      'next_cursor',
      'eof',
      'redactions',
    ],
    'Hitch trajectory events page',
  )
  if (result.schema_version !== '1' || result.kind !== 'trajectory-events-page' || result.run_id !== runId) {
    throw new HitchEvaluationError(
      'Hitch trajectory events identity does not match the requested run',
      'invalid_hitch_result',
    )
  }
  const canonicalSha256 = digest(result.canonical_sha256, 'trajectory events canonical_sha256')
  if (query.canonicalSha256 !== undefined && query.canonicalSha256 !== canonicalSha256) {
    throw new HitchEvaluationError('Hitch trajectory events canonical digest mismatch', 'invalid_hitch_result')
  }
  const filter = record(result.filter, 'trajectory events filter')
  exactFields(filter, ['types', 'seq_start', 'seq_end', 'field'], 'trajectory events filter')
  const eventTypes =
    filter.types === undefined ? undefined : stringArray(filter.types, 'trajectory events filter.types')
  const seqStart =
    filter.seq_start === undefined ? undefined : integer(filter.seq_start, 'trajectory events filter.seq_start')
  const seqEnd = filter.seq_end === undefined ? undefined : integer(filter.seq_end, 'trajectory events filter.seq_end')
  const field = filter.field === undefined ? undefined : string(filter.field, 'trajectory events filter.field')
  if (
    (query.eventTypes !== undefined && JSON.stringify(query.eventTypes) !== JSON.stringify(eventTypes)) ||
    (query.seqStart !== undefined && query.seqStart !== seqStart) ||
    (query.seqEnd !== undefined && query.seqEnd !== seqEnd) ||
    (query.field !== undefined && query.field !== field)
  ) {
    throw new HitchEvaluationError(
      'trajectory events response filter does not match the request',
      'invalid_hitch_result',
    )
  }
  if (!Array.isArray(result.events))
    throw new HitchEvaluationError('trajectory events events must be an array', 'invalid_hitch_result')
  if (result.events.length > limit)
    throw new HitchEvaluationError('trajectory events page exceeds requested limit', 'invalid_hitch_result')
  const events = result.events.map((event, index) => {
    const projected = projectedJsonValue(event, `trajectory events events[${index}]`)
    validateProjectedSources(projected, runId, `trajectory events events[${index}]`)
    const item = record(projected, `trajectory events events[${index}]`)
    const type = string(item.type, `trajectory events events[${index}].type`)
    const seq = integer(item.seq, `trajectory events events[${index}].seq`)
    if ((seqStart !== undefined && seq < seqStart) || (seqEnd !== undefined && seq > seqEnd)) {
      throw new HitchEvaluationError(
        'trajectory events response contains an event outside its sequence filter',
        'invalid_hitch_result',
      )
    }
    if (field === undefined && eventTypes !== undefined && !eventTypes.includes(type)) {
      throw new HitchEvaluationError(
        'trajectory events response contains an event outside its type filter',
        'invalid_hitch_result',
      )
    }
    return projected
  })
  if (
    events.some(
      (event, index) =>
        index > 0 &&
        (record(events[index - 1], 'trajectory event').seq as number) >=
          (record(event, 'trajectory event').seq as number),
    )
  ) {
    throw new HitchEvaluationError('trajectory events response must be increasing', 'invalid_hitch_result')
  }
  const totalMatches = integer(result.total_matches, 'trajectory events total_matches')
  if (totalMatches < events.length)
    throw new HitchEvaluationError('trajectory events total_matches is inconsistent', 'invalid_hitch_result')
  const eof = booleanValue(result.eof, 'trajectory events eof')
  const nextCursor =
    result.next_cursor === undefined ? undefined : string(result.next_cursor, 'trajectory events next_cursor')
  if ((eof && nextCursor !== undefined) || (!eof && nextCursor === undefined)) {
    throw new HitchEvaluationError('trajectory events cursor/eof state is inconsistent', 'invalid_hitch_result')
  }
  return {
    schemaVersion: 1,
    kind: 'trajectory-events-page',
    runId,
    canonicalSha256,
    filter: {
      ...(eventTypes === undefined ? {} : { eventTypes }),
      ...(seqStart === undefined ? {} : { seqStart }),
      ...(seqEnd === undefined ? {} : { seqEnd }),
      ...(field === undefined ? {} : { field }),
    },
    events,
    totalMatches,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    eof,
    ...(result.redactions === undefined
      ? {}
      : { redactions: redactions(result.redactions, 'trajectory events redactions') }),
  }
}
