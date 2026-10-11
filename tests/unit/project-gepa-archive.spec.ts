import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyResearchArchive, type ResearchFixture } from '../helpers/project-archive-fixture.js'

const root = resolve(import.meta.dirname, '../..')
const fixtures = JSON.parse(readFileSync(resolve(root, 'test-contracts/gepa-archive-v1.json'), 'utf8')) as {
  cases: ResearchFixture[]
}

describe('frozen historical archive and parent policy projections', () => {
  for (const fixture of fixtures.cases) {
    it(fixture.name, () => {
      expect(legacyResearchArchive(fixture)).toEqual({ input: fixture.input, expected: fixture.expected })
    })
  }
  it('matches all fixed archive views and allocation plans in Python', () => {
    execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_gepa_archive.py'],
      {
        cwd: root,
        env: { ...process.env, PYTHONPATH: 'python' },
        stdio: 'pipe',
      },
    )
  })
})
