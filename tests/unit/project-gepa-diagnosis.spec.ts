import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type DiagnosisFixture, legacyDiagnosis } from '../helpers/project-diagnosis-fixture.js'

const root = resolve(import.meta.dirname, '../..')
const fixture = JSON.parse(readFileSync(resolve(root, 'test-contracts/gepa-diagnosis-v1.json'), 'utf8')) as {
  cases: Array<DiagnosisFixture & ReturnType<typeof legacyDiagnosis>>
}
describe('frozen historical diagnosis families and proposal delivery', () => {
  for (const row of fixture.cases)
    it(row.name, () => {
      expect(legacyDiagnosis(row)).toEqual({ input: row.input, expected: row.expected })
    })
  it('agrees with Python families, excerpts, quotas and receipt validation', () => {
    execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_gepa_diagnosis.py'],
      { cwd: root, env: { ...process.env, PYTHONPATH: 'python' }, stdio: 'pipe' },
    )
  })
})
