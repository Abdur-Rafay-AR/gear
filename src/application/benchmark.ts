import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { load } from 'js-yaml'
import type { BenchmarkSpec, BenchmarkTask, Scorer } from '../domain/benchmark.js'
import { invalid } from '../domain/errors.js'
import { freezeTaskInputs } from './benchmark-inputs.js'
import { scoreOutput } from './scoring.js'

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

function task(row: Record<string, unknown>, template: string, where: string): BenchmarkTask {
  keys(
    row,
    ['id', 'instruction', 'expected', 'family', 'split', 'path', 'normalization', 'positive', 'negative', 'inputs'],
    where,
  )
  const id = string(row.id, `${where}.id`)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id)) invalid('Task ID must be a safe stable name', `${where}.id`)
  const instruction = string(row.instruction, `${where}.instruction`)
  const family = string(row.family, `${where}.family`)
  if (!['seed', 'held_out'].includes(String(row.split)))
    invalid('Set split to seed or held_out explicitly', `${where}.split`)
  if (typeof row.expected !== 'string') invalid('expected must be text (encode JSON as a string)', `${where}.expected`)
  const expected = row.expected
  const normalization = row.normalization || 'trim'
  if (normalization !== 'exact' && normalization !== 'trim') invalid('normalization must be exact or trim', where)
  let scorer: Scorer
  if (template === 'json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(expected)
    } catch {
      invalid('expected must be valid JSON', `${where}.expected`)
    }
    scorer = { kind: 'json', expected: record(parsed, `${where}.expected`) }
    if (!Object.keys(scorer.expected).length) invalid('JSON scorer needs at least one field assertion', where)
  } else if (template === 'file') {
    const path = string(row.path, `${where}.path`)
    if (
      !/^\/app\/[a-zA-Z0-9_./-]+$/u.test(path) ||
      path
        .split('/')
        .slice(1)
        .some((p) => !p || p === '.' || p === '..')
    )
      invalid('File output must be a normalized path under /app/', where)
    scorer = { kind: 'file', path, expected, normalization }
  } else scorer = { kind: 'text', expected, normalization }
  const fixtures = {
    positive: typeof row.positive === 'string' ? row.positive : expected,
    negative: typeof row.negative === 'string' ? row.negative : template === 'json' ? '{}' : `${expected}__incorrect__`,
  }
  if (scoreOutput(scorer, fixtures.positive).value !== 1 || scoreOutput(scorer, fixtures.negative).value !== 0)
    invalid('Scorer must pass its positive fixture and reject its negative fixture', `${where}.fixtures`)
  return { id, instruction, family, split: row.split as BenchmarkTask['split'], scorer, fixtures }
}

export async function loadBenchmark(path: string, mode: 'holdout' | 'research'): Promise<BenchmarkSpec> {
  const configText = await readFile(path, 'utf8')
  const config = record(load(configText), path)
  keys(config, ['version', 'source', 'template'], path)
  if (config.version !== 1) invalid('Unsupported benchmark version', path)
  const template = string(config.template, `${path}.template`)
  if (!['text', 'json', 'file'].includes(template)) invalid('Supported templates: text, json, file', path)
  const sourcePath = resolve(dirname(path), string(config.source, `${path}.source`))
  const source = await readFile(sourcePath, 'utf8')
  const rows = sourcePath.endsWith('.jsonl')
    ? source.split(/\r?\n/u).flatMap((line, i) => {
        if (!line.trim()) return []
        try {
          return [{ line: i + 1, values: record(JSON.parse(line), `${sourcePath}:${i + 1}`) }]
        } catch {
          return invalid('Invalid JSONL row', `${sourcePath}:${i + 1}`)
        }
      })
    : parseCSV(source, sourcePath)
  const tasks = await Promise.all(
    rows.map(async (row) => {
      const parsed = task(row.values, template, `${sourcePath}:${row.line}`)
      const inputs = await freezeTaskInputs(row.values.inputs, dirname(sourcePath), `${sourcePath}:${row.line}.inputs`)
      return inputs.length ? { ...parsed, inputs } : parsed
    }),
  )
  if (!tasks.length) invalid('Benchmark is empty', sourcePath)
  const ids = new Set<string>(),
    families = new Map<string, string>()
  for (const item of tasks) {
    if (ids.has(item.id)) invalid(`Duplicate task ID ${item.id}`, sourcePath)
    ids.add(item.id)
    if (families.has(item.family) && families.get(item.family) !== item.split)
      invalid(`Family ${item.family} crosses seed and held_out`, sourcePath)
    families.set(item.family, item.split)
  }
  if (!tasks.some((t) => t.split === 'seed')) invalid('Benchmark needs seed tasks', sourcePath)
  if (mode === 'holdout' && !tasks.some((t) => t.split === 'held_out'))
    invalid(
      'Holdout mode requires independent held_out tasks; use validation.mode: research for shared-set research',
      sourcePath,
    )
  const spec = {
    version: 1 as const,
    sourceDigest: contentDigest(`${configText}\0${source}`),
    tasks,
    metric: {
      name: 'pass_rate' as const,
      direction: 'maximize' as const,
      range: [0, 1] as [0, 1],
      missing: 'invalid' as const,
    },
  }
  return { ...spec, digest: contentDigest(JSON.stringify(spec)) }
}
