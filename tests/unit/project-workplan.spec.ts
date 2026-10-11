import { execFileSync } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AlgorithmDecision } from '../../src/domain/algorithm.js'
import { algorithmProtocol } from '../../src/domain/algorithm-protocol.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { GenerationInput } from '../../src/ports/project.js'
import { diagnosisFixture } from '../helpers/project-diagnosis-runtime.js'

const signal = () => new AbortController().signal
function staged() {
  const f = diagnosisFixture()
  f.plan.diagnosis!.limits.requests = 1
  const generated: GenerationInput[] = []
  const generate = f.provider.generate.bind(f.provider)
  f.provider.generate = async (input, signal) => {
    generated.push(structuredClone(input))
    return generate(input, signal)
  }
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
    const raw = execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      ['-m', 'gear._protocol.worker', 'workplan_staged:build_algorithm'],
      {
        env: {
          ...process.env,
          PYTHONPATH: [resolve('python'), resolve('tests/fixtures/project_algorithms')].join(delimiter),
        },
        input: `${JSON.stringify(request)}\n`,
        encoding: 'utf8',
      },
    )
    return JSON.parse(raw).decision as AlgorithmDecision
  }
  return { ...f, generated }
}

describe('certified workplan execution', () => {
  it('limits generation seed text and dossier facts to the assigned scope and detaches returned files', async () => {
    const f = staged(),
      step = f.algorithm.step.bind(f.algorithm),
      files = { 'AGENTS.md': 'improved' }
    f.algorithm.step = async (...args) => {
      const decision = await step(...args)
      for (const op of decision.operations) if (op.workplan) op.tasks = ['bad']
      return decision
    }
    f.provider.generate = async (input) => {
      expect(input.seed.map((t) => t.id)).toEqual(['bad'])
      expect(input.delivery!.dossier.facts.map((f) => f.task_id)).toEqual(['bad'])
      return files
    }
    const run = await f.runtime.start(f.plan, signal())
    files['AGENTS.md'] = 'changed after result was returned'
    expect(run.candidates.find((c) => c.id === 'candidate-1')!.files['AGENTS.md']).toBe('improved')
  })
  it('runs real StagedGEPA diagnosis, hypothesis delivery, bounded mutation, gate and terminal recovery', async () => {
    const f = staged()
    const run = await f.runtime.start(f.plan, signal())
    expect(run.champion).toBe('candidate-1')
    expect(run.gate?.accepted).toBe(true)
    expect(run.decisions.map((d) => d.decision.state.stage)).toContain('propose')
    expect(run.decisions[0]!.decision.operations.every((o) => o.kind !== 'generate')).toBe(true)
    expect(f.generated).toHaveLength(1)
    const input = f.generated[0]!,
      delivery = input.delivery!
    expect(input.diagnosis).toBeUndefined()
    expect(delivery.workplan).toMatchObject({
      family_id: 'behavior',
      hypothesis: 'Check instruction handling',
      target_task_ids: ['bad'],
      modification_paths: ['AGENTS.md'],
      generation_budget: { deadline_ms: null, max_tokens: null, max_model_requests: null },
    })
    expect(delivery.workplanIdentity).toBe(canonicalDigest(delivery.workplan))
    expect(input.seed.map((t) => t.id)).toEqual(delivery.scopeTaskIds)
    expect(JSON.stringify(delivery)).not.toContain('PRIVATE-HOLDOUT')
    expect(Object.values(run.completed!).find((r) => r.kind === 'generate')).toMatchObject({
      status: 'complete',
      workplan_identity: delivery.workplanIdentity,
      delivery_identity: delivery.identity,
    })
    expect(await f.runtime.resume(run.id, signal())).toEqual(run)
    expect(f.generated).toHaveLength(1)
  })
  it('inspects the original generation and keeps the committed delivery after a lost response', async () => {
    const f = staged(),
      generate = f.provider.generate.bind(f.provider)
    f.provider.generate = async (input, signal) => {
      await generate(input, signal)
      throw new Error('lost-generation-response')
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow('lost-generation-response')
    const pending = structuredClone(f.run().operations.find((o) => o.kind === 'generation'))
    const decisions = structuredClone(f.run().decisions)
    const run = await f.runtime.resume(f.run().id, signal())
    expect(run.champion).toBe('candidate-1')
    expect(run.operations.find((o) => o.kind === 'generation')?.delivery).toEqual(pending?.delivery)
    expect(run.decisions.slice(0, decisions.length).map((d) => d.decision)).toEqual(decisions.map((d) => d.decision))
    expect(f.generated).toHaveLength(1)
  })
  it.each(['add', 'edit', 'delete', 'prefix', 'mutate-input'])(
    'rejects a %s outside the workplan before sealing',
    async (kind) => {
      const f = staged()
      f.plan.target.files['prompts/keep.md'] = 'untouched'
      f.provider.generate = async (input) => {
        f.generated.push(structuredClone(input))
        const files: Record<string, string> = { ...input.parent.files, 'AGENTS.md': 'improved' }
        if (kind === 'delete') delete files['prompts/keep.md']
        else if (kind === 'edit') files['prompts/keep.md'] = 'changed'
        else if (kind === 'prefix') files['AGENTS.md-evil'] = 'changed'
        else files['other.txt'] = 'changed'
        if (kind === 'mutate-input') {
          input.delivery!.workplan.modification_paths.push('other.txt')
          input.parent.files['other.txt'] = 'changed'
        }
        return files
      }
      const run = await f.runtime.start(f.plan, signal())
      expect(run.candidates).toHaveLength(1)
      expect(run.candidates[0]!.files).not.toHaveProperty('other.txt')
      expect(run.champion).toBe('initial')
      expect(Object.values(run.completed!).find((r) => r.kind === 'generate')).toMatchObject({
        status: 'invalid-candidate',
        reason: 'workplan-boundary',
      })
      expect(run.operations.filter((o) => o.kind === 'generation')).toHaveLength(1)
    },
  )
  it.each([
    'parent',
    'dossier',
    'hypothesis',
    'family',
    'refs',
    'paths',
    'tasks',
    'manifest',
    'unbound',
    'deadline',
    'tokens',
    'requests',
  ])('rejects a forged or unsupported %s workplan before reserving generation', async (field) => {
    const f = staged(),
      step = f.algorithm.step.bind(f.algorithm)
    f.algorithm.step = async (...args) => {
      const decision = await step(...args),
        op = decision.operations.find((o) => o.workplan)
      if (op) {
        const p = op.workplan!
        if (field === 'parent') p.parent_identity = 'another-parent'
        if (field === 'dossier') p.dossier_identity = 'another-dossier'
        if (field === 'hypothesis') p.hypothesis = 'unsupported cause'
        if (field === 'family') p.family_id = 'another-family'
        if (field === 'refs') p.required_diagnosis_refs = ['another-ref']
        if (field === 'paths') p.modification_paths = ['other.txt']
        if (field === 'tasks') p.target_task_ids = ['good']
        if (field === 'manifest') p.required_seed_tasks = ['bad']
        if (field === 'unbound') op.diagnosis_id = null
        if (field === 'deadline') p.generation_budget.deadline_ms = 9007199254740991
        if (field === 'tokens') p.generation_budget.max_tokens = 100
        if (field === 'requests') p.generation_budget.max_model_requests = 1
      }
      return decision
    }
    await expect(f.runtime.start(f.plan, signal())).rejects.toThrow()
    expect(f.generated).toHaveLength(0)
    expect(f.run().operations.filter((o) => o.kind === 'generation')).toHaveLength(0)
  })
  it('retains unresolved research without generating from unsupported causes', async () => {
    const f = staged(),
      diagnose = f.port.diagnose.bind(f.port)
    f.port.diagnose = async (input, signal) => ({ ...(await diagnose(input, signal)), facts: [] })
    const run = await f.runtime.start(f.plan, signal())
    expect(run.champion).toBe('initial')
    expect(f.generated).toHaveLength(0)
    expect(run.decisions.at(-1)!.decision.state.planning_exclusions).toContainEqual(
      expect.objectContaining({ reason: 'no-new-supported-hypothesis' }),
    )
  })
})
