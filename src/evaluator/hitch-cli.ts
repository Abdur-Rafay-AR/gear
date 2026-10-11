import { type ProcessResult, HitchEvaluationError } from '../adapters/hitch/contracts.js'
import { HitchEvaluationClient } from '../adapters/hitch/evaluation-client.js'
import { parseTrajectoryAnalysis, parseTrajectoryEventsPage } from '../adapters/hitch/trajectory-wire.js'
import { digest, exactFields, excerpt, integer, optionalString, record, string, structuredCliError } from '../adapters/hitch/wire-primitives.js'
import type { HitchTrajectoryAnalysis, HitchTrajectoryEventsPage, HitchTrajectoryEventsQuery, HitchTrajectoryReader, HitchVerifierDiagnosticPage, HitchVerifierDiagnosticPageQuery, RefineEvaluator } from '../types.js'
export { HitchEvaluationError } from '../adapters/hitch/contracts.js'
export type { HitchEvaluationClientOptions as HitchCliEvaluatorOptions } from '../adapters/hitch/evaluation-client.js'

interface SharedTrajectoryLoad {
  promise: Promise<HitchTrajectoryAnalysis>
  controller: AbortController
  waiters: number
  settled: boolean
}

/** Compatibility facade: diagnostic views remain separate from the reusable execution client. */
export class HitchCliEvaluator extends HitchEvaluationClient implements RefineEvaluator, HitchTrajectoryReader {
  private readonly trajectoryCache = new Map<string, { analysis: HitchTrajectoryAnalysis; bytes: number }>()

  private readonly trajectoryDigestByRun = new Map<string, string>()

  private readonly trajectoryLoads = new Map<string, SharedTrajectoryLoad>()

  private trajectoryCacheBytes = 0

  async inspectTrajectoryAnalysis(runId: string, signal: AbortSignal): Promise<HitchTrajectoryAnalysis> {
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new TypeError('Hitch trajectory requires a valid run ID')
    signal.throwIfAborted()
    const cachedDigest = this.trajectoryDigestByRun.get(runId)
    const cached = cachedDigest === undefined ? undefined : this.trajectoryCache.get(`${runId}:${cachedDigest}`)
    if (cached !== undefined) {
      this.trajectoryCache.delete(`${runId}:${cachedDigest}`)
      this.trajectoryCache.set(`${runId}:${cachedDigest}`, cached)
      return cached.analysis
    }
    const pending = this.trajectoryLoads.get(runId)
    if (pending !== undefined) return this.waitForTrajectoryLoad(runId, pending, signal)
    const controller = new AbortController()
    const shared: SharedTrajectoryLoad = {
      promise: this.fetchTrajectoryAnalysis(runId, controller.signal),
      controller,
      waiters: 0,
      settled: false,
    }
    this.trajectoryLoads.set(runId, shared)
    void shared.promise.then(
      analysis => {
        shared.settled = true
        this.cacheTrajectory(analysis)
        if (this.trajectoryLoads.get(runId) === shared) this.trajectoryLoads.delete(runId)
      },
      () => {
        shared.settled = true
        if (this.trajectoryLoads.get(runId) === shared) this.trajectoryLoads.delete(runId)
      },
    )
    return this.waitForTrajectoryLoad(runId, shared, signal)
  }


  async inspectTrajectoryEvents(
    runId: string,
    query: Readonly<HitchTrajectoryEventsQuery>,
    signal: AbortSignal,
  ): Promise<HitchTrajectoryEventsPage> {
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new TypeError('Hitch trajectory requires a valid run ID')
    const limit = query.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('trajectory events limit must be between 1 and 1000')
    }
    if (query.seqStart !== undefined && (!Number.isSafeInteger(query.seqStart) || query.seqStart < 0)) {
      throw new TypeError('trajectory events seqStart must be a non-negative integer')
    }
    if (query.seqEnd !== undefined && (!Number.isSafeInteger(query.seqEnd) || query.seqEnd < 0)) {
      throw new TypeError('trajectory events seqEnd must be a non-negative integer')
    }
    if (query.seqStart !== undefined && query.seqEnd !== undefined && query.seqStart > query.seqEnd) {
      throw new TypeError('trajectory events seqStart must not exceed seqEnd')
    }
    if (query.field !== undefined && (query.seqStart === undefined || query.seqStart !== query.seqEnd
      || query.canonicalSha256 === undefined)) {
      throw new TypeError('trajectory events field requires one exact sequence and canonicalSha256')
    }
    if (query.canonicalSha256 !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(query.canonicalSha256)) {
      throw new TypeError('trajectory events canonicalSha256 is invalid')
    }
    if (query.cursor !== undefined && (query.cursor.length === 0 || query.cursor.length > 16_384)) {
      throw new TypeError('trajectory events cursor is invalid')
    }
    const configuredMaxBytes = this.options.maxTrajectoryEventsBytes
      ?? Math.min(this.options.maxTrajectoryOutputBytes, 4 * 1024 * 1024)
    if (query.maxBytes !== undefined && (!Number.isSafeInteger(query.maxBytes) || query.maxBytes < 1)) {
      throw new TypeError('trajectory events maxBytes must be a positive integer')
    }
    const maxBytes = Math.min(configuredMaxBytes, query.maxBytes ?? configuredMaxBytes)
    const eventTypes = query.eventTypes === undefined
      ? undefined
      : [...new Set(query.eventTypes.filter(value => value.length > 0))].sort()
    if (eventTypes?.length === 0 || eventTypes?.some(value => value.length > 1_024)) {
      throw new TypeError('trajectory events eventTypes must contain event type names of at most 1024 characters')
    }
    const normalizedQuery: HitchTrajectoryEventsQuery = {
      ...query,
      ...(eventTypes === undefined ? {} : { eventTypes }),
      maxBytes,
    }
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'trajectory', 'events', runId,
      ...(eventTypes === undefined ? [] : ['--types', eventTypes.join(',')]),
      ...(query.seqStart === undefined ? [] : ['--seq-start', String(query.seqStart)]),
      ...(query.seqEnd === undefined ? [] : ['--seq-end', String(query.seqEnd)]),
      ...(query.field === undefined ? [] : ['--field', query.field]),
      ...(query.canonicalSha256 === undefined ? [] : ['--canonical-sha256', query.canonicalSha256]),
      ...(query.cursor === undefined ? [] : ['--cursor', query.cursor]),
      '--limit', String(limit), '--max-bytes', String(maxBytes), '--json',
    ]
    const processResult = await this.run(args, this.repositoryPath, signal, maxBytes)
    if (processResult.exitCode !== 0) throw this.trajectoryCommandError('events', runId, processResult)
    let parsed: unknown
    try { parsed = JSON.parse(processResult.stdout) }
    catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid trajectory events JSON (${String(error)})`, 'invalid_hitch_json')
    }
    return parseTrajectoryEventsPage(parsed, runId, normalizedQuery, limit)
  }


  async inspectVerifierDiagnosticPage(
    runId: string,
    query: Readonly<HitchVerifierDiagnosticPageQuery>,
    signal: AbortSignal,
  ): Promise<HitchVerifierDiagnosticPage> {
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new TypeError('Hitch verifier diagnostics require a valid run ID')
    const names: readonly HitchVerifierDiagnosticPageQuery['name'][] = [
      'ctrf.json', 'test-stdout.txt', 'test-stderr.txt', 'stdout.txt', 'stderr.txt',
    ]
    if (!names.includes(query.name)) throw new TypeError('Hitch verifier diagnostic name is invalid')
    const offset = query.offset ?? 0
    const limit = query.limit ?? 64 * 1024
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError('Hitch verifier diagnostic offset must be a non-negative integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > 64 * 1024) {
      throw new TypeError('Hitch verifier diagnostic limit must be between 4 and 65536')
    }
    if (query.sha256 !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(query.sha256)) {
      throw new TypeError('Hitch verifier diagnostic sha256 is invalid')
    }
    signal.throwIfAborted()
    const capabilityResult = await this.run(['capabilities', '--json'], this.repositoryPath, signal, 16_384)
    if (capabilityResult.exitCode !== 0) {
      throw new HitchEvaluationError(
        'Hitch does not expose bounded verifier diagnostic pages',
        'hitch_verifier_diagnostic_pages_unavailable',
      )
    }
    let parsedCapabilities: unknown
    try { parsedCapabilities = JSON.parse(capabilityResult.stdout) }
    catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid capabilities JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const capabilities = record(parsedCapabilities, 'Hitch capabilities')
    if (capabilities.schema_version !== '1') {
      throw new HitchEvaluationError('Hitch verifier diagnostic capability schema is invalid', 'invalid_hitch_result')
    }
    if (capabilities.verifier_diagnostic_pages === undefined) {
      throw new HitchEvaluationError(
        'Hitch does not expose bounded verifier diagnostic pages',
        'hitch_verifier_diagnostic_pages_unavailable',
      )
    }
    if (capabilities.verifier_diagnostic_pages !== '1') {
      throw new HitchEvaluationError('Hitch verifier_diagnostic_pages capability is invalid', 'invalid_hitch_result')
    }
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'verifier', 'artifact', runId, query.name,
      '--offset', String(offset), '--limit', String(limit),
      ...(query.sha256 === undefined ? [] : ['--sha256', query.sha256]),
      '--json',
    ]
    const processResult = await this.run(
      args,
      this.repositoryPath,
      signal,
      Math.min(this.options.maxTrajectoryOutputBytes, limit * 6 + 16 * 1024),
    )
    if (processResult.exitCode !== 0) {
      const output = `${processResult.stderr}\n${processResult.stdout}`.trim()
      const structured = structuredCliError(output)
      throw new HitchEvaluationError(
        structured === undefined
          ? `Hitch verifier artifact failed with exit ${processResult.exitCode}: ${excerpt(output, 1_000)}`
          : `Hitch verifier artifact failed: ${excerpt(structured.message, 1_000)}`,
        structured?.code ?? 'hitch_verifier_diagnostic_page_failed',
      )
    }
    let parsed: unknown
    try { parsed = JSON.parse(processResult.stdout) }
    catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid verifier diagnostic page JSON (${String(error)})`, 'invalid_hitch_json')
    }
    const result = record(parsed, 'Hitch verifier diagnostic page')
    exactFields(result, ['schema_version', 'kind', 'run_id', 'artifact', 'page'], 'Hitch verifier diagnostic page')
    if (result.schema_version !== '1' || result.kind !== 'verifier-diagnostic-page' || result.run_id !== runId) {
      throw new HitchEvaluationError('Hitch verifier diagnostic page identity does not match the request', 'invalid_hitch_result')
    }
    const artifact = record(result.artifact, 'verifier diagnostic artifact')
    exactFields(artifact, ['name', 'media_type', 'bytes', 'sha256', 'source_complete', 'loss_reason'], 'verifier diagnostic artifact')
    const name = string(artifact.name, 'verifier diagnostic artifact.name')
    if (name !== query.name) throw new HitchEvaluationError('Hitch verifier diagnostic artifact name does not match the request', 'invalid_hitch_result')
    const mediaType = string(artifact.media_type, 'verifier diagnostic artifact.media_type')
    const expectedMediaType = name === 'ctrf.json' ? 'application/json' : 'text/plain'
    if (mediaType !== expectedMediaType) throw new HitchEvaluationError('Hitch verifier diagnostic media type is invalid', 'invalid_hitch_result')
    const bytes = integer(artifact.bytes, 'verifier diagnostic artifact.bytes')
    const sha256 = digest(artifact.sha256, 'verifier diagnostic artifact.sha256')
    if (typeof artifact.source_complete !== 'boolean') {
      throw new HitchEvaluationError('verifier diagnostic artifact.source_complete must be boolean', 'invalid_hitch_result')
    }
    const lossReason = optionalString(artifact.loss_reason, 'verifier diagnostic artifact.loss_reason')
    if (artifact.source_complete && lossReason !== undefined) {
      throw new HitchEvaluationError('complete verifier diagnostic artifact cannot have loss_reason', 'invalid_hitch_result')
    }
    if (!artifact.source_complete && lossReason === undefined) {
      throw new HitchEvaluationError('incomplete verifier diagnostic artifact requires loss_reason', 'invalid_hitch_result')
    }
    if (query.sha256 !== undefined && sha256 !== query.sha256) {
      throw new HitchEvaluationError('Hitch verifier diagnostic artifact changed while paging', 'verifier_diagnostic_version_mismatch')
    }
    const page = record(result.page, 'verifier diagnostic page')
    exactFields(page, ['offset', 'bytes', 'text', 'eof', 'next_offset'], 'verifier diagnostic page')
    const pageOffset = integer(page.offset, 'verifier diagnostic page.offset')
    const pageBytes = integer(page.bytes, 'verifier diagnostic page.bytes')
    if (pageOffset !== offset || typeof page.text !== 'string' || typeof page.eof !== 'boolean'
      || Buffer.byteLength(page.text) !== pageBytes || pageBytes > limit) {
      throw new HitchEvaluationError('Hitch verifier diagnostic page has inconsistent offset or bytes', 'invalid_hitch_result')
    }
    const nextOffset = page.next_offset === undefined
      ? undefined
      : integer(page.next_offset, 'verifier diagnostic page.next_offset')
    if (!artifact.source_complete) {
      if (pageOffset !== 0 || pageBytes !== 0 || page.text !== '' || !page.eof || nextOffset !== undefined) {
        throw new HitchEvaluationError('incomplete verifier diagnostic must return a terminal empty page', 'invalid_hitch_result')
      }
    } else if (page.eof) {
      if (nextOffset !== undefined || pageOffset + pageBytes !== bytes) {
        throw new HitchEvaluationError('Hitch verifier diagnostic EOF is inconsistent', 'invalid_hitch_result')
      }
    } else if (pageBytes === 0 || nextOffset !== pageOffset + pageBytes || nextOffset > bytes) {
      throw new HitchEvaluationError('Hitch verifier diagnostic continuation is inconsistent', 'invalid_hitch_result')
    }
    return {
      schemaVersion: 1,
      kind: 'verifier-diagnostic-page',
      runId,
      artifact: {
        name: query.name,
        mediaType: mediaType as 'application/json' | 'text/plain',
        bytes,
        sha256,
        sourceComplete: artifact.source_complete,
        ...(lossReason === undefined ? {} : { lossReason }),
      },
      page: {
        offset: pageOffset,
        bytes: pageBytes,
        text: page.text,
        eof: page.eof,
        ...(nextOffset === undefined ? {} : { nextOffset }),
      },
    }
  }


  private waitForTrajectoryLoad(
    runId: string,
    shared: SharedTrajectoryLoad,
    signal: AbortSignal,
  ): Promise<HitchTrajectoryAnalysis> {
    signal.throwIfAborted()
    shared.waiters += 1
    return new Promise<HitchTrajectoryAnalysis>((resolvePromise, reject) => {
      let completed = false
      const release = (): void => {
        if (completed) return
        completed = true
        signal.removeEventListener('abort', abort)
        shared.waiters -= 1
        if (shared.waiters === 0 && !shared.settled && this.trajectoryLoads.get(runId) === shared) {
          shared.controller.abort(new Error(`trajectory load abandoned for ${runId}`))
        }
      }
      const abort = (): void => {
        release()
        reject(signal.reason ?? new Error('trajectory load aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
      void shared.promise.then(
        analysis => { release(); resolvePromise(analysis) },
        error => { release(); reject(error) },
      )
    })
  }


  private async fetchTrajectoryAnalysis(runId: string, signal: AbortSignal): Promise<HitchTrajectoryAnalysis> {
    const maxBytes = this.options.maxTrajectoryAnalysisBytes
      ?? Math.min(this.options.maxTrajectoryOutputBytes, 16 * 1024 * 1024)
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'trajectory', 'project', runId, '--profile', 'analysis', '--max-bytes', String(maxBytes), '--json',
    ]
    const processResult = await this.run(args, this.repositoryPath, signal, maxBytes)
    if (processResult.exitCode !== 0) throw this.trajectoryCommandError('project', runId, processResult)
    let parsed: unknown
    try { parsed = JSON.parse(processResult.stdout) }
    catch (error) {
      throw new HitchEvaluationError(`Hitch emitted invalid trajectory analysis JSON (${String(error)})`, 'invalid_hitch_json')
    }
    return parseTrajectoryAnalysis(parsed, runId)
  }


  private trajectoryCommandError(action: 'project' | 'events', runId: string, result: ProcessResult): HitchEvaluationError {
    const output = `${result.stderr}\n${result.stdout}`.trim()
    const structured = structuredCliError(output)
    const stableCode = structured?.code
      ?? output.match(/(?:^|\s)(trajectory_[a-z0-9_]+):/u)?.[1]
      ?? `hitch_trajectory_${action}_failed`
    return new HitchEvaluationError(
      `Hitch trajectory ${action} failed for ${runId}: ${excerpt(structured?.message ?? output, 2_000)}`,
      stableCode,
    )
  }


  private cacheTrajectory(analysis: HitchTrajectoryAnalysis): void {
    const maxEntries = this.options.trajectoryCacheEntries ?? 8
    const maxBytes = this.options.trajectoryCacheBytes ?? 256 * 1024 * 1024
    const bytes = Buffer.byteLength(JSON.stringify(analysis))
    if (bytes > maxBytes) return
    const previousDigest = this.trajectoryDigestByRun.get(analysis.runId)
    if (previousDigest !== undefined) {
      const previousKey = `${analysis.runId}:${previousDigest}`
      const previous = this.trajectoryCache.get(previousKey)
      if (previous !== undefined) this.trajectoryCacheBytes -= previous.bytes
      this.trajectoryCache.delete(previousKey)
    }
    const key = `${analysis.runId}:${analysis.source.canonicalSha256}`
    this.trajectoryCache.set(key, { analysis, bytes })
    this.trajectoryDigestByRun.set(analysis.runId, analysis.source.canonicalSha256)
    this.trajectoryCacheBytes += bytes
    while (this.trajectoryCache.size > maxEntries || this.trajectoryCacheBytes > maxBytes) {
      const oldest = this.trajectoryCache.entries().next().value as [string, { analysis: HitchTrajectoryAnalysis; bytes: number }] | undefined
      if (oldest === undefined) break
      this.trajectoryCache.delete(oldest[0])
      this.trajectoryCacheBytes -= oldest[1].bytes
      if (this.trajectoryDigestByRun.get(oldest[1].analysis.runId) === oldest[1].analysis.source.canonicalSha256) {
        this.trajectoryDigestByRun.delete(oldest[1].analysis.runId)
      }
    }
  }
}
