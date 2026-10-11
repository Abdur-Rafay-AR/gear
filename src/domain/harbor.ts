import { createHash } from 'node:crypto'
import type { Score } from './benchmark.js'
import { canonicalDigest } from './canonical.js'

export interface HarborVerification {
  operationId: string
  taskDigest: string
  metrics: Record<string, number>
}
/** Only the isolated verifier channel can supply scores; model output is never parsed as a reward. */
export function harborScore(
  verification: HarborVerification | undefined,
  operationId: string,
  taskDigest: string,
  metric: string,
): Score {
  if (!verification || verification.operationId !== operationId || verification.taskDigest !== taskDigest)
    return { valid: false, reason: 'harbor-verifier-identity-mismatch' }
  if (
    !verification.metrics ||
    typeof verification.metrics !== 'object' ||
    Array.isArray(verification.metrics) ||
    Object.values(verification.metrics).some((v) => typeof v !== 'number' || !Number.isFinite(v))
  )
    return { valid: false, reason: 'invalid-harbor-metrics' }
  const value = verification.metrics[metric]
  return typeof value === 'number' && value >= 0 && value <= 1
    ? { valid: true, value }
    : { valid: false, reason: 'harbor-metric-missing-or-out-of-range' }
}

export interface HarborFile {
  path: string
  base64: string
  digest: string
  mode: number
}
export interface HarborTask {
  version: 1
  digest: string
  files: HarborFile[]
  directories: Array<{ path: string; mode: number }>
}
export const harborFileDigest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export const harborTaskDigest = (files: HarborFile[], directories: HarborTask['directories']) =>
  canonicalDigest({ version: 1, files: files.map(({ path, digest, mode }) => ({ path, digest, mode })), directories })
function safePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    !!path &&
    !path.includes('\\') &&
    !path.includes(':') &&
    [...path].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
    path.split('/').every((p) => !!p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git')
  )
}
export function validateHarborTask(task: HarborTask): void {
  if (task.version !== 1 || !Array.isArray(task.files) || !task.files.length || task.files.length > 4096)
    throw new TypeError('invalid-harbor-snapshot')
  const names = new Set<string>()
  let bytes = 0,
    previous = ''
  for (const file of task.files) {
    if (
      !safePath(file.path) ||
      file.path <= previous ||
      names.has(file.path.toLowerCase()) ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      typeof file.base64 !== 'string'
    )
      throw new TypeError('invalid-harbor-file')
    previous = file.path
    names.add(file.path.toLowerCase())
    const data = Buffer.from(file.base64, 'base64')
    if (data.toString('base64') !== file.base64 || harborFileDigest(data) !== file.digest)
      throw new TypeError('harbor-file-integrity')
    bytes += data.length
    if (data.length > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new TypeError('harbor-snapshot-too-large')
  }
  if (!Array.isArray(task.directories) || task.directories.length > 4096)
    throw new TypeError('invalid-harbor-directories')
  previous = ''
  for (const directory of task.directories) {
    if (
      !safePath(directory.path) ||
      directory.path <= previous ||
      names.has(directory.path.toLowerCase()) ||
      !Number.isSafeInteger(directory.mode) ||
      directory.mode < 0 ||
      directory.mode > 0o777
    )
      throw new TypeError('invalid-harbor-directory')
    previous = directory.path
    names.add(directory.path.toLowerCase())
  }
  const directories = new Set(task.directories.map((d) => d.path))
  for (const path of [...task.files.map((f) => f.path), ...directories])
    if (path.includes('/') && !directories.has(path.slice(0, path.lastIndexOf('/'))))
      throw new TypeError('missing-harbor-directory')
  if (harborTaskDigest(task.files, task.directories) !== task.digest) throw new TypeError('harbor-task-integrity')
}
