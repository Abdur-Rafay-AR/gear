import { chmod, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { invalid } from '../../domain/errors.js'
import {
  type HarborFile,
  type HarborTask,
  harborFileDigest,
  harborTaskDigest,
  validateHarborTask,
} from '../../domain/harbor.js'

/** Snapshot the complete task. No task code, Docker build or verifier is executed here. */
export async function readHarborTask(directory: string): Promise<{ task: HarborTask; instruction: string }> {
  if ((await lstat(directory)).isSymbolicLink()) invalid('Harbor task directories cannot be symbolic links', directory)
  const root = await realpath(directory),
    files: HarborFile[] = [],
    directories: HarborTask['directories'] = []
  let total = 0
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(join(root, path))).sort()) {
      if (name.toLowerCase() === '.git') invalid('Import a task snapshot without Git internals', directory)
      const relative = path ? `${path}/${name}` : name
      const absolute = join(root, relative),
        info = await lstat(absolute)
      if (info.isSymbolicLink()) invalid('Harbor resources cannot contain symbolic links', absolute)
      if (info.isDirectory()) {
        if (directories.length >= 4096) invalid('Too many Harbor resource directories', directory)
        directories.push({ path: relative, mode: info.mode & 0o777 })
        await visit(relative)
        continue
      }
      if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024)
        invalid('Harbor resources must be regular files of at most 8 MiB', absolute)
      const bytes = await readFile(absolute)
      total += bytes.length
      if (total > 32 * 1024 * 1024 || files.length >= 4096) invalid('Harbor task exceeds import limits', directory)
      files.push({
        path: relative,
        base64: bytes.toString('base64'),
        digest: harborFileDigest(bytes),
        mode: info.mode & 0o777,
      })
    }
  }
  await visit('')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  directories.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const task: HarborTask = { version: 1, files, directories, digest: harborTaskDigest(files, directories) }
  validateHarborTask(task)
  const text = (path: string) => {
    const file = files.find((f) => f.path === path)
    if (!file) invalid(`Harbor task requires ${path}`, directory)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.base64, 'base64'))
    } catch {
      return invalid('Harbor metadata must be valid UTF-8', join(directory, path))
    }
  }
  let config: Record<string, unknown>
  try {
    config = parse(text('task.toml'))
  } catch {
    return invalid('Invalid Harbor task.toml', directory)
  }
  if (config.version !== '1.0') invalid('Expected Harbor task version 1.0', directory)
  const instruction = text('instruction.md')
  if (!instruction.trim()) invalid('Harbor instruction is empty', directory)
  if (!files.some((f) => f.path === 'tests/test.sh')) invalid('Harbor task requires tests/test.sh', directory)
  const environment = config.environment as { docker_image?: unknown } | undefined
  if (
    !files.some((f) =>
      ['environment/Dockerfile', 'environment/docker-compose.yaml', 'environment/docker-compose.yml'].includes(f.path),
    ) &&
    !(typeof environment?.docker_image === 'string' && environment.docker_image.trim())
  )
    invalid('Harbor task needs an environment build, Compose file or docker_image', directory)
  return { task, instruction }
}

/** Idempotent materialization never follows destination symlinks or overwrites conflicting files. */
export async function writeHarborTask(task: HarborTask, destination: string): Promise<void> {
  validateHarborTask(task)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  if ((await lstat(destination)).isSymbolicLink()) throw new TypeError('unsafe-harbor-destination')
  if ((await readdir(destination)).length) {
    if ((await readHarborTask(destination)).task.digest !== task.digest)
      throw new TypeError('harbor-destination-conflict')
    return
  }
  for (const entry of task.directories) {
    const path = join(destination, entry.path)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('unsafe-harbor-destination')
  }
  for (const file of task.files) {
    let directory = destination
    for (const part of file.path.split('/').slice(0, -1)) {
      directory = join(directory, part)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('unsafe-harbor-destination')
    }
    const path = join(destination, file.path),
      bytes = Buffer.from(file.base64, 'base64')
    try {
      await writeFile(path, bytes, { flag: 'wx', mode: file.mode })
      await chmod(path, file.mode)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await lstat(path)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== file.mode ||
        !(await readFile(path)).equals(bytes)
      )
        throw new TypeError('harbor-destination-conflict')
    }
  }
  for (const directory of [...task.directories].reverse())
    await chmod(join(destination, directory.path), directory.mode)
}
