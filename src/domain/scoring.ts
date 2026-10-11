import type { Score, Scorer } from './benchmark.js'

function equal(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return expected === actual
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => equal(item, actual[index]))
    )
  return (
    actual !== null &&
    typeof actual === 'object' &&
    !Array.isArray(actual) &&
    Object.entries(expected).every(
      ([key, value]) => Object.hasOwn(actual, key) && equal(value, (actual as Record<string, unknown>)[key]),
    )
  )
}
/** Malformed task output is a valid failure; a missing execution result is invalid. */
export function scoreOutput(scorer: Scorer, output: string | undefined): Score {
  if (output === undefined) return { valid: false, reason: 'missing-output' }
  if (scorer.kind === 'json') {
    try {
      return { valid: true, value: Number(equal(scorer.expected, JSON.parse(output))) }
    } catch {
      return { valid: true, value: 0, reason: 'invalid-json-output' }
    }
  }
  const normalize = (text: string) => (scorer.normalization === 'trim' ? text.trim() : text)
  return { valid: true, value: Number(normalize(scorer.expected) === normalize(output)) }
}
