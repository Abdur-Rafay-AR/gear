import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { invalid } from '../domain/errors.js'
import { keys, record, string } from './benchmark.js'

export interface ProjectConfig {
  version: 1
  benchmark: string
  target: { adapter: 'dsh' | 'pi'; path: string; profile: string }
  meta: { profile: string }
  algorithm: 'gepa' | { source: string; entrypoint: string }
  validation: { mode: 'holdout' | 'research' }
  budget: {
    rounds: number
    max_evaluations: number
    diagnosis?: { max_requests: number; max_input_tokens: number; max_output_tokens: number }
  }
}
export function resolveProjectAlgorithm(input: unknown, root: string): ProjectConfig['algorithm'] {
  if (input === undefined || input === 'gepa') return 'gepa'
  const custom = record(input, 'algorithm')
  keys(custom, ['source', 'entrypoint'], 'algorithm')
  const entrypoint = string(custom.entrypoint, 'algorithm.entrypoint')
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$/u.test(entrypoint))
    invalid('Use module:factory', 'algorithm.entrypoint')
  return { source: resolve(root, string(custom.source, 'algorithm.source')), entrypoint }
}
export async function readProject(root: string): Promise<ProjectConfig> {
  const path = resolve(root, 'gear.yaml')
  const input = record(load(await readFile(path, 'utf8')), path)
  keys(input, ['version', 'benchmark', 'target', 'meta', 'algorithm', 'objective', 'validation', 'budget'], path)
  if (input.version !== 1) invalid('Unsupported project version', path)
  const target = record(input.target, 'target'),
    meta = record(input.meta, 'meta')
  const validation = record(input.validation ?? { mode: 'holdout' }, 'validation')
  const budget: Record<string, unknown> = { rounds: 1, max_evaluations: 40, ...record(input.budget ?? {}, 'budget') }
  keys(target, ['adapter', 'path', 'profile'], 'target')
  keys(meta, ['profile'], 'meta')
  keys(validation, ['mode'], 'validation')
  keys(budget, ['rounds', 'max_evaluations', 'diagnosis'], 'budget')
  let diagnosis: ProjectConfig['budget']['diagnosis']
  if (budget.diagnosis !== undefined) {
    const model = record(budget.diagnosis, 'budget.diagnosis')
    const fields = ['max_requests', 'max_input_tokens', 'max_output_tokens'] as const
    keys(model, [...fields], 'budget.diagnosis')
    for (const key of fields)
      if (!Number.isSafeInteger(model[key]) || Number(model[key]) < 1)
        invalid('Expected a positive integer', `budget.diagnosis.${key}`)
    diagnosis = {
      max_requests: model.max_requests as number,
      max_input_tokens: model.max_input_tokens as number,
      max_output_tokens: model.max_output_tokens as number,
    }
  }
  if (!['dsh', 'pi'].includes(String(target.adapter))) invalid('Select dsh or pi', 'target.adapter')
  if (!['holdout', 'research'].includes(String(validation.mode)))
    invalid('Select holdout or research', 'validation.mode')
  const algorithm = resolveProjectAlgorithm(input.algorithm, root)
  if (input.objective !== undefined) {
    const objective = record(input.objective, 'objective')
    keys(objective, ['metric'], 'objective')
    if (objective.metric !== 'pass_rate') invalid('The initial template objective is pass_rate', 'objective.metric')
  }
  for (const [key, value] of Object.entries(budget)) {
    if (key === 'diagnosis') continue
    if (!Number.isSafeInteger(value) || Number(value) < 1) invalid('Expected a positive integer', `budget.${key}`)
  }
  return {
    version: 1,
    benchmark: resolve(root, string(input.benchmark, 'benchmark')),
    target: {
      adapter: target.adapter as 'dsh' | 'pi',
      path: resolve(root, string(target.path, 'target.path')),
      profile: string(target.profile, 'target.profile'),
    },
    meta: { profile: string(meta.profile, 'meta.profile') },
    algorithm,
    validation: { mode: validation.mode as 'holdout' | 'research' },
    budget: {
      rounds: budget.rounds as number,
      max_evaluations: budget.max_evaluations as number,
      ...(diagnosis ? { diagnosis } : {}),
    },
  }
}
