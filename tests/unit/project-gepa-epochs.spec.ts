import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type EpochFixture, legacyEpochAdmission } from '../helpers/project-epoch-fixture.js'

const root = resolve(import.meta.dirname, '../..')
const fixtures = JSON.parse(readFileSync(resolve(root, 'test-contracts/gepa-epochs-v1.json'), 'utf8')) as {
  cases: Array<EpochFixture & Awaited<ReturnType<typeof legacyEpochAdmission>>>
}

describe('frozen historical epoch admission with existing proposed scopes', () => {
  for (const fixture of fixtures.cases) {
    it(fixture.name, async () => {
      expect(await legacyEpochAdmission(fixture)).toEqual({ input: fixture.input, expected: fixture.expected })
    })
  }
  it('matches Python admission, periodic planning and incomplete-baseline behavior', () => {
    execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_gepa_epochs.py'],
      { cwd: root, env: { ...process.env, PYTHONPATH: 'python' }, stdio: 'pipe' },
    )
  })
})
