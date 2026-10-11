import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { MutationValidationError } from '../../domain/harness.js'
import { protectedArtifactNames } from '../../domain/mutation-policy.js'
import type { HarnessAdapter, MutationPolicy } from '../../ports/harness.js'

export const dshMutationPolicy: MutationPolicy = Object.freeze({
  roots: Object.freeze(['preset', 'plugins', 'prompts', 'skills', 'workflows']),
  protectedNames: protectedArtifactNames,
  allowedImports: Object.freeze(['@deepseek-ai/', 'node:']),
})
export const dshTarget: HarnessAdapter = {
  ref: 'gear/dsh-target@1',
  mutationPolicy: dshMutationPolicy,
  describe: () => ({
    id: 'dsh',
    version: 1,
    resources: ['config', 'rules', 'skill', 'code_extension'],
    guidance: 'Wire plugins into preset/agent.cordis.yml. Fixed dependencies and credentials cannot be edited.',
  }),
  async prepare(root) {
    await mkdir(join(root, 'preset'), { recursive: true })
    await writeFile(join(root, 'preset/agent.cordis.yml'), '- id: gear-policy\n  name: ../plugins/policy.js\n', {
      flag: 'wx',
    })
    await mkdir(join(root, 'plugins'), { recursive: true })
    await writeFile(
      join(root, 'plugins/policy.js'),
      `import { readFileSync } from 'node:fs'\nexport const name = 'gear-policy'\nexport const inject = ['systemPrompt']\nexport function apply(ctx) { ctx.systemPrompt.section({ name: 'gear:policy', order: 50, text: readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8') }) }\n`,
      { flag: 'wx' },
    )
    await mkdir(join(root, 'prompts'), { recursive: true })
    await writeFile(join(root, 'prompts/system.md'), 'Follow the task instruction precisely.\n', { flag: 'wx' })
  },
  async check(root) {
    const parsed: unknown = load(await readFile(join(root, 'preset/agent.cordis.yml'), 'utf8'))
    if (!Array.isArray(parsed))
      throw new MutationValidationError('preset/agent.cordis.yml must contain a Cordis row list')
    for (const [index, row] of parsed.entries()) {
      if (!row || typeof row !== 'object' || typeof row.name !== 'string')
        throw new MutationValidationError(`preset row ${index + 1} must name a plugin`)
    }
  },
  executionSpec: (root, model) => ({
    command: 'node',
    args: ['--expose-internals', '/opt/gear/native/run.mjs', 'dsh', model],
    env: { DSH_HOME: root },
  }),
}
