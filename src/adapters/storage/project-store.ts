import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunStore } from '../../ports/run-store.js'
import { atomicJSON } from './atomic.js'
import { withFileLock } from './file-lock.js'

/** One atomic record commits decision, state, reservations and operation IDs. */
export class ProjectRunStore implements RunStore {
  constructor(readonly root: string) {}
  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new TypeError('invalid-run-id')
    return join(this.root, 'runs', id)
  }
  async read<T>(id: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(this.path(id), 'state.json'), 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  write(id: string, state: unknown): Promise<void> {
    return atomicJSON(join(this.path(id), 'state.json'), state)
  }
  locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.path(id), 'owner.lock'), operation)
  }
  async cancelRequested(id: string): Promise<boolean> {
    try {
      await access(join(this.path(id), 'cancel.json'))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  requestCancel(id: string): Promise<void> {
    return atomicJSON(join(this.path(id), 'cancel.json'), { requested: true })
  }
}
