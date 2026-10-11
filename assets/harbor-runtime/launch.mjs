import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Replace this process: Hitch cancellation must retain ownership of Harbor itself. */
export async function launch(runtime) {
  if (!process.execve) throw new Error('Guarded Harbor requires a POSIX Node runtime with execve')
  for (const [name, digest] of Object.entries(runtime.assets)) {
    const path = new URL(name, import.meta.url)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error('guarded-harbor-asset-type-mismatch')
    if (
      `sha256:${createHash('sha256')
        .update(await readFile(path))
        .digest('hex')}` !== digest
    )
      throw new Error('guarded-harbor-asset-digest-mismatch')
  }
  process.execve(
    runtime.python,
    [
      runtime.python,
      '-P',
      fileURLToPath(new URL('harbor_cli.py', import.meta.url)),
      '--gear-runtime',
      JSON.stringify(runtime.installation),
      '--',
      ...process.argv.slice(2),
    ],
    { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  )
}
