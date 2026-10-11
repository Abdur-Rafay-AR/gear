import { createHash } from 'node:crypto'
import type { EvaluationTrialSlot } from '../../types.js'
import { HitchEvaluationError, type JsonRecord } from './contracts.js'

export function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HitchEvaluationError(`${label} must be an object`, 'invalid_hitch_result')
  }
  return value as JsonRecord
}

export function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HitchEvaluationError(`${label} must be a non-empty string`, 'invalid_hitch_result')
  }
  return value
}

export function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HitchEvaluationError(`${label} must be a finite number`, 'invalid_hitch_result')
  }
  return value
}

export function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HitchEvaluationError(`${label} must be a non-negative integer`, 'invalid_hitch_result')
  }
  return value as number
}

export function optionalFinite(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finite(value, label)
}

export function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

export function jsonValue(value: unknown, label: string): import('@deepseek-ai/dsh-session').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, `${label}.${key}`)]))
  }
  throw new HitchEvaluationError(`${label} must be JSON`, 'invalid_hitch_result')
}

export function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new HitchEvaluationError(`${label} must be an array of non-empty strings`, 'invalid_hitch_result')
  }
  return [...(value as string[])]
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HitchEvaluationError(`${label} must be boolean`, 'invalid_hitch_result')
  }
  return value
}

export function digest(value: unknown, label: string): string {
  const result = string(value, label)
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) {
    throw new HitchEvaluationError(`${label} must be a sha256 digest`, 'invalid_hitch_result')
  }
  return result
}

export function counts(value: unknown, label: string): Record<string, number> {
  const source = record(value, label)
  const result: Record<string, number> = {}
  for (const [key, count] of Object.entries(source).sort(([left], [right]) => left.localeCompare(right))) {
    if (key.length === 0 || key.length > 1_024) {
      throw new HitchEvaluationError(`${label} contains an invalid key`, 'invalid_hitch_result')
    }
    result[key] = integer(count, `${label}.${key}`)
  }
  return result
}

export function redactions(value: unknown, label: string): Array<{ ruleId: string; count: number }> {
  if (!Array.isArray(value)) throw new HitchEvaluationError(`${label} must be an array`, 'invalid_hitch_result')
  const result = value.map((item, index) => {
    const entry = record(item, `${label}[${index}]`)
    exactFields(entry, ['rule_id', 'count'], `${label}[${index}]`)
    const ruleId = string(entry.rule_id, `${label}[${index}].rule_id`)
    const count = integer(entry.count, `${label}[${index}].count`)
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(ruleId) || count < 1) {
      throw new HitchEvaluationError(`${label}[${index}] is invalid`, 'invalid_hitch_result')
    }
    return { ruleId, count }
  })
  if (
    new Set(result.map((item) => item.ruleId)).size !== result.length ||
    result.some((item, index) => index > 0 && result[index - 1]!.ruleId.localeCompare(item.ruleId) >= 0)
  ) {
    throw new HitchEvaluationError(`${label} must be unique and sorted`, 'invalid_hitch_result')
  }
  return result
}

export function trialSlots(value: unknown, label: string): EvaluationTrialSlot[] {
  if (!Array.isArray(value)) throw new HitchEvaluationError(`${label} must be an array`, 'invalid_hitch_result')
  return value.map((item, index) => {
    const slot = record(item, `${label}[${index}]`)
    const attempt = integer(slot.attempt, `${label}[${index}].attempt`)
    if (attempt <= 0)
      throw new HitchEvaluationError(`${label}[${index}].attempt must be positive`, 'invalid_hitch_result')
    return { taskId: string(slot.task_id, `${label}[${index}].task_id`), attempt }
  })
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function memorySizeBytes(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)$/iu)
  if (match === null) return undefined
  const amount = Number(match[1])
  const unit = (match[2] as string).toLowerCase()
  const multiplier = unit === 'gib' ? 1024 ** 3 : unit === 'mib' ? 1024 ** 2 : unit === 'kib' ? 1024 : 1
  const bytes = amount * multiplier
  return Number.isSafeInteger(bytes) && bytes >= 1024 ** 2 && bytes % 1024 ** 2 === 0 ? bytes : undefined
}

export function validMemorySize(value: string): boolean {
  return memorySizeBytes(value) !== undefined
}

export function rewardForTrial(rewards: Record<string, number>): number | undefined {
  if (rewards.reward !== undefined) return rewards.reward
  return Object.values(rewards)[0]
}

export function excerpt(value: unknown, maxBytes = 1200): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  return text.length <= maxBytes ? text : `${text.slice(0, maxBytes)}…`
}

export function structuredCliError(output: string): { code: string; message: string } | undefined {
  for (const line of output.split(/\r?\n/u).reverse()) {
    try {
      const envelope = JSON.parse(line) as unknown
      if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) continue
      const error = (envelope as JsonRecord).error
      if (typeof error !== 'object' || error === null || Array.isArray(error)) continue
      const detail = error as JsonRecord
      if (
        typeof detail.code !== 'string' ||
        !/^[a-z0-9_]{1,128}$/u.test(detail.code) ||
        typeof detail.message !== 'string'
      )
        continue
      return { code: detail.code, message: detail.message }
    } catch {
      // Older Hitch versions use plain-text diagnostics.
    }
  }
  return undefined
}

export function exactFields(value: JsonRecord, allowed: readonly string[], label: string): void {
  const allowedFields = new Set(allowed)
  const unexpected = Object.keys(value).find((field) => !allowedFields.has(field))
  if (unexpected !== undefined) {
    throw new HitchEvaluationError(`${label} has unknown field: ${unexpected}`, 'invalid_hitch_result')
  }
}
