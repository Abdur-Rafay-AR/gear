import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyScopeResult, type ScopeFixture } from '../helpers/project-scope-fixture.js'

const root = resolve(import.meta.dirname, '../..')
const fixturePath = resolve(root, 'test-contracts/gepa-scopes-v1.json')
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: ScopeFixture[] }

describe('frozen historical GEPA scope selections', () => {
  for (const fixture of fixtures.cases) {
    it(fixture.name, () => expect(legacyScopeResult(fixture)).toEqual(fixture.expected))
  }
  it('matches the same fixed selections in the public Python sampler', () => {
    execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_gepa_scopes.py'],
      { cwd: root, env: { ...process.env, PYTHONPATH: 'python' }, stdio: 'pipe' },
    )
  })
})
