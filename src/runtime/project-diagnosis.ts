import { validateJsonObject } from '../domain/algorithm-protocol.js'
import { canonicalDigest } from '../domain/canonical.js'
import {
  certifyDiagnosis,
  type DiagnosisInput,
  type DiagnosisUsage,
  diagnosisOverBudget,
  diagnosisText,
  validateDiagnosisUsage,
} from '../domain/diagnosis.js'
import { GearError } from '../domain/errors.js'
import type { DiagnosisProvider } from '../ports/diagnosis.js'
import type { ProjectProvider } from '../ports/project.js'
import type { RunStore } from '../ports/run-store.js'
import type { ProjectRun, RunPlan } from './project.js'

function failed(code: string, message: string, runId?: string): never {
  throw new GearError({
    code,
    message,
    ...(runId ? { run_id: runId } : {}),
    retryable: code === 'operation-pending',
    next_action:
      code === 'operation-pending'
        ? `gear resume ${runId}`
        : 'Review the diagnosis provider and frozen budget; changed inputs require a new run.',
  })
}
export function admitDiagnosis(plan: RunPlan, provider: ProjectProvider): void {
  if (!plan.diagnosis) return
  validateDiagnosisUsage(plan.diagnosis.limits)
  if (Object.values(plan.diagnosis.limits).some((v) => v < 1)) throw new TypeError('invalid-diagnosis-budget')
  const port = provider.diagnosis
  if (
    !port?.capabilities?.boundedRequests ||
    !port.capabilities.boundedTokens ||
    !port.capabilities.recovery ||
    !port.capabilities.isolated ||
    typeof port.diagnose !== 'function' ||
    typeof port.inspectDiagnosis !== 'function' ||
    typeof port.cancel !== 'function'
  )
    failed(
      'diagnosis-provider-required',
      'Model diagnosis requires an isolated provider with hard request/token limits and recoverable operations',
    )
  if (!port.identity || port.identity !== plan.diagnosis.providerIdentity)
    failed('diagnosis-identity-mismatch', 'The frozen diagnosis provider changed')
}
export function diagnosisAccounting(run: ProjectRun) {
  const spent: DiagnosisUsage = { requests: 0, inputTokens: 0, outputTokens: 0 }
  const reserved: DiagnosisUsage = { ...spent }
  for (const operation of run.operations)
    if (operation.kind === 'diagnosis' && operation.diagnosis) {
      const result = operation.diagnosis.result
      const value = result?.usage ?? operation.diagnosis.input.limits
      const target = result ? spent : reserved
      for (const key of ['requests', 'inputTokens', 'outputTokens'] as const) {
        if (!Number.isSafeInteger(target[key] + value[key])) throw new TypeError('diagnosis-accounting-overflow')
        target[key] += value[key]
      }
    }
  const limits = run.plan.diagnosis?.limits ?? { requests: 0, inputTokens: 0, outputTokens: 0 }
  return {
    limits,
    spent,
    reserved,
    remaining: {
      requests: Math.max(0, limits.requests - spent.requests - reserved.requests),
      inputTokens: Math.max(0, limits.inputTokens - spent.inputTokens - reserved.inputTokens),
      outputTokens: Math.max(0, limits.outputTokens - spent.outputTokens - reserved.outputTokens),
    },
  }
}
export function seedDiagnosis(run: ProjectRun, candidate: string, ids: string[]) {
  return {
    kind: 'diagnose_seed',
    candidate,
    method: 'seed-score-projection-v1',
    tasks: ids.map((id) => {
      const task = run.plan.benchmark.tasks.find((t) => t.id === id && t.split === 'seed')!
      const trial = run.trials.find((t) => t.candidate === candidate && t.taskId === id && t.split === 'seed')
      return {
        id,
        family: task.family,
        score: trial?.score ?? null,
        status: trial?.score == null ? 'unavailable' : trial.score < 1 ? 'failure' : 'success',
      }
    }),
  }
}
function diagnosisInput(
  run: ProjectRun,
  id: string,
  candidate: string,
  ids: string[],
  limits: DiagnosisUsage,
): DiagnosisInput {
  const parent = run.candidates.find((c) => c.id === candidate)!
  const seed = run.plan.benchmark.tasks.filter((t) => t.split === 'seed')
  const observations = ids.map((taskId) => {
    const task = seed.find((t) => t.id === taskId)!
    const trial = run.trials.find((t) => t.candidate === candidate && t.taskId === taskId && t.split === 'seed')
    return {
      taskId,
      family: task.family,
      instruction: diagnosisText(task.instruction),
      score: trial?.score ?? null,
      evidenceRef: trial ? canonicalDigest([run.id, candidate, parent.digest, task, trial]) : null,
      ...(trial?.result.output === undefined ? {} : { output: diagnosisText(trial.result.output) }),
    }
  })
  return {
    operationId: id,
    parentId: candidate,
    parentDigest: parent.digest,
    cohortDigest: canonicalDigest(seed),
    baselineDigest: canonicalDigest([parent.digest, observations]),
    observations,
    limits,
  }
}

export async function executeDiagnosis(
  run: ProjectRun,
  receiptId: string,
  candidate: string,
  ids: string[],
  provider: DiagnosisProvider,
  store: RunStore,
  signal: AbortSignal,
  remainingCalls: number,
): Promise<Record<string, unknown>> {
  const id = canonicalDigest([run.id, receiptId, 'provider-diagnosis'])
  let operation = run.operations.find((o) => o.id === id)
  const recovering = !!operation
  if (!operation) {
    const remaining = diagnosisAccounting(run).remaining
    if (Object.values(remaining).some((v) => v < 1))
      failed('diagnosis-budget-exhausted', 'No unreserved model diagnosis budget remains', run.id)
    operation = {
      id,
      kind: 'diagnosis',
      candidate,
      status: 'reserved',
      diagnosis: {
        input: diagnosisInput(run, id, candidate, ids, {
          requests: 1,
          inputTokens: Math.floor(remaining.inputTokens / remainingCalls),
          outputTokens: Math.floor(remaining.outputTokens / remainingCalls),
        }),
      },
    }
    run.operations.push(operation)
    await store.write(run.id, run)
  }
  const saved = operation.diagnosis!
  if (!saved.result) {
    const recovered = recovering ? await provider.inspectDiagnosis(id, signal) : { status: 'not-started' as const }
    if (recovered.status === 'pending')
      failed('operation-pending', 'Previous model diagnosis may still be running; its budget remains reserved', run.id)
    if (!['complete', 'not-started'].includes(recovered.status))
      failed('invalid-diagnosis-recovery', 'Provider returned an unknown recovery state', run.id)
    const result =
      recovered.status === 'complete' ? recovered.result : await provider.diagnose(structuredClone(saved.input), signal)
    validateJsonObject(result)
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
      failed('invalid-diagnosis-result', 'Diagnosis result exceeds the bounded receipt size', run.id)
    validateDiagnosisUsage(result.usage)
    saved.result = structuredClone(result)
    operation.status = 'complete'
    // Settle usage durably before certifying claims. Invalid facts cannot erase costs.
    await store.write(run.id, run)
  }
  if (diagnosisOverBudget(saved.result.usage, saved.input.limits))
    failed(
      'diagnosis-budget-violation',
      'Provider exceeded its frozen request/token limit; reported usage was retained',
      run.id,
    )
  const dossier = certifyDiagnosis(saved.input, saved.result, run.plan.diagnosis!.providerIdentity)
  return {
    ...seedDiagnosis(run, candidate, ids),
    method: 'provider-seed-diagnosis-v1',
    dossier,
    usage: saved.result.usage,
    operation_id: id,
  }
}
