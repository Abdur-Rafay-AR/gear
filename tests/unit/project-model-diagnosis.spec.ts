import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { piTarget } from '../../src/adapters/pi/target.js'
import { ProjectApplication } from '../../src/application/project.js'
import { readProject } from '../../src/application/project-config.js'
import { initProject } from '../../src/application/project-init.js'
import { projectReport } from '../../src/application/project-report.js'
import { renderProjectResult } from '../../src/cli/project-output.js'
import { algorithmProtocol } from '../../src/domain/algorithm-protocol.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { certifyDiagnosis, diagnosisText } from '../../src/domain/diagnosis.js'
import { type ProjectRun, ProjectRuntime } from '../../src/runtime/project.js'
import { diagnosisAccounting } from '../../src/runtime/project-diagnosis.js'
import { diagnosisFixture as fixture } from '../helpers/project-diagnosis-runtime.js'

const signal = () => new AbortController().signal

describe('metered provider seed diagnosis', () => {
  it('settles actual usage, exposes remaining budget and certifies only parent seed evidence', async () => {
    const f = fixture(2)
    const run = await f.runtime.start(f.plan, signal())
    expect(run.status).toBe('complete')
    expect(f.calls.map((c) => c.limits)).toEqual([
      { requests: 1, inputTokens: 1000, outputTokens: 200 },
      { requests: 1, inputTokens: 900, outputTokens: 180 },
    ])
    expect(f.calls[0]!.observations.find((t) => t.taskId === 'bad')!.output).toBe('wrong🦊')
    const receipt = Object.values(run.completed!)[0]!
    expect(receipt.dossier).toMatchObject({
      parent_identity: 'target-v1',
      classifier_identity: f.port.identity,
      facts: [
        { task_id: 'bad', status: 'supported-hypothesis' },
        { task_id: 'good', status: 'successful-control' },
      ],
    })
    expect(JSON.stringify(receipt)).not.toContain('wrong🦊')
    const clusters = JSON.parse(
      execFileSync(
        process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
        [
          '-c',
          `import json, sys
from dataclasses import asdict
from gear.algorithms import DiagnosisDossier, DiagnosisFact, DiagnosisTask, failure_clusters
value = json.load(sys.stdin)
value['facts'] = tuple(DiagnosisFact(**f) for f in value['facts'])
dossier = DiagnosisDossier(**value)
tasks = tuple(DiagnosisTask(t, 'seed-family') for t in dossier.task_ids)
print(json.dumps([asdict(c) for c in failure_clusters(dossier, tasks, dossier.cohort_identity)]))`,
        ],
        {
          input: JSON.stringify(receipt.dossier),
          encoding: 'utf8',
          env: { ...process.env, PYTHONPATH: resolve('python') },
        },
      ),
    )
    expect(clusters).toMatchObject([
      {
        family_id: 'behavior',
        parent_identity: 'target-v1',
        task_ids: ['bad'],
        successful_control_task_ids: ['good'],
      },
    ])
    expect(projectReport(run).diagnosisBudget).toMatchObject({
      spent: { requests: 2, inputTokens: 200, outputTokens: 40 },
      reserved: { requests: 0, inputTokens: 0, outputTokens: 0 },
      remaining: { requests: 1, inputTokens: 800, outputTokens: 160 },
    })
    expect(await f.runtime.resume(run.id, signal())).toEqual(run)
    expect(f.calls).toHaveLength(2)
    expect(renderProjectResult(projectReport(run))).toContain('Diagnosis requests: 2/3; reserved: 0')
  })
  it('reserves a fair token slice for each diagnosis in one committed batch', async () => {
    const f = fixture()
    f.algorithm.step = async (view, state) => ({
      state: { done: true },
      reason: 'Batch two diagnoses',
      operations: state.done
        ? [{ kind: 'stop', candidate: '', parent: '', tasks: [] }]
        : [
            { kind: 'diagnose_seed', candidate: 'initial', parent: '', tasks: view.seed_tasks },
            { kind: 'diagnose_seed', candidate: 'initial', parent: '', tasks: view.seed_tasks },
          ],
    })
    await f.runtime.start(f.plan, signal())
    expect(f.calls.map((call) => call.limits)).toEqual([
      { requests: 1, inputTokens: 500, outputTokens: 100 },
      { requests: 1, inputTokens: 900, outputTokens: 180 },
    ])
    const rejected = fixture()
    rejected.plan.diagnosis!.limits.requests = 1
    rejected.algorithm.step = f.algorithm.step
    await expect(rejected.runtime.start(rejected.plan, signal())).rejects.toMatchObject({
      details: { code: 'diagnosis-budget-exhausted' },
    })
    expect(rejected.calls).toHaveLength(0)
    expect(rejected.run().decisions).toHaveLength(0)
  })
  it('recovers a lost response with the frozen input and original reservation', async () => {
    const f = fixture(),
      original = f.port.diagnose.bind(f.port)
    f.port.diagnose = async (input, signal) => {
      await original(input, signal)
      throw new Error('lost-response')
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('lost-response')
    const decision = structuredClone(f.run().decisions)
    expect(diagnosisAccounting(f.run()).reserved).toEqual(f.calls[0]!.limits)
    const run = await new ProjectRuntime(f.store, f.provider, f.algorithm, async () => {}).resume(f.run().id, signal())
    expect(run.decisions[0]!.decision).toEqual(decision[0]!.decision)
    expect(diagnosisAccounting(run).spent.requests).toBe(1)
    expect(f.calls).toHaveLength(1)
  })
  it('recovers a failed usage settlement write without refunding or repeating the model call', async () => {
    const f = fixture(),
      write = f.store.write.bind(f.store)
    let failed = false
    f.store.write = async (id, value) => {
      if (!failed && (value as ProjectRun).operations.some((o) => o.diagnosis?.result)) {
        failed = true
        throw new Error('settlement-write-failed')
      }
      await write(id, value)
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('settlement-write-failed')
    expect(diagnosisAccounting(f.run()).reserved.inputTokens).toBe(1000)
    const run = await f.runtime.resume(f.run().id, signal())
    expect(diagnosisAccounting(run).spent.inputTokens).toBe(100)
    expect(diagnosisAccounting(run).reserved.inputTokens).toBe(0)
    expect(f.calls).toHaveLength(1)
  })
  it('retains an unknown reservation without resubmitting and cancels through the diagnosis port', async () => {
    const f = fixture()
    f.port.diagnose = async (input) => {
      f.calls.push(input)
      throw new Error('unknown')
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('unknown')
    await expect(f.runtime.resume(f.run().id, signal())).rejects.toMatchObject({
      details: { code: 'operation-pending' },
    })
    expect(f.calls).toHaveLength(1)
    await f.store.requestCancel(f.run().id)
    await expect(f.runtime.resume(f.run().id, signal())).rejects.toMatchObject({ details: { code: 'run-cancelled' } })
    expect(f.stopped).toEqual([f.calls[0]!.operationId])
    expect(diagnosisAccounting(f.run()).reserved.requests).toBe(1)
  })
  it('resubmits only after a definitive not-started inspection', async () => {
    const f = fixture(),
      original = f.port.diagnose.bind(f.port)
    f.port.diagnose = async () => {
      throw new Error('not-sent')
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('not-sent')
    const frozen = structuredClone(f.run().operations.find((o) => o.kind === 'diagnosis'))
    f.port.inspectDiagnosis = async () => ({ status: 'not-started' })
    f.port.diagnose = original
    const run = await f.runtime.resume(f.run().id, signal())
    expect(f.calls).toEqual([frozen!.diagnosis!.input])
    expect(run.operations.filter((o) => o.kind === 'diagnosis')).toHaveLength(1)
  })
  it('rejects missing capabilities before baseline and changed diagnosis identity on resume', async () => {
    const f = fixture(),
      { diagnosis: _port, ...provider } = f.provider
    await expect(
      new ProjectRuntime(f.store, provider, f.algorithm, async () => {}).start(f.plan, signal()),
    ).rejects.toMatchObject({ details: { code: 'diagnosis-provider-required' } })
    expect(f.evaluated).toHaveLength(0)
    f.port.diagnose = async () => {
      throw new Error('unknown')
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('unknown')
    await expect(
      new ProjectRuntime(
        f.store,
        { ...f.provider, diagnosis: { ...f.port, identity: 'changed' } },
        f.algorithm,
        async () => {},
      ).resume(f.run().id, signal()),
    ).rejects.toMatchObject({ details: { code: 'diagnosis-identity-mismatch' } })
  })
  it('stops before a second model request when actual usage exhausts the frozen budget', async () => {
    const f = fixture(2),
      original = f.port.diagnose.bind(f.port)
    f.port.diagnose = async (input, signal) => ({ ...(await original(input, signal)), usage: input.limits })
    await expect(f.runtime.start(f.plan, signal())).rejects.toMatchObject({
      details: { code: 'diagnosis-budget-exhausted' },
    })
    expect(f.calls).toHaveLength(1)
    expect(diagnosisAccounting(f.run()).remaining.inputTokens).toBe(0)
    expect(f.run().operations.filter((o) => o.kind === 'diagnosis')).toHaveLength(1)
  })
  it.each(['foreign-task', 'foreign-ref', 'success-as-failure', 'failure-as-control', 'unsafe-path', 'over-budget'])(
    'retains spent usage when rejecting %s and never calls the model again',
    async (failure) => {
      const f = fixture(),
        original = f.port.diagnose.bind(f.port)
      f.port.diagnose = async (input, signal) => {
        const result = await original(input, signal),
          fact = result.facts[0]!
        if (failure === 'foreign-task') fact.task_id = 'held_out'
        if (failure === 'foreign-ref') fact.evidence_refs = ['unrelated-parent']
        if (failure === 'success-as-failure') {
          fact.task_id = 'good'
          fact.evidence_refs = [input.observations.find((o) => o.taskId === 'good')!.evidenceRef!]
        }
        if (failure === 'failure-as-control') fact.status = 'successful-control'
        if (failure === 'unsafe-path') fact.modification_paths = ['../secret']
        if (failure === 'over-budget') result.usage.inputTokens = input.limits.inputTokens + 1
        return result
      }
      await expect(f.runtime.start(f.plan, signal())).rejects.toThrow()
      const cost = failure === 'over-budget' ? 1001 : 100
      expect(diagnosisAccounting(f.run()).spent.inputTokens).toBe(cost)
      expect(diagnosisAccounting(f.run()).reserved.inputTokens).toBe(0)
      expect(Object.values(f.run().completed ?? {})).toHaveLength(0)
      await expect(f.runtime.resume(f.run().id, signal())).rejects.toThrow()
      expect(f.calls).toHaveLength(1)
    },
  )
  it('does not manufacture a supported cause from scores and rejects unsupported invalidation', async () => {
    const f = fixture()
    await f.runtime.start(f.plan, signal())
    const input = f.calls[0]!,
      result = { facts: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0 } }
    expect(certifyDiagnosis(input, result, f.port.identity).facts.map((f) => f.status)).toEqual([
      'unresolved',
      'successful-control',
    ])
    expect(() =>
      certifyDiagnosis(
        input,
        { ...result, facts: [{ task_id: 'bad', evidence_refs: [], status: 'infrastructure-invalid' }] },
        f.port.identity,
      ),
    ).toThrow('diagnosis-invalidates-valid-evidence')
    expect(diagnosisText('🦊'.repeat(17000))).toHaveLength(16384 * 2)
  })
  it('passes the certified dossier and model budget through the real default Python recipe', async () => {
    const f = fixture()
    f.plan.maxCandidates = 2
    f.plan.diagnosis!.limits.requests = 1
    f.algorithm.step = async (view, state, context) => {
      const payload = { view, state }
      const request = {
        protocol_version: 1,
        request_id: `request-${context.stepId}`,
        run_id: context.runId,
        step_id: context.stepId,
        input_digest: canonicalDigest(payload),
        input: payload,
        capabilities: algorithmProtocol.capabilities,
      }
      const raw = execFileSync(process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', ['-m', 'gear._protocol.worker'], {
        env: { ...process.env, PYTHONPATH: resolve('python') },
        input: `${JSON.stringify(request)}\n`,
        encoding: 'utf8',
      })
      return JSON.parse(raw).decision
    }
    const run = await f.runtime.start(f.plan, signal())
    expect(run.champion).toBe('candidate-1')
    expect(run.gate?.accepted).toBe(true)
    expect(f.calls).toHaveLength(1)
    expect(await f.runtime.resume(run.id, signal())).toEqual(run)
  })
  it('resolves project diagnosis budgets and rejects unavailable providers before execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-model-diagnosis-'))
    try {
      await initProject(root, piTarget, 'text')
      const path = join(root, 'gear.yaml'),
        original = await readFile(path, 'utf8')
      await writeFile(
        path,
        original.replace(
          'budget: {rounds: 1, max_evaluations: 40}',
          'budget:\n  rounds: 1\n  max_evaluations: 40\n  diagnosis: { max_requests: 2, max_input_tokens: 500, max_output_tokens: 100 }',
        ),
      )
      expect((await readProject(root)).budget.diagnosis).toEqual({
        max_requests: 2,
        max_input_tokens: 500,
        max_output_tokens: 100,
      })
      const f = fixture(),
        { diagnosis: _diagnosis, ...provider } = f.provider
      await expect(
        new ProjectApplication(root, { provider, algorithm: f.algorithm }).run('refine', {}, signal()),
      ).rejects.toMatchObject({ details: { code: 'diagnosis-provider-required' } })
      expect(f.evaluated).toHaveLength(0)
      await writeFile(
        path,
        original.replace(
          'budget: {rounds: 1, max_evaluations: 40}',
          'budget:\n  rounds: 1\n  max_evaluations: 40\n  diagnosis: { max_requests: true, max_input_tokens: 500, max_output_tokens: 100 }',
        ),
      )
      await expect(readProject(root)).rejects.toThrow('positive integer')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
