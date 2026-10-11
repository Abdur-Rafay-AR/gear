import { createHash } from 'node:crypto'
import type { BenchmarkTask } from '../domain/benchmark.js'
import { invalid } from '../domain/errors.js'

export const contentDigest = (bytes: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object', where)
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unknown field ${key}`, `${where}.${key}`)
}
export function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid('Expected non-empty text', where)
  return value
}

/** RFC 4180 quoting, embedded newlines, BOM and CRLF; no silent row truncation. */
export function parseCSV(text: string, location: string): Array<{ line: number; values: Record<string, string> }> {
  const rows: Array<{ line: number; fields: string[] }> = []
  let field = '',
    fields: string[] = [],
    quoted = false,
    closed = false,
    line = 1,
    start = 1
  text = text.replace(/^\uFEFF/u, '')
  const push = () => {
    fields.push(field)
    field = ''
    closed = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
        closed = true
      } else {
        field += ch
        if (ch === '\n') line++
      }
    } else if (ch === '"') {
      if (field || closed) invalid('Unexpected quote in CSV', `${location}:${line}`)
      quoted = true
    } else if (ch === ',') push()
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      push()
      rows.push({ line: start, fields })
      fields = []
      line++
      start = line
    } else {
      if (closed) invalid('Unexpected text after closing quote', `${location}:${line}`)
      field += ch
    }
  }
  if (quoted) invalid('Unterminated CSV quote', `${location}:${start}`)
  if (field || fields.length || closed) {
    push()
    rows.push({ line: start, fields })
  }
  const header = rows.shift()?.fields ?? []
  if (!header.length || new Set(header).size !== header.length) invalid('CSV needs unique column names', location)
  return rows
    .filter((row) => row.fields.length !== 1 || row.fields[0] !== '')
    .map((row) => {
      if (row.fields.length !== header.length)
        invalid('CSV column count differs from header', `${location}:${row.line}`)
      return { line: row.line, values: Object.fromEntries(header.map((key, index) => [key, row.fields[index]!])) }
    })
}

export function validateBenchmarkTasks(tasks: BenchmarkTask[], mode: 'holdout' | 'research', location: string): void {
  if (!tasks.length) invalid('Benchmark is empty', location)
  const ids = new Set<string>(),
    families = new Map<string, string>()
  for (const item of tasks) {
    if (ids.has(item.id)) invalid(`Duplicate task ID ${item.id}`, location)
    ids.add(item.id)
    if (families.has(item.family) && families.get(item.family) !== item.split)
      invalid(`Family ${item.family} crosses seed and held_out`, location)
    families.set(item.family, item.split)
  }
  if (!tasks.some((t) => t.split === 'seed')) invalid('Benchmark needs seed tasks', location)
  if (mode === 'holdout' && !tasks.some((t) => t.split === 'held_out'))
    invalid(
      'Holdout mode requires independent held_out tasks; use validation.mode: research for shared-set research',
      location,
    )
}
