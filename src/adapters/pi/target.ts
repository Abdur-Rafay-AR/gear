import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MutationValidationError } from '../../domain/harness.js'
import { protectedArtifactNames } from '../../domain/mutation-policy.js'
import type { HarnessAdapter } from '../../ports/harness.js'

export const piTarget: HarnessAdapter = {
  ref: 'gear/pi-target@1',
  mutationPolicy: Object.freeze({
    roots: Object.freeze(['AGENTS.md', 'settings.json', 'extensions', 'skills', 'prompts']),
    protectedNames: protectedArtifactNames,
    allowedImports: Object.freeze(['@mariozechner/', 'node:']),
  }),
  describe: () => ({
    id: 'pi',
    version: 1,
    resources: ['config', 'rules', 'skill', 'code_extension'],
    guidance:
      'Use AGENTS.md for rules, extensions/ for Pi extensions, skills/ for skills. auth.json is fixed and private.',
  }),
  async prepare(root) {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), 'Follow the task instruction precisely.\n', { flag: 'wx' })
    await writeFile(join(root, 'settings.json'), '{}\n', { flag: 'wx' })
    await mkdir(join(root, 'extensions'), { recursive: true })
  },
  async check(root) {
    await readFile(join(root, 'AGENTS.md'), 'utf8')
    const value: unknown = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new MutationValidationError('Pi settings.json must be an object')
    // External packages/paths would escape the frozen candidate and runtime.
    for (const key of ['packages', 'extensions', 'skills', 'prompts', 'provider', 'apiKey', 'auth']) {
      if (key in value) throw new MutationValidationError(`Pi ${key} belongs to the fixed runtime/profile`)
    }
  },
  executionSpec: (root, model) => ({
    command: 'node',
    args: ['/opt/gear/native/run.mjs', 'pi', model],
    env: { PI_CODING_AGENT_DIR: root },
  }),
}
