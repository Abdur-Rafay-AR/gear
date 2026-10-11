import type { CandidateFinalization, SemanticTarget } from '../types.js'

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('capability params must be an object')
  return value as Record<string, unknown>
}

export function assertOnlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key))
  if (extra.length > 0) throw new TypeError(`invalid arguments: unknown field(s): ${extra.join(', ')}`)
}

export function string(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${key} must be a non-empty string`)
  return value
}

export function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${key} must be a non-negative integer`)
  return value as number
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${key} must be a non-empty string`)
  return value
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  return value
}

export function optionalStrings(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${key} must be an array of non-empty strings`)
  }
  return value as string[]
}

export function finalization(args: Record<string, unknown>): CandidateFinalization {
  const rationale = string(args, 'rationale')
  const expectedOutcome = string(args, 'expectedOutcome')
  const evidenceRefs = optionalStrings(args, 'evidenceRefs')
  if (evidenceRefs === undefined || evidenceRefs.length === 0)
    throw new TypeError('evidenceRefs must contain current baseline evidence')
  const semanticTargets = optionalStrings(args, 'semanticTargets')
  const allowed = new Set<SemanticTarget>([
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
  if (semanticTargets?.some((value) => !allowed.has(value as SemanticTarget)))
    throw new TypeError('semanticTargets contains an unknown target')
  return {
    rationale,
    expectedOutcome,
    evidenceRefs: [...new Set(evidenceRefs)],
    ...(semanticTargets === undefined ? {} : { semanticTargets: [...new Set(semanticTargets)] as SemanticTarget[] }),
  }
}
