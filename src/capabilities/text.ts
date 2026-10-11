import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { MetaEvidenceText } from '../types.js'

export function publicJson(value: unknown): JsonValue {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (/heldOut|held_out|partitionRef/iu.test(key) ? undefined : item)),
  ) as JsonValue
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function readableMessage(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return ''
  if (typeof value === 'string') {
    try {
      return readableMessage(JSON.parse(value), depth + 1)
    } catch {
      return value
    }
  }
  if (Array.isArray(value))
    return value
      .map((item) => readableMessage(item, depth + 1))
      .filter(Boolean)
      .join('\n')
  const item = objectValue(value)
  if (item === undefined) return String(value)
  if (item.type === 'tool-call') return ''
  if (typeof item.text === 'string') return item.text
  if (Array.isArray(item.content)) return readableMessage(item.content, depth + 1)
  return JSON.stringify(value, null, 2)
}

export function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const suffix = '…'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix))
  const prefix = Buffer.from(value)
    .subarray(0, budget)
    .toString('utf8')
    .replace(/\uFFFD+$/u, '')
  return `${prefix}${suffix}`
}

export function splitUtf8Tail(value: string, maxBytes: number): { earlier: string; tail: string } {
  let start = value.length
  let bytes = 0
  const values = Array.from(value)
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const character = values[index]!
    const nextBytes = Buffer.byteLength(character)
    if (bytes + nextBytes > maxBytes) break
    start -= character.length
    bytes += nextBytes
  }
  return { earlier: value.slice(0, start), tail: value.slice(start) }
}

export function characters(value: string): string[] {
  return Array.from(value)
}

export function characterLength(value: string): number {
  return characters(value).length
}

export function boundedCharacters(value: string, maxCharacters: number): string {
  const values = characters(value)
  if (values.length <= maxCharacters) return value
  if (maxCharacters <= 1) return '…'.slice(0, maxCharacters)
  return `${values.slice(0, maxCharacters - 1).join('')}…`
}

export function renderedMetaEvidence(value: MetaEvidenceText): string {
  return `${value.text}${value.detailRef === undefined ? '' : `\n[more: ${value.detailRef}]`}`
}
