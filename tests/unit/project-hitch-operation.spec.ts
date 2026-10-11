import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HitchEvaluationClient } from '../../src/adapters/hitch/evaluation-client.js'
import { HitchEvaluationOperations, type HitchOperationBinding } from '../../src/adapters/hitch/evaluation-operation.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { EvaluationReservation, EvaluationSubmissionIntent, HitchEvaluationEvidence } from '../../src/types.js'

type OperationClient = ReturnType<NonNullable<ConstructorParameters<typeof HitchEvaluationOperations>[1]>>

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-operation-'))
  roots.push(root)
  const id = canonicalDigest(['operation', root]),
    dataset = join(root, 'dataset'),
    commit = 'a'.repeat(40)
  const binding: HitchOperationBinding = {
    context: {
      evolutionId: 'project',
      roundId: id,
      workspaceRoot: root,
      taskBudgetMs: 10000,
      sandboxProfileRef: 'fixed',
    },
    options: {
      executable: '/fixed/hitch',
      repositoryPath: root,
      root: join(root, 'daemon'),
      harnessId: 'pi',
      model: 'gpt-5.6-luna',
      attempts: 1,
      maxConcurrent: 1,
      setupTimeoutMs: 10000,
      terminationGraceMs: 100,
      maxOutputBytes: 1024 * 1024,
      maxTrajectoryOutputBytes: 1024 * 1024,
      sampling: {},
      agentArgs: [],
      passEnv: [],
      controlPlane: { mode: 'daemon', requireModelCapture: false },
    },
    request: {
      phase: 'seed-candidate',
      dataset,
      harnessRef: commit,
      condition: {
        conditionId: id,
        partition: 'seed',
        dataset: { ref: dataset, digest: canonicalDigest('task') },
        repetitions: 1,
        model: 'gpt-5.6-luna',
        sampling: {},
        timeoutMs: 10000,
        rolloutProviderDigest: canonicalDigest('provider'),
      },
    },
  }
  const accepted = new Map<string, EvaluationReservation>()
  const receipt = () => readFile(join(root, `${id.slice(7)}.json`), 'utf8').then(JSON.parse)
  const accept = async (intent: Readonly<EvaluationSubmissionIntent>) => {
    expect((await receipt()).intent).toEqual(intent)
    if (!accepted.has(intent.idempotencyKey))
      accepted.set(intent.idempotencyKey, { provider: 'hitch-cli', evalId: `eval_${'b'.repeat(32)}` })
    return accepted.get(intent.idempotencyKey)!
  }
  const evidence: HitchEvaluationEvidence = {
    provider: 'hitch-cli',
    evalId: `eval_${'b'.repeat(32)}`,
    conditionId: id,
    effectiveConfigDigest: canonicalDigest('config'),
    invocationFingerprint: canonicalDigest('invocation'),
    localSourceTransport: {
      kind: 'local-git-commit',
      resolutionIdentity: canonicalDigest('revision'),
      commit,
      tree: 'd'.repeat(40),
      payloadSha256: canonicalDigest('payload'),
      payloadBytes: 42,
    },
    dataset,
    requestedCommit: commit,
    actualCommit: commit,
    revisionIdentity: canonicalDigest('revision'),
    completeness: 'complete',
    plannedTrialCount: 1,
    primaryReward: 0,
    summary: { total: 1, passed: 0, failed: 1, score: 0 },
    trials: [],
    invalidTrials: [],
  }
  const client = {
    prepareSubmission: vi.fn(() =>
      new HitchEvaluationClient(binding.options).prepareSubmission(binding.context, binding.request),
    ),
    reserve: vi.fn(async (_context, _request, _signal, intent) => accept(intent!)),
    recoverReservation: vi.fn(async (_context, _request, _signal, intent) => accept(intent)),
    lookupReservation: vi.fn(async (intent) => accepted.get(intent.idempotencyKey)),
    evaluate: vi.fn(async () => structuredClone(evidence)),
    inspectResult: vi.fn(async () => ({ status: 'complete' as const, evidence: structuredClone(evidence) })),
    cancelReservation: vi.fn(async () => {}),
  } satisfies OperationClient
  const factory = vi.fn(() => client),
    operations = new HitchEvaluationOperations(root, factory)
  const signal = new AbortController().signal
  return { root, id, binding, receipt, accepted, evidence, client, factory, operations, signal }
}
it('persists intent before submission and returns durable evidence after a new process instance', async () => {
  const f = await fixture()
  expect(await f.operations.execute(f.id, f.binding, f.signal)).toEqual(f.evidence)
  const restart = new HitchEvaluationOperations(f.root, f.factory)
  expect(await restart.inspect(f.id, f.signal)).toEqual(f.evidence)
  expect(await restart.execute(f.id, f.binding, f.signal)).toEqual(f.evidence)
  expect(f.client.reserve).toHaveBeenCalledTimes(1)
  expect(f.client.evaluate).toHaveBeenCalledTimes(1)
  expect(f.client.inspectResult).not.toHaveBeenCalled()
  expect(f.client.recoverReservation).not.toHaveBeenCalled()
})
it('recovers an accepted submission with a lost response using the exact original key', async () => {
  const f = await fixture(),
    submit = f.client.reserve.getMockImplementation()!
  f.client.reserve.mockImplementationOnce(async (...args) => {
    await submit(...args)
    throw new Error('lost response')
  })
  await expect(f.operations.execute(f.id, f.binding, f.signal)).rejects.toThrow('lost response')
  expect((await f.receipt()).reservation).toBeUndefined()
  expect(await new HitchEvaluationOperations(f.root, f.factory).inspect(f.id, f.signal)).toEqual(f.evidence)
  expect(f.accepted.size).toBe(1)
  expect(f.client.recoverReservation).toHaveBeenCalledTimes(1)
  expect(f.client.evaluate).not.toHaveBeenCalled()
})
it('inspects a reserved operation after losing watch without submitting again', async () => {
  const f = await fixture()
  f.client.evaluate.mockRejectedValueOnce(new Error('observer disconnected'))
  await expect(f.operations.execute(f.id, f.binding, f.signal)).rejects.toThrow('observer disconnected')
  expect(await new HitchEvaluationOperations(f.root, f.factory).inspect(f.id, f.signal)).toEqual(f.evidence)
  expect(f.client.reserve).toHaveBeenCalledTimes(1)
  expect(f.client.recoverReservation).not.toHaveBeenCalled()
})
it('shares one reservation between concurrent callers', async () => {
  const f = await fixture()
  const second = new HitchEvaluationOperations(f.root, f.factory)
  const values = await Promise.all([
    f.operations.execute(f.id, f.binding, f.signal),
    second.execute(f.id, f.binding, f.signal),
  ])
  expect(values).toEqual([f.evidence, f.evidence])
  expect(f.client.reserve).toHaveBeenCalledTimes(1)
  expect(f.accepted.size).toBe(1)
})
it('rejects different inputs for an existing operation before any new remote call', async () => {
  const f = await fixture()
  await f.operations.execute(f.id, f.binding, f.signal)
  const changed = structuredClone(f.binding)
  changed.request.condition.model = 'different'
  await expect(f.operations.execute(f.id, changed, f.signal)).rejects.toThrow('input-conflict')
  expect(f.client.reserve).toHaveBeenCalledTimes(1)
})
it('persists a cancellation tombstone before a delayed first execute', async () => {
  const f = await fixture()
  await f.operations.cancel(f.id, f.signal)
  await expect(f.operations.execute(f.id, f.binding, f.signal)).rejects.toMatchObject({
    code: 'hitch_operation_cancelled',
  })
  expect((await f.receipt()).cancelled).toBe(true)
  expect(f.client.reserve).not.toHaveBeenCalled()
  expect(f.client.lookupReservation).not.toHaveBeenCalled()
})
it('allows cancellation while watch is active and never commits late evidence', async () => {
  const f = await fixture()
  let finish!: () => void
  f.client.evaluate.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return f.evidence
  })
  const running = f.operations.execute(f.id, f.binding, f.signal)
  const rejected = expect(running).rejects.toMatchObject({ code: 'hitch_operation_cancelled' })
  await expect.poll(() => !!finish).toBe(true)
  await new HitchEvaluationOperations(f.root, f.factory).cancel(f.id, f.signal)
  finish()
  await rejected
  expect((await f.receipt()).cancelled).toBe(true)
  expect((await f.receipt()).evidence).toBeUndefined()
  expect(f.client.cancelReservation).toHaveBeenCalledTimes(1)
})
it('keeps uncertain cancellation pending and only searches the original key', async () => {
  const f = await fixture()
  f.client.reserve.mockRejectedValueOnce(new Error('unknown acceptance'))
  await expect(f.operations.execute(f.id, f.binding, f.signal)).rejects.toThrow('unknown acceptance')
  await expect(f.operations.cancel(f.id, f.signal)).rejects.toMatchObject({
    code: 'hitch_operation_cancellation_pending',
  })
  expect((await f.receipt()).cancelled).toBeUndefined()
  const intent = (await f.receipt()).intent as EvaluationSubmissionIntent
  f.accepted.set(intent.idempotencyKey, { provider: 'hitch-cli', evalId: f.evidence.evalId })
  await f.operations.cancel(f.id, f.signal)
  expect((await f.receipt()).cancelled).toBe(true)
  expect(f.client.reserve).toHaveBeenCalledTimes(1)
  expect(f.client.recoverReservation).not.toHaveBeenCalled()
  expect(f.client.lookupReservation).toHaveBeenCalledTimes(2)
})
it('rejects mismatched evidence and a corrupted receipt', async () => {
  const f = await fixture()
  f.client.evaluate.mockResolvedValueOnce({ ...f.evidence, actualCommit: 'c'.repeat(40) })
  await expect(f.operations.execute(f.id, f.binding, f.signal)).rejects.toThrow('evidence-mismatch')
  const saved = await f.receipt()
  saved.binding.options.root = '/different-daemon'
  await writeFile(join(f.root, `${f.id.slice(7)}.json`), JSON.stringify(saved))
  await expect(f.operations.inspect(f.id, f.signal)).rejects.toThrow('receipt-corrupt')
  expect(f.client.inspectResult).not.toHaveBeenCalled()
})
it('requires daemon submission with durable intent', async () => {
  const f = await fixture()
  f.binding.options.controlPlane!.mode = 'direct'
  await expect(f.operations.execute(f.id, f.binding, f.signal)).rejects.toThrow('daemon mode')
  expect(f.client.reserve).not.toHaveBeenCalled()
})

it('cancels a prepared intent with proof that submission never began', async () => {
  const f = await fixture(),
    controller = new AbortController()
  const prepare = f.client.prepareSubmission.getMockImplementation()!
  f.client.prepareSubmission.mockImplementationOnce(() => {
    const intent = prepare()
    controller.abort(new Error('stopped before dispatch'))
    return intent
  })
  await expect(f.operations.execute(f.id, f.binding, controller.signal)).rejects.toThrow('stopped before dispatch')
  expect((await f.receipt()).submissionStarted).toBeUndefined()
  await f.operations.cancel(f.id, f.signal)
  expect((await f.receipt()).cancelled).toBe(true)
  expect(f.client.reserve).not.toHaveBeenCalled()
  expect(f.client.lookupReservation).not.toHaveBeenCalled()
})
