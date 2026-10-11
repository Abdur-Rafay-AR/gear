import { LegacyRoundValidator } from '../compat/round-validation.js'
import { atomicJSON } from '../adapters/storage/atomic.js'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  CandidateAssessment, ChampionState, ComponentKind, ComponentRef, EvaluationEvidence, MetaSessionState,
  PairedTrial, PairingAudit, PopulationMember, PopulationState, RefinementRound, RoundEvaluationAttempt, EvaluationSubmissionIntent,
  SeedExperienceRecord,
} from '../types.js'
import { isExactGitCommit } from '../types.js'
import { digestJson } from './digest.js'
import { validateSeedExperienceRecord } from '../experience/memory.js'

interface LockRecord {
  pid: number
  token: string
  acquiredAt: string
  roundId?: string
}

export interface WorkspaceLock {
  readonly token: string
  assertHeld(stateRoot: string): Promise<void>
  retarget(roundId: string): Promise<void>
  release(): Promise<void>
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class RoundAlreadyRunningError extends Error {
  constructor(readonly owner?: LockRecord) {
    super(owner === undefined
      ? 'a refinement round already owns the workspace lock'
      : `refinement round lock is owned by pid ${owner.pid} since ${owner.acquiredAt}`)
    this.name = 'RoundAlreadyRunningError'
  }
}

export class RefineStateStore {
  private readonly validation: LegacyRoundValidator
  readonly roundsPath: string
  readonly locksPath: string
  readonly workersPath: string
  readonly metaHarnessPath: string
  readonly experienceRecordsPath: string

  constructor(
    readonly root: string,
    readonly evolutionId?: string,
    private readonly onRoundChange?: () => Promise<void>,
  ) {
    this.validation = new LegacyRoundValidator(evolutionId)
    this.roundsPath = join(root, 'rounds')
    this.locksPath = join(root, 'locks')
    this.workersPath = join(root, 'workers')
    this.metaHarnessPath = join(root, 'meta-harness')
    this.experienceRecordsPath = join(root, 'experience', 'records')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.roundsPath, { recursive: true }),
      mkdir(this.locksPath, { recursive: true }),
      mkdir(this.workersPath, { recursive: true }),
      mkdir(this.metaHarnessPath, { recursive: true }),
      mkdir(this.experienceRecordsPath, { recursive: true }),
    ])
  }

  async readChampion(): Promise<ChampionState | undefined> {
    const value = await this.readJson<unknown>(join(this.root, 'champion.json'))
    return value === undefined ? undefined : this.validation.validateChampion(value)
  }

  async writeChampion(value: ChampionState): Promise<void> {
    this.validation.validateChampion(value)
    await this.atomicWrite(join(this.root, 'champion.json'), value)
  }

  async compareAndSwapChampion(expectedRef: string, value: ChampionState): Promise<void> {
    const current = await this.readChampion()
    if (current?.ref !== expectedRef) {
      throw new Error(`champion CAS failed: expected ${expectedRef}, found ${current?.ref ?? '<missing>'}`)
    }
    await this.writeChampion(value)
  }

  async readMeta(): Promise<MetaSessionState | undefined> {
    const value = await this.readJson<unknown>(join(this.root, 'meta.json'))
    return value === undefined ? undefined : this.validation.validateMeta(value)
  }

  async writeMeta(value: MetaSessionState): Promise<void> {
    this.validation.validateMeta(value)
    await this.atomicWrite(join(this.root, 'meta.json'), value)
  }

  async readPopulation(): Promise<PopulationState | undefined> {
    const value = await this.readJson<unknown>(join(this.root, 'population.json'))
    return value === undefined ? undefined : this.validation.validatePopulation(value)
  }

  async writePopulation(value: PopulationState): Promise<void> {
    this.validation.validatePopulation(value)
    await this.atomicWrite(join(this.root, 'population.json'), value)
  }

  async compareAndSwapPopulation(expectedDigest: string, value: PopulationState): Promise<void> {
    const current = await this.readPopulation()
    if (current?.digest !== expectedDigest) {
      throw new Error(`population CAS failed: expected ${expectedDigest}, found ${current?.digest ?? '<missing>'}`)
    }
    await this.writePopulation(value)
  }

  async readRound(roundId: string): Promise<RefinementRound | undefined> {
    const value = await this.readJson<unknown>(this.roundFile(roundId))
    return value === undefined ? undefined : this.validation.validateRound(value)
  }

  async writeRound(value: RefinementRound): Promise<void> {
    this.validation.validateRound(value)
    await this.atomicWrite(this.roundFile(value.roundId), value)
    await this.onRoundChange?.()
  }

  async listRounds(): Promise<RefinementRound[]> {
    await this.initialize()
    const names = (await readdir(this.roundsPath)).filter(name => name.endsWith('.json')).sort()
    const rounds = await Promise.all(names.map(name => this.readJson<unknown>(join(this.roundsPath, name))))
    return rounds.filter((round): round is unknown => round !== undefined).map(round => this.validation.validateRound(round))
  }

  async readExperienceRecord(recordDigest: string): Promise<SeedExperienceRecord | undefined> {
    const value = await this.readJson<SeedExperienceRecord>(this.experienceRecordFile(recordDigest))
    if (value === undefined) return undefined
    const record = validateSeedExperienceRecord(value)
    if (record.recordDigest !== recordDigest) throw new TypeError('seed experience record filename/digest mismatch')
    return record
  }

  async writeExperienceRecord(value: SeedExperienceRecord): Promise<void> {
    const record = validateSeedExperienceRecord(value)
    const path = this.experienceRecordFile(record.recordDigest)
    const existing = await this.readJson<SeedExperienceRecord>(path)
    if (existing !== undefined) {
      const validated = validateSeedExperienceRecord(existing)
      if (digestJson(validated) !== digestJson(record)) {
        throw new Error(`immutable seed experience record collision: ${record.recordDigest}`)
      }
      return
    }
    await this.atomicWrite(path, record)
  }

  async writeWorkerRecord(workerId: string, value: unknown): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/u.test(workerId)) throw new TypeError('invalid worker id')
    await this.atomicWrite(join(this.workersPath, `${workerId}.json`), value)
  }

  async acquireRoundLock(roundId?: string): Promise<WorkspaceLock> {
    await this.initialize()
    const lockPath = join(this.locksPath, 'round.lock')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = crypto.randomUUID()
      const record: LockRecord = {
        pid: process.pid, token, acquiredAt: new Date().toISOString(),
        ...(roundId === undefined ? {} : { roundId }),
      }
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(json(record), 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        let released = false
        return {
          token,
          assertHeld: async (stateRoot: string): Promise<void> => {
            if (released || resolve(stateRoot) !== resolve(this.root)) throw new Error('workspace lock is released or belongs to another evolution')
            const current = await this.readJson<LockRecord>(lockPath)
            if (current?.token !== token || current.pid !== process.pid) throw new Error('workspace lock ownership changed')
          },
          retarget: async (roundId: string): Promise<void> => {
            if (released) throw new Error('cannot retarget a released workspace lock')
            const current = await this.readJson<LockRecord>(lockPath)
            if (current?.token !== token) throw new Error('refusing to retarget a workspace lock owned by another process')
            await this.atomicWrite(lockPath, { ...current, roundId })
          },
          async release(): Promise<void> {
            if (released) return
            released = true
            let current: LockRecord | undefined
            try {
              current = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
              throw error
            }
            if (current.token !== token) throw new Error('refusing to release a workspace lock owned by another process')
            await unlink(lockPath)
          },
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const owner = await this.readJson<LockRecord>(lockPath)
        if (attempt === 0 && owner !== undefined && !isAlive(owner.pid)) {
          // Serialize stale-owner recovery. A crashed recovery guard requires
          // explicit inspection; it may retain a lock, never delete a new one.
          const guardPath = `${lockPath}.recovery`
          let guard
          try { guard = await open(guardPath, 'wx', 0o600) }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RoundAlreadyRunningError(owner); throw error }
          try {
            const current = await this.readJson<LockRecord>(lockPath)
            if (current?.token === owner.token && current.pid === owner.pid && !isAlive(current.pid)) await unlink(lockPath)
          } finally { await guard.close(); await unlink(guardPath) }
          continue
        }
        throw new RoundAlreadyRunningError(owner)
      }
    }
    throw new RoundAlreadyRunningError()
  }

  async resetForTests(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }

  private roundFile(roundId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(roundId)) throw new TypeError('invalid round id')
    return join(this.roundsPath, `${roundId}.json`)
  }

  private experienceRecordFile(recordDigest: string): string {
    if (!/^sha256:[0-9a-f]{64}$/u.test(recordDigest)) throw new TypeError('invalid seed experience record digest')
    return join(this.experienceRecordsPath, `${recordDigest.slice('sha256:'.length)}.json`)
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    await atomicJSON(path, value)
  }
}

export { exists as pathExists }
