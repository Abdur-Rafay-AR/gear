import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { readHarborTask } from '../adapters/hitch/harbor-files.js'
import type { BenchmarkSpec, BenchmarkTask } from '../domain/benchmark.js'
import { invalid } from '../domain/errors.js'
import { contentDigest, keys, parseCSV, record, string, validateBenchmarkTasks } from './benchmark-source.js'

/** An explicit manifest owns task IDs, families and splits; original Harbor resources stay byte-exact. */
export async function loadHarborBenchmark(
  configText: string,
  config: Record<string, unknown>,
  path: string,
  mode: 'holdout' | 'research',
): Promise<BenchmarkSpec> {
  keys(config, ['version', 'template', 'source', 'manifest'], path)
  if (config.version !== 1) invalid('Unsupported benchmark version', path)
  const root = await realpath(resolve(dirname(path), string(config.source, `${path}.source`)))
  const manifest = resolve(dirname(path), string(config.manifest, `${path}.manifest`))
  const source = await readFile(manifest, 'utf8')
  const rows = manifest.endsWith('.jsonl')
    ? source.split(/\r?\n/u).flatMap((line, index) => {
        if (!line.trim()) return []
        try {
          return [{ line: index + 1, values: record(JSON.parse(line), `${manifest}:${index + 1}`) }]
        } catch {
          return invalid('Invalid Harbor manifest JSONL', `${manifest}:${index + 1}`)
        }
      })
    : parseCSV(source, manifest)
  const tasks: BenchmarkTask[] = []
  const ids = new Set<string>()
  let bytes = 0
  for (const row of rows) {
    const at = `${manifest}:${row.line}`,
      value = row.values
    keys(value, ['id', 'path', 'family', 'split', 'metric'], at)
    const id = string(value.id, `${at}.id`),
      family = string(value.family, `${at}.family`)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id)) invalid('Task ID must be a safe stable name', at)
    if (ids.has(id.toLowerCase())) invalid('Harbor task IDs must be unique ignoring case', at)
    ids.add(id.toLowerCase())
    if (value.split !== 'seed' && value.split !== 'held_out') invalid('Set split to seed or held_out explicitly', at)
    const relative = value.path === undefined || value.path === '' ? id : string(value.path, `${at}.path`)
    if (
      typeof relative !== 'string' ||
      relative.includes('\\') ||
      relative.includes(':') ||
      relative.split('/').some((p) => !p || p === '.' || p === '..')
    )
      invalid('Task path must stay inside the Harbor source', at)
    let selected = root
    for (const part of relative.split('/')) {
      selected = resolve(selected, part)
      if ((await lstat(selected)).isSymbolicLink()) invalid('Harbor task selection cannot follow symbolic links', at)
    }
    const { task, instruction } = await readHarborTask(selected)
    bytes += task.files.reduce((sum, f) => sum + Buffer.byteLength(f.base64, 'base64'), 0)
    if (bytes > 128 * 1024 * 1024) invalid('Harbor benchmark resources exceed 128 MiB', at)
    tasks.push({
      id,
      family,
      split: value.split,
      instruction,
      harbor: task,
      scorer: {
        kind: 'harbor',
        taskDigest: task.digest,
        metric: value.metric === undefined || value.metric === '' ? 'reward' : string(value.metric, `${at}.metric`),
      },
    })
  }
  validateBenchmarkTasks(tasks, mode, manifest)
  const spec = {
    version: 1 as const,
    sourceDigest: contentDigest(`${configText}\0${source}`),
    tasks,
    metric: {
      name: 'reward' as const,
      direction: 'maximize' as const,
      range: [0, 1] as [0, 1],
      missing: 'invalid' as const,
    },
  }
  return { ...spec, digest: contentDigest(JSON.stringify(spec)) }
}
