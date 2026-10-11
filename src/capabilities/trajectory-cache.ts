import { projectTrajectory } from '../evaluator/trajectory-projection.js'
import type { HitchTrajectoryReader, TrajectoryProjection } from '../types.js'

interface SharedProjectionLoad {
  promise: Promise<TrajectoryProjection>
  controller: AbortController
  waiters: number
  settled: boolean
  bytes: number
}

/** Shared loads keep per-waiter cancellation and bounded LRU ownership. */
export class TrajectoryProjectionCache {
  private readonly trajectoryProjections = new Map<string, SharedProjectionLoad>()
  private trajectoryProjectionCacheBytes = 0
  constructor(
    private readonly load: HitchTrajectoryReader['inspectTrajectoryAnalysis'],
    private readonly maxEntries = 8,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  invalidate(runId: string): void {
    this.deleteTrajectoryProjection(runId)
  }

  async get(runId: string, signal: AbortSignal): Promise<TrajectoryProjection> {
    const cached = this.trajectoryProjections.get(runId)
    if (cached !== undefined) {
      this.trajectoryProjections.delete(runId)
      this.trajectoryProjections.set(runId, cached)
      return this.waitForProjection(runId, cached, signal)
    }
    const controller = new AbortController()
    const shared: SharedProjectionLoad = {
      promise: this.load(runId, controller.signal).then(projectTrajectory),
      controller,
      waiters: 0,
      settled: false,
      bytes: 0,
    }
    this.trajectoryProjections.set(runId, shared)
    void shared.promise.then(
      (projection) => {
        shared.settled = true
        if (this.trajectoryProjections.get(runId) === shared) {
          shared.bytes = Buffer.byteLength(JSON.stringify(projection))
          this.trajectoryProjectionCacheBytes += shared.bytes
          this.trimTrajectoryProjectionCache()
        }
      },
      () => {
        shared.settled = true
        this.deleteTrajectoryProjection(runId, shared)
      },
    )
    this.trimTrajectoryProjectionCache()
    return this.waitForProjection(runId, shared, signal)
  }

  private trimTrajectoryProjectionCache(): void {
    const maxEntries = this.maxEntries
    const maxBytes = this.maxBytes
    while (this.trajectoryProjections.size > maxEntries || this.trajectoryProjectionCacheBytes > maxBytes) {
      const oldest = this.trajectoryProjections.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.deleteTrajectoryProjection(oldest)
    }
  }

  private deleteTrajectoryProjection(runId: string, expected?: SharedProjectionLoad): void {
    const existing = this.trajectoryProjections.get(runId)
    if (existing === undefined || (expected !== undefined && existing !== expected)) return
    this.trajectoryProjections.delete(runId)
    this.trajectoryProjectionCacheBytes = Math.max(0, this.trajectoryProjectionCacheBytes - existing.bytes)
  }

  private waitForProjection(
    runId: string,
    shared: SharedProjectionLoad,
    signal: AbortSignal,
  ): Promise<TrajectoryProjection> {
    signal.throwIfAborted()
    shared.waiters += 1
    return new Promise((resolvePromise, reject) => {
      let completed = false
      const release = (): void => {
        if (completed) return
        completed = true
        signal.removeEventListener('abort', abort)
        shared.waiters -= 1
        if (shared.waiters === 0 && !shared.settled) {
          shared.controller.abort(new Error(`trajectory projection abandoned for ${runId}`))
        }
      }
      const abort = (): void => {
        release()
        reject(signal.reason ?? new Error('trajectory projection aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
      void shared.promise.then(
        (value) => {
          release()
          resolvePromise(value)
        },
        (error) => {
          release()
          reject(error)
        },
      )
    })
  }
}
