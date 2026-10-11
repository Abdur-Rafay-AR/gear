import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dshTarget } from '../../src/adapters/dsh/target.js'
import { piTarget } from '../../src/adapters/pi/target.js'
import { targetFiles, validateTargetFiles } from '../../src/application/target-files.js'
import { validateArtifactPath } from '../../src/domain/mutation-policy.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('native Target policies', () => {
  for (const adapter of [piTarget, dshTarget])
    it(`${adapter.ref} prepares and checks its own resource format`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'gear-target-test-'))
      roots.push(root)
      await adapter.prepare(root)
      const files = await targetFiles(root, adapter)
      expect(Object.keys(files).length).toBeGreaterThan(0)
      await validateTargetFiles(files, adapter)
      expect(() => validateArtifactPath('package.json', adapter.mutationPolicy)).toThrow()
      expect(() => validateArtifactPath('../private', adapter.mutationPolicy)).toThrow()
    })
  it('Pi does not need Cordis and refuses external packages and credentials', async () => {
    await validateTargetFiles(
      { 'AGENTS.md': 'rules', 'settings.json': '{}', 'extensions/policy.ts': 'export default function(pi) {}' },
      piTarget,
    )
    await expect(
      validateTargetFiles({ 'AGENTS.md': 'rules', 'settings.json': '{"packages":["/private"]}' }, piTarget),
    ).rejects.toThrow(/fixed runtime/)
    expect(() => validateArtifactPath('auth.json', piTarget.mutationPolicy)).toThrow()
  })
})
