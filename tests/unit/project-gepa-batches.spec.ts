import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyParentBatches, type ResearchFixture } from '../helpers/project-archive-fixture.js'

const root = resolve(import.meta.dirname, '../..')
const archive = JSON.parse(readFileSync(resolve(root, 'test-contracts/gepa-archive-v1.json'), 'utf8')) as {
  cases: ResearchFixture[]
}
const batches = JSON.parse(readFileSync(resolve(root, 'test-contracts/gepa-parent-batches-v1.json'), 'utf8')) as {
  cases: ReturnType<typeof legacyParentBatches>
}

describe('complete frozen parent batch plans', () => {
  for (const row of archive.cases)
    it(row.name, () => {
      const expected = batches.cases.filter((c) => c.name.startsWith(`${row.name}/`))
      expect(legacyParentBatches(row)).toEqual(expected)
    })
  it('matches Python batches, quotas and all mandatory epoch parents', () => {
    execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_gepa_batches.py'],
      { cwd: root, env: { ...process.env, PYTHONPATH: 'python' }, stdio: 'pipe' },
    )
  })
})
