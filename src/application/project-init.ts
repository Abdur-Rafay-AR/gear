import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeHarborTask } from '../adapters/hitch/harbor-files.js'
import { invalid } from '../domain/errors.js'
import type { HarnessAdapter } from '../ports/harness.js'
import { loadBenchmark } from './benchmark.js'
import { loadHarborBenchmark } from './benchmark-harbor.js'

export async function initProject(
  root: string,
  adapter: HarnessAdapter,
  template: 'text' | 'json' | 'file' | 'harbor',
  options: {
    source?: string
    manifest?: string
    validation?: 'holdout' | 'research'
    targetProfile?: string
    metaProfile?: string
  } = {},
) {
  await mkdir(root, { recursive: true })
  if ((await readdir(root)).length) invalid('Project directory must be empty; import existing Targets explicitly', root)
  if (options.manifest && template !== 'harbor') invalid('A split manifest is only used for Harbor import')
  if (template === 'harbor' && (!options.source || !options.manifest))
    invalid('Harbor import requires --from DIRECTORY and --manifest CSV_OR_JSONL')
  const harborConfig = { version: 1, template: 'harbor', source: options.source, manifest: options.manifest }
  const harbor =
    template === 'harbor'
      ? await loadHarborBenchmark(
          JSON.stringify(harborConfig),
          harborConfig,
          join(root, 'benchmark.yaml'),
          options.validation ?? 'holdout',
        )
      : undefined
  const adapterId = adapter.describe().id
  await writeFile(
    join(root, 'gear.yaml'),
    `version: 1\nbenchmark: ./benchmark.yaml\ntarget: {adapter: ${adapterId}, path: ./target, profile: ${JSON.stringify(options.targetProfile ?? 'default-target')}}\nmeta: {profile: ${JSON.stringify(options.metaProfile ?? 'default-meta')}}\nalgorithm: gepa\nobjective: {metric: ${harbor ? 'reward' : 'pass_rate'}}\nvalidation: {mode: ${options.validation ?? 'holdout'}}\nbudget: {rounds: 1, max_evaluations: 40}\n`,
  )
  if (harbor) {
    const rows = []
    for (const task of harbor.tasks) {
      await writeHarborTask(task.harbor!, join(root, 'harbor', task.id))
      if (task.scorer.kind !== 'harbor') throw new TypeError('invalid-harbor-import')
      rows.push({ id: task.id, family: task.family, split: task.split, metric: task.scorer.metric })
    }
    await writeFile(join(root, 'tasks.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    await writeFile(
      join(root, 'benchmark.yaml'),
      'version: 1\nsource: ./harbor\nmanifest: ./tasks.jsonl\ntemplate: harbor\n',
    )
  } else {
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
      const benchmark = await loadBenchmark(join(root, 'benchmark.yaml'), options.validation ?? 'holdout')
      const rows = []
      for (const task of benchmark.tasks) {
        if (task.scorer.kind === 'harbor' || !task.fixtures) throw new TypeError('invalid-template-import')
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
