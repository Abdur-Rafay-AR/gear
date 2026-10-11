import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type { TaskInput } from '../domain/benchmark.js'
import { invalid } from '../domain/errors.js'

/** Freeze author-selected input files, without mounting the benchmark directory. */
export async function freezeTaskInputs(value: unknown, root: string, location: string): Promise<TaskInput[]> {
  if (value === undefined || value === '') return []
  let mapping: unknown = value
  if (typeof value === 'string') {
    try {
      mapping = JSON.parse(value)
    } catch {
      mapping = { [basename(value)]: value }
    }
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
    invalid('inputs must be a file path or a JSON path map', location)
  const result: TaskInput[] = []
  const sourceRoot = await realpath(root)
  let total = 0
  for (const [path, source] of Object.entries(mapping)) {
    if (!/^[a-zA-Z0-9_./-]+$/u.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..'))
      invalid('Input destinations must be relative paths under /app/inputs/', location)
    if (typeof source !== 'string' || !source || source.startsWith('/') || source.split(/[\\/]/u).includes('..'))
      invalid('Input sources must be inside the task table directory', location)
    const local = resolve(sourceRoot, source)
    const real = await realpath(local)
    if (relative(sourceRoot, real).startsWith('..')) invalid('Input source escapes its directory', location)
    let current = sourceRoot
    for (const part of relative(sourceRoot, local).split('/')) {
      current = join(current, part)
      if ((await lstat(current)).isSymbolicLink()) invalid('Input sources cannot use symbolic links', location)
    }
    const info = await lstat(local)
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
      invalid('Input must be a regular file of at most 1 MiB', location)
    const bytes = await readFile(local)
    total += bytes.length
    if (total > 4 * 1024 * 1024) invalid('Task inputs exceed 4 MiB', location)
    result.push({
      path: `inputs/${path}`,
      base64: bytes.toString('base64'),
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    })
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
