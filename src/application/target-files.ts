import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { canonicalDigest } from '../domain/canonical.js'
import { MutationValidationError } from '../domain/harness.js'
import { validateArtifactPath } from '../domain/mutation-policy.js'
import type { HarnessAdapter } from '../ports/harness.js'

export async function targetFiles(root: string, adapter: HarnessAdapter): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const visit = async (prefix: string): Promise<void> => {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      validateArtifactPath(path, adapter.mutationPolicy)
      if (entry.isSymbolicLink()) throw new Error('Target symlinks are forbidden')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile())
        files[path] = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(root, path)))
      else throw new Error('Target contains a special file')
    }
  }
  await visit('')
  await validateTargetFiles(files, adapter)
  return files
}
export async function validateTargetFiles(files: Record<string, string>, adapter: HarnessAdapter): Promise<void> {
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 256)
    throw new MutationValidationError('Invalid Target files')
  try {
    canonicalDigest(files)
  } catch {
    throw new MutationValidationError('Target files must contain valid JSON text')
  }
  let bytes = 0
  const root = await mkdtemp(join(tmpdir(), 'gear-target-check-'))
  try {
    for (const [path, text] of Object.entries(files)) {
      validateArtifactPath(path, adapter.mutationPolicy)
      if (typeof text !== 'string' || text.includes('\0'))
        throw new MutationValidationError('Target files must be text')
      bytes += Buffer.byteLength(text)
      if (bytes > 1024 * 1024) throw new MutationValidationError('Target exceeds 1 MiB')
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text, { flag: 'wx' })
    }
    try {
      await adapter.check(root)
    } catch (error) {
      if (error instanceof SyntaxError || (error as { name?: string }).name === 'YAMLException')
        throw new MutationValidationError('Target configuration is missing or malformed')
      throw error
    }
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new MutationValidationError('Target files are missing or have conflicting paths')
    throw error
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
