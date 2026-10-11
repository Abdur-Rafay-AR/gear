import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type ArchiveFixture,
  type BridgeFixture,
  legacyBridge,
  legacyFrontier,
} from '../helpers/project-stages-fixture.js'

const root = resolve(import.meta.dirname, '../..')
const fixtures = JSON.parse(readFileSync(resolve(root, 'test-contracts/gepa-stages-v1.json'), 'utf8')) as {
  archive: ArchiveFixture[]
  bridge: BridgeFixture[]
}
describe('historical frontier and bridge semantic fixtures', () => {
  for (const fixture of fixtures.archive) {
    it(fixture.name, () => {
      expect(legacyFrontier(fixture)).toEqual({ input: fixture.input, expected: fixture.expected })
    })
  }
  for (const fixture of fixtures.bridge) {
    it(fixture.name, async () => {
      expect(await legacyBridge(fixture)).toEqual({ input: fixture.input, expected: fixture.expected })
    })
  }
  it('matches the fixed projections in Python', () => {
    execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_gepa_stages.py'],
      { cwd: root, env: { ...process.env, PYTHONPATH: 'python' }, stdio: 'pipe' },
    )
  })
})
