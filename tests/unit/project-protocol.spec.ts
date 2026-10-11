import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { algorithmProtocol } from '../../src/domain/algorithm-protocol.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

describe('versioned Python protocol', () => {
  it('agrees on canonical unicode, finite floats, nested maps and empty containers', () => {
    const raw = execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      [
        '-c',
        'import json,sys; from gear._protocol.canonical import digest; print(json.dumps([digest(v) for v in json.load(sys.stdin)]))',
      ],
      {
        cwd: resolve(import.meta.dirname, '../..'),
        env: { ...process.env, PYTHONPATH: 'python' },
        input: JSON.stringify(algorithmProtocol.goldenValues),
        encoding: 'utf8',
      },
    )
    expect(JSON.parse(raw)).toEqual(algorithmProtocol.goldenValues.map(canonicalDigest))
  })
  it('rejects a stale input digest and unknown protocol fields before executing the algorithm', () => {
    expect(() =>
      execFileSync(process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', ['-m', 'gear._protocol.worker'], {
        env: { ...process.env, PYTHONPATH: 'python' },
        input: '{"protocol_version":99}\n',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).toThrow()
  })
})
