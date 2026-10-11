import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type HistoryFixture, legacySamplingHistory } from '../helpers/project-history-fixture.js'

const root = resolve(import.meta.dirname, '../..')
const fixtures = JSON.parse(readFileSync(resolve(root, 'test-contracts/gepa-history-v1.json'), 'utf8')) as {
  cases: Array<HistoryFixture & ReturnType<typeof legacySamplingHistory>>
}

describe('frozen seed history sampling projections', () => {
  for (const fixture of fixtures.cases)
    it(fixture.name, () => {
      expect(legacySamplingHistory(fixture)).toEqual({ input: fixture.input, expected: fixture.expected })
    })
  it('agrees with Python historical difficulty, provenance validation and project cutoffs', () => {
    execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_gepa_history.py'],
      { cwd: root, env: { ...process.env, PYTHONPATH: 'python' }, stdio: 'pipe' },
    )
  })
})
