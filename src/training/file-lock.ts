import { withFileLock, FileLockError } from '../adapters/storage/file-lock.js'
import { TrainingContractError } from './schema.js'

/** Compatibility facade for the shared kernel-lock primitive. */
export async function withTrainingFileLock<R>(path: string, fn: () => Promise<R>): Promise<R> {
  try { return await withFileLock(path, fn) }
  catch (error) {
    if (error instanceof FileLockError) throw new TrainingContractError(error.code, error.message)
    throw error
  }
}
