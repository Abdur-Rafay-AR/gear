import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invalid } from '../domain/errors.js'
import type { HarnessAdapter } from '../ports/harness.js'
import { loadBenchmark } from './benchmark.js'

export async function initProject(
  root: string,
  adapter: HarnessAdapter,
  template: 'text' | 'json' | 'file',
  options: { source?: string; targetProfile?: string; metaProfile?: string } = {},
) {
  await mkdir(root, { recursive: true })
  if ((await readdir(root)).length) invalid('Project directory must be empty; import existing Targets explicitly', root)
  const adapterId = adapter.describe().id
  await writeFile(
    join(root, 'gear.yaml'),
    `version: 1\nbenchmark: ./benchmark.yaml\ntarget: {adapter: ${adapterId}, path: ./target, profile: ${JSON.stringify(options.targetProfile ?? 'default-target')}}\nmeta: {profile: ${JSON.stringify(options.metaProfile ?? 'default-meta')}}\nalgorithm: gepa\nobjective: {metric: pass_rate}\nvalidation: {mode: holdout}\nbudget: {rounds: 1, max_evaluations: 40}\n`,
  )
  await writeFile(join(root, 'benchmark.yaml'), `version: 1\nsource: ./tasks.csv\ntemplate: ${template}\n`)
  await copyFile(
    fileURLToPath(new URL(`../../templates/benchmark/${template}/tasks.csv`, import.meta.url)),
    join(root, 'tasks.csv'),
  )
  if (options.source) {
    await writeFile(
      join(root, 'benchmark.yaml'),
      `version: 1\nsource: ${JSON.stringify(options.source)}\ntemplate: ${template}\n`,
    )
    const benchmark = await loadBenchmark(join(root, 'benchmark.yaml'), 'holdout')
    const rows = []
    for (const task of benchmark.tasks) {
      const inputs: Record<string, string> = {}
      for (const input of task.inputs ?? []) {
        const source = `imports/${task.id}/${input.path}`
        await mkdir(dirname(join(root, source)), { recursive: true })
        await writeFile(join(root, source), Buffer.from(input.base64, 'base64'), { mode: 0o600 })
        inputs[input.path.slice('inputs/'.length)] = source
      }
      rows.push({
        id: task.id,
        instruction: task.instruction,
        family: task.family,
        split: task.split,
        expected: task.scorer.kind === 'json' ? JSON.stringify(task.scorer.expected) : task.scorer.expected,
        ...(task.scorer.kind === 'file' ? { path: task.scorer.path } : {}),
        ...(task.scorer.kind !== 'json' ? { normalization: task.scorer.normalization } : {}),
        positive: task.fixtures.positive,
        negative: task.fixtures.negative,
        ...(Object.keys(inputs).length ? { inputs } : {}),
      })
    }
    await writeFile(join(root, 'tasks.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    await writeFile(join(root, 'benchmark.yaml'), `version: 1\nsource: ./tasks.jsonl\ntemplate: ${template}\n`)
    // The template table is unused after an explicit import; leave no misleading example data.
    const { unlink } = await import('node:fs/promises')
    await unlink(join(root, 'tasks.csv'))
  }
  await adapter.prepare(join(root, 'target'))
  await writeFile(join(root, '.gitignore'), '.gear/\n')
  return {
    root,
    adapter: adapterId,
    template,
    next_action: `Edit ${options.source ? 'tasks.jsonl' : 'tasks.csv'}, then gear benchmark check.`,
  }
}
