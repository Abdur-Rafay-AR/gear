import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeAlgorithmResponse } from '../../src/adapters/python/messages.js'
import { protocolProcess } from '../../src/adapters/python/process.js'
import { type AlgorithmRequest, algorithmProtocol, validateWireType } from '../../src/domain/algorithm-protocol.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

describe('versioned Python protocol', () => {
  const root = resolve(import.meta.dirname, '../..')
  const vectors = JSON.parse(readFileSync(resolve(root, 'test-contracts/algorithm-payload-v1.json'), 'utf8')) as {
    cases: Array<{ name: string; type: keyof typeof algorithmProtocol.types; value: unknown; valid: boolean }>
  }
  for (const row of vectors.cases)
    it(row.name, () => {
      const before = structuredClone(row.value)
      if (row.valid) expect(() => validateWireType(row.type, row.value)).not.toThrow()
      else expect(() => validateWireType(row.type, row.value)).toThrow('protocol-payload-invalid')
      expect(row.value).toEqual(before)
    })
  it('compares the same fixed payloads in Python and checks admission before plugin import/output', () => {
    execFileSync(
      process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
      ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_protocol_payload.py'],
      { cwd: root, env: { ...process.env, PYTHONPATH: 'python' }, stdio: 'pipe' },
    )
  })
  it('rejects non-JSON state and excessive nesting without exposing map keys', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    let deep: unknown = 0
    for (let i = 0; i < 65; i++) deep = [deep]
    for (const value of [NaN, Infinity, 2 ** 53, 1n, undefined, new Date(), '\ud800', cycle, deep, new Array(2)]) {
      expect(() => validateWireType('JsonObject', { PRIVATE_SECRET: value })).toThrow('protocol-payload-invalid')
      try {
        validateWireType('JsonObject', { PRIVATE_SECRET: value })
      } catch (error) {
        expect(String(error)).not.toContain('PRIVATE_SECRET')
      }
    }
    let admitted: unknown = 0
    for (let i = 0; i < 63; i++) admitted = [admitted]
    expect(() => validateWireType('JsonObject', { nested: admitted })).not.toThrow()
  })
  it('rejects invalid UTF-8 from a worker before JSON parsing', async () => {
    await expect(
      protocolProcess(
        [process.execPath, '-e', 'process.stdout.write(Buffer.from([0xff,10]))'],
        root,
        {},
        '',
        new AbortController().signal,
        1024,
      ),
    ).rejects.toThrow('protocol-invalid-utf8')
  })
  it('rejects stale, duplicate, malformed and capability-mismatched responses', () => {
    const request = vectors.cases.find((v) => v.name === 'request')!.value as AlgorithmRequest
    const decision = vectors.cases.find((v) => v.name === 'decision')!.value
    const { input: _input, ...envelope } = request
    const response = { ...envelope, decision }
    const encoded = `${JSON.stringify(response)}\n`
    expect(decodeAlgorithmResponse(encoded, request)).toEqual(decision)
    expect(() => decodeAlgorithmResponse(encoded + encoded, request)).toThrow('protocol-duplicate-response')
    expect(() => decodeAlgorithmResponse(encoded.trimEnd(), request)).toThrow('protocol-response-framing')
    expect(() => decodeAlgorithmResponse('PRIVATE_SECRET\n', request)).toThrow('protocol-response-json')
    expect(() => decodeAlgorithmResponse(`\ufeff${encoded}`, request)).toThrow('protocol-response-json')
    for (const [key, value] of [
      ['request_id', 'old'],
      ['run_id', 'old'],
      ['step_id', 1],
      ['input_digest', 'old'],
    ]) {
      expect(() =>
        decodeAlgorithmResponse(`${JSON.stringify({ ...response, [key as string]: value })}\n`, request),
      ).toThrow(`stale-or-invalid-worker-response: ${key}`)
    }
    expect(() => decodeAlgorithmResponse(`${JSON.stringify({ ...response, capabilities: {} })}\n`, request)).toThrow(
      'protocol-capability-mismatch',
    )
  })
  it('tears down a cancelled worker and rejects crashes and oversized output', async () => {
    const controller = new AbortController()
    const run = protocolProcess(
      [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      root,
      {},
      '',
      controller.signal,
      1024,
    )
    controller.abort()
    await expect(run).rejects.toThrow('algorithm-worker-cancelled')
    await expect(
      protocolProcess([process.execPath, '-e', 'process.exit(7)'], root, {}, '', new AbortController().signal, 1024),
    ).rejects.toThrow('algorithm-worker-failed')
    await expect(
      protocolProcess(
        [process.execPath, '-e', 'process.stdout.write("a".repeat(2048))'],
        root,
        {},
        '',
        new AbortController().signal,
        1024,
      ),
    ).rejects.toThrow('protocol-message-size')
  })
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
