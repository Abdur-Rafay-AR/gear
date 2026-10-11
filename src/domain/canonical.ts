import { createHash } from 'node:crypto'

/** v1 is explicitly distinct from all historical Gear digest formats. */
function normalized(value: unknown): unknown {
  if (value === null) return ['null']
  if (typeof value === 'boolean') return ['bool', value ? 'true' : 'false']
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new TypeError('canonical strings must be well-formed Unicode')
    return ['string', value]
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new TypeError('canonical number out of range')
    const bytes = Buffer.alloc(8)
    bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value)
    return ['number', bytes.toString('hex')]
  }
  if (Array.isArray(value)) return ['array', value.map(normalized)]
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    return ['object', entries.map(([key, item]) => [normalized(key), normalized(item)])]
  }
  throw new TypeError('canonical value must be JSON data')
}
export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update('gear-canonical-v1\0')
    .update(JSON.stringify(normalized(value)))
    .digest('hex')}`
}
