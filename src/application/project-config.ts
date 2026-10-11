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
  budget: { rounds: number; max_evaluations: number }
}
export async function readProject(root: string): Promise<ProjectConfig> {
  const path = resolve(root, 'gear.yaml')
  const input = record(load(await readFile(path, 'utf8')), path)
  keys(input, ['version', 'benchmark', 'target', 'meta', 'algorithm', 'objective', 'validation', 'budget'], path)
  if (input.version !== 1) invalid('Unsupported project version', path)
  const target = record(input.target, 'target'),
    meta = record(input.meta, 'meta')
  const validation = record(input.validation ?? { mode: 'holdout' }, 'validation')
  const budget = { rounds: 1, max_evaluations: 40, ...record(input.budget ?? {}, 'budget') }
  keys(target, ['adapter', 'path', 'profile'], 'target')
  keys(meta, ['profile'], 'meta')
  keys(validation, ['mode'], 'validation')
  keys(budget, ['rounds', 'max_evaluations'], 'budget')
  if (!['dsh', 'pi'].includes(String(target.adapter))) invalid('Select dsh or pi', 'target.adapter')
  if (!['holdout', 'research'].includes(String(validation.mode)))
    invalid('Select holdout or research', 'validation.mode')
  let algorithm: ProjectConfig['algorithm'] = 'gepa'
  if (input.algorithm !== undefined && input.algorithm !== 'gepa') {
    const custom = record(input.algorithm, 'algorithm')
    keys(custom, ['source', 'entrypoint'], 'algorithm')
    const entrypoint = string(custom.entrypoint, 'algorithm.entrypoint')
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$/u.test(entrypoint))
      invalid('Use module:factory', 'algorithm.entrypoint')
    algorithm = { source: resolve(root, string(custom.source, 'algorithm.source')), entrypoint }
  }
  if (input.objective !== undefined) {
    const objective = record(input.objective, 'objective')
    keys(objective, ['metric'], 'objective')
    if (objective.metric !== 'pass_rate') invalid('The initial template objective is pass_rate', 'objective.metric')
  }
  for (const [key, value] of Object.entries(budget)) {
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
    budget: { rounds: budget.rounds as number, max_evaluations: budget.max_evaluations as number },
  }
}
