import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalDigest } from '../domain/canonical.js'

/** Real bytes of all new execution-layer modules; never reinterpret an old run. */
export async function projectRuntimeIdentity(): Promise<string> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  const files: Array<[string, string]> = []
  const visit = async (prefix: string): Promise<void> => {
    for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const name = `${prefix}/${entry.name}`
      if (entry.isDirectory()) await visit(name)
      else if (entry.isFile() && name.endsWith(suffix)) files.push([name, await readFile(join(root, name), 'utf8')])
    }
  }
  for (const layer of ['application', 'adapters', 'runtime', 'domain', 'ports']) await visit(layer)
  return canonicalDigest({ version: 1, files })
}
