import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { piTarget } from '../../src/adapters/pi/target.js'
import { ProjectEvidenceCache } from '../../src/adapters/storage/evidence-cache.js'
import { TargetSnapshots } from '../../src/adapters/storage/target-snapshots.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

const execute = promisify(execFile)
it('seals deterministic native Git snapshots and preserves the manifest and parent relationship', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-snapshot-'))
  try {
    const store = new TargetSnapshots(join(root, 'objects.git'), piTarget, 'fixed-image')
    const files = { 'AGENTS.md': 'initial', 'settings.json': '{}' }
    const initial = { id: 'initial', files, digest: canonicalDigest(files) }
    const first = await store.seal(initial)
    expect((await store.seal(initial)).gitRef).toBe(first.gitRef)
    const next = await store.seal({ ...initial, id: 'next', files: { ...files, 'AGENTS.md': 'changed' } }, first)
    // Frozen from the unmodified 6eb1127 writer before extracting GitSnapshots.
    expect(first.gitRef).toBe('2a0ba335aa1e4167ba3090b959be513e6db2fe59')
    expect(next.gitRef).toBe('3a8a5be585166ac85f792db0a75308e799b5efc8')
    const args = ['--git-dir', store.root]
    expect((await execute('git', [...args, 'rev-parse', `${next.gitRef}^`])).stdout.trim()).toBe(first.gitRef)
    expect(
      JSON.parse((await execute('git', [...args, 'show', `${next.gitRef}:manifest.json`])).stdout).adapterRef,
    ).toBe(piTarget.ref)
    expect((await execute('git', [...args, 'show', `${first.gitRef}:AGENTS.md`])).stdout).toBe('initial')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('keeps the first observed zero as immutable reusable evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-evidence-'))
  try {
    const cache = new ProjectEvidenceCache(root),
      identity = canonicalDigest('slot')
    const trial = {
      identity,
      runId: 'one',
      operationId: 'op-one',
      result: { status: 'completed' as const, output: 'wrong', physicalAttempts: 1 },
    }
    await cache.save(trial)
    await cache.save({ ...trial, runId: 'two', result: { ...trial.result, output: 'correct' } })
    expect(await cache.find(identity)).toEqual(trial)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
