import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import type {
  EvaluationEvidence,
  EvaluationRequest,
  EvaluationReservation,
  EvaluationSubmissionIntent,
} from '../../types.js'
import { atomicJSON } from '../storage/atomic.js'
import { withFileLock } from '../storage/file-lock.js'
import type { HitchExecutionContext } from './contracts.js'
import { HitchEvaluationError } from './contracts.js'
import { HitchEvaluationClient, type HitchEvaluationClientOptions } from './evaluation-client.js'

export interface HitchOperationBinding {
  context: HitchExecutionContext
  request: EvaluationRequest
  options: HitchEvaluationClientOptions
}
interface Receipt {
  version: 1
  receiptDigest?: string
  operationId: string
  binding?: HitchOperationBinding
  bindingDigest?: string
  intent?: EvaluationSubmissionIntent
  submissionStarted?: true
  reservation?: EvaluationReservation
  evidence?: EvaluationEvidence
  cancelRequested?: true
  cancelled?: true
}
type Client = Pick<
  HitchEvaluationClient,
  | 'prepareSubmission'
  | 'reserve'
  | 'recoverReservation'
  | 'lookupReservation'
  | 'evaluate'
  | 'inspectResult'
  | 'cancelReservation'
>

/** An execution receipt for one already-budgeted operation; owns no search state or budget. */
export class HitchEvaluationOperations {
  constructor(
    readonly root: string,
    private readonly client: (options: HitchEvaluationClientOptions) => Client = (options) =>
      new HitchEvaluationClient(options),
  ) {}
  private path(id: string): string {
    if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new TypeError('invalid-operation-id')
    return join(this.root, `${id.slice(7)}.json`)
  }
  private async read(id: string): Promise<Receipt | undefined> {
    let receipt: Receipt
    try {
      receipt = JSON.parse(await readFile(this.path(id), 'utf8')) as Receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const { receiptDigest, ...body } = receipt
    if (
      receiptDigest !== canonicalDigest(body) ||
      receipt.version !== 1 ||
      receipt.operationId !== id ||
      (receipt.binding && receipt.bindingDigest !== canonicalDigest(receipt.binding)) ||
      (receipt.intent && !receipt.binding) ||
      (receipt.submissionStarted && !receipt.intent) ||
      (receipt.reservation && !receipt.submissionStarted) ||
      (receipt.evidence && (!receipt.reservation || receipt.evidence.evalId !== receipt.reservation.evalId))
    )
      throw new TypeError('hitch-operation-receipt-corrupt')
    return receipt
  }
  private save(receipt: Receipt): Promise<void> {
    const { receiptDigest: _digest, ...body } = receipt
    return atomicJSON(this.path(receipt.operationId), { ...body, receiptDigest: canonicalDigest(body) })
  }
  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return withFileLock(`${this.path(id)}.lock`, fn)
  }
  private assertActive(receipt: Receipt): void {
    if (receipt.cancelRequested)
      throw new HitchEvaluationError('Hitch operation cancellation was requested', 'hitch_operation_cancelled')
  }
  private async reserve(receipt: Receipt, signal: AbortSignal, recovery: boolean): Promise<Receipt> {
    this.assertActive(receipt)
    if (receipt.reservation) return receipt
    if (!receipt.binding || !receipt.intent) throw new TypeError('hitch-operation-not-prepared')
    const { context, request, options } = receipt.binding,
      client = this.client(options)
    signal.throwIfAborted()
    if (!receipt.submissionStarted) {
      receipt.submissionStarted = true
      await this.save(receipt)
      if (signal.aborted) {
        // No remote call has begun. Preserve that proof for cancellation.
        delete receipt.submissionStarted
        await this.save(receipt)
        signal.throwIfAborted()
      }
    }
    receipt.reservation = await (recovery
      ? client.recoverReservation(context, request, signal, receipt.intent)
      : client.reserve(context, request, signal, receipt.intent))
    await this.save(receipt)
    return receipt
  }
  async execute(id: string, binding: HitchOperationBinding, signal: AbortSignal): Promise<EvaluationEvidence> {
    signal.throwIfAborted()
    binding = structuredClone(binding)
    if (binding.options.controlPlane?.mode !== 'daemon')
      throw new TypeError('Durable Hitch operations require daemon mode')
    if (binding.options.infrastructureRetries !== 0)
      throw new TypeError('Durable Hitch operations require explicit zero infrastructure retries')
    const receipt = await this.lock(id, async () => {
      const previous = await this.read(id)
      if (previous) {
        this.assertActive(previous)
        if (previous.bindingDigest !== canonicalDigest(binding)) throw new TypeError('hitch-operation-input-conflict')
        return this.reserve(previous, signal, true)
      }
      const intent = this.client(binding.options).prepareSubmission(binding.context, binding.request)
      if (!intent) throw new TypeError('hitch-operation-intent-required')
      const created: Receipt = { version: 1, operationId: id, binding, bindingDigest: canonicalDigest(binding), intent }
      // Publish the exact idempotency key and arguments before the first remote call.
      await this.save(created)
      return this.reserve(created, signal, false)
    })
    if (receipt.evidence) return structuredClone(receipt.evidence)
    const { context, request, options } = receipt.binding!
    // Do not hold a file lock during watch: a separate operator can cancel the owner.
    const evidence = await this.client(options).evaluate(context, request, signal, receipt.reservation)
    return this.complete(id, evidence)
  }
  async inspect(id: string, signal: AbortSignal): Promise<EvaluationEvidence | undefined> {
    signal.throwIfAborted()
    const receipt = await this.lock(id, async () => {
      const stored = await this.read(id)
      if (!stored) return undefined
      this.assertActive(stored)
      if (stored.evidence) return stored
      return this.reserve(stored, signal, true)
    })
    if (!receipt) return undefined
    if (receipt.evidence) return structuredClone(receipt.evidence)
    const { context, request, options } = receipt.binding!
    const result = await this.client(options).inspectResult(
      context,
      request,
      receipt.reservation!,
      signal,
      receipt.intent,
    )
    if (result.status === 'complete') return this.complete(id, result.evidence)
    if (result.status === 'failed') throw new HitchEvaluationError(result.message, result.code)
    return undefined
  }
  private complete(id: string, evidence: EvaluationEvidence): Promise<EvaluationEvidence> {
    return this.lock(id, async () => {
      const receipt = await this.read(id)
      if (!receipt?.binding || !receipt.reservation) throw new TypeError('hitch-operation-not-reserved')
      this.assertActive(receipt)
      const { request } = receipt.binding
      if (
        evidence.provider !== receipt.reservation.provider ||
        evidence.evalId !== receipt.reservation.evalId ||
        evidence.dataset !== request.dataset ||
        evidence.conditionId !== request.condition.conditionId ||
        evidence.requestedCommit !== request.harnessRef ||
        evidence.actualCommit !== request.harnessRef
      )
        throw new TypeError('hitch-operation-evidence-mismatch')
      if (receipt.evidence && canonicalDigest(receipt.evidence) !== canonicalDigest(evidence))
        throw new TypeError('hitch-operation-evidence-conflict')
      receipt.evidence = structuredClone(evidence)
      await this.save(receipt)
      return structuredClone(evidence)
    })
  }
  async cancel(id: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.lock(id, async () => {
      const receipt = (await this.read(id)) ?? { version: 1, operationId: id }
      if (receipt.evidence || receipt.cancelled) return
      receipt.cancelRequested = true
      await this.save(receipt)
      if (receipt.binding && receipt.intent && receipt.submissionStarted) {
        const client = this.client(receipt.binding.options)
        // Cancellation must never replay a submission that might not have started.
        const found = receipt.reservation ?? (await client.lookupReservation(receipt.intent, signal))
        if (found) receipt.reservation = found
        if (!receipt.reservation)
          throw new HitchEvaluationError(
            'Submission outcome remains unknown; retry cancellation to inspect its original key',
            'hitch_operation_cancellation_pending',
          )
        await this.save(receipt)
        await client.cancelReservation(receipt.reservation, receipt.intent)
      }
      receipt.cancelled = true
      await this.save(receipt)
    })
  }
}
