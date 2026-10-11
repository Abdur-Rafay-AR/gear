import {
  type AlgorithmDecision,
  type AlgorithmRequest,
  algorithmProtocol,
  validateAlgorithmResponse,
} from '../../domain/algorithm-protocol.js'
import { canonicalDigest } from '../../domain/canonical.js'

/** One newline-terminated response per step, bound to the exact request. */
export function decodeAlgorithmResponse(raw: string, request: AlgorithmRequest): AlgorithmDecision {
  if (!raw.endsWith('\n')) throw new Error('protocol-response-framing')
  if (raw.slice(0, -1).includes('\n')) throw new Error('protocol-duplicate-response')
  let response: unknown
  try {
    response = JSON.parse(raw)
  } catch {
    throw new Error('protocol-response-json')
  }
  validateAlgorithmResponse(response)
  for (const key of ['protocol_version', 'request_id', 'run_id', 'step_id', 'input_digest'] as const) {
    if (response[key] !== request[key]) throw new Error(`stale-or-invalid-worker-response: ${key}`)
  }
  if (canonicalDigest(response.capabilities) !== canonicalDigest(algorithmProtocol.capabilities))
    throw new Error('protocol-capability-mismatch')
  return response.decision
}
