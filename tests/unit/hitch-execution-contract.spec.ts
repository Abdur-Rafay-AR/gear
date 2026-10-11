import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HitchExecutionContract } from '../../src/adapters/hitch/execution-contract.js'
import type { HitchConfig } from '../../src/config.js'
import type { EvaluationRequest, RefinementRound } from '../../src/types.js'

const fixture = JSON.parse(readFileSync(new URL('../../test-contracts/hitch-execution-v1.json', import.meta.url), 'utf8')) as {
  options: HitchConfig & { repositoryPath: string }
  round: RefinementRound
  request: EvaluationRequest
  cases: Array<{ name: string; options: Partial<HitchConfig>; expected: Record<string, unknown> }>
}

describe('extracted Hitch execution contract', () => {
  it.each(fixture.cases)('retains the pre-extraction execution identity: $name', (entry) => {
    const contract = new HitchExecutionContract({ ...fixture.options, ...entry.options }, fixture.options.repositoryPath)
    contract.assertEvaluationRequest(fixture.round, fixture.request)
    const effectiveConfigDigest = contract.effectiveConfigDigest(fixture.round, fixture.request)
    expect({
      controlPlane: contract.controlPlane,
      controlPlaneArgs: contract.controlPlaneArgs(),
      baseParity: contract.baseParity(fixture.round, fixture.request),
      idempotencyKey: contract.daemonIdempotencyKey(fixture.round, fixture.request),
      effectiveConfigDigest,
      invocationFingerprint: contract.invocationFingerprint(effectiveConfigDigest, 'fixture-hitch-runtime'),
    }).toEqual(entry.expected)
  })
})
