/** Dependency-free validation for the generated, bounded JSON wire schema. */
export interface WireSchema {
  readonly $ref?: string
  readonly type?: string
  readonly const?: unknown
  readonly enum?: readonly unknown[]
  readonly anyOf?: readonly WireSchema[]
  readonly properties?: Readonly<Record<string, WireSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | WireSchema
  readonly items?: WireSchema
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly minItems?: number
  readonly maxItems?: number
  readonly uniqueItems?: boolean
}

function invalid(path: string): never {
  throw new TypeError(`protocol-payload-invalid: ${path}`)
}

// Validate JSON itself before schema traversal, including otherwise-open state.
// Only paths appear in errors; values may contain private algorithm state.
function jsonValue(value: unknown, path: string, depth: number, limit: number, active: Set<object>): void {
  if (depth > limit) invalid(path)
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (!value.isWellFormed()) invalid(path)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) invalid(path)
    return
  }
  if (!value || typeof value !== 'object' || active.has(value) || Object.getOwnPropertySymbols(value).length)
    invalid(path)
  active.add(value)
  if (Array.isArray(value)) {
    // Array holes and non-index properties cannot survive JSON serialization.
    if (Object.keys(value).length !== value.length) invalid(path)
    for (let i = 0; i < value.length; i++) jsonValue(value[i], `${path}[${i}]`, depth + 1, limit, active)
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) invalid(path)
    for (const [key, item] of Object.entries(value)) {
      if (!key.isWellFormed()) invalid(path)
      jsonValue(item, `${path}.*`, depth + 1, limit, active)
    }
  }
  active.delete(value)
}

function matches(value: unknown, schema: WireSchema, types: Readonly<Record<string, WireSchema>>, path: string): void {
  if (schema.$ref) {
    const target = types[schema.$ref.slice('#/$defs/'.length)]
    if (!target) invalid(path)
    matches(value, target, types, path)
    return
  }
  if ('const' in schema && value !== schema.const) invalid(path)
  if (schema.enum && !schema.enum.includes(value)) invalid(path)
  if (schema.anyOf) {
    if (
      !schema.anyOf.some((choice) => {
        try {
          matches(value, choice, types, path)
          return true
        } catch {
          return false
        }
      })
    )
      invalid(path)
    return
  }
  if (schema.type === 'null' && value !== null) invalid(path)
  if (schema.type === 'string' && (typeof value !== 'string' || [...value].length < (schema.minLength ?? 0)))
    invalid(path)
  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity)
    )
      invalid(path)
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity))
      invalid(path)
    if (schema.uniqueItems && new Set(value).size !== value.length) invalid(path)
    value.forEach((item, index) => {
      matches(item, schema.items!, types, `${path}[${index}]`)
    })
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path)
    const object = value as Record<string, unknown>
    if (schema.required?.some((key) => !Object.hasOwn(object, key))) invalid(path)
    for (const [key, item] of Object.entries(object)) {
      const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : undefined
      if (child) matches(item, child, types, `${path}.${key}`)
      else if (schema.additionalProperties === false) invalid(path)
      else if (typeof schema.additionalProperties === 'object')
        matches(item, schema.additionalProperties, types, `${path}.*`)
    }
  }
}

export function validateWire(
  value: unknown,
  name: string,
  types: Readonly<Record<string, WireSchema>>,
  maxDepth: number,
): void {
  const schema = Object.hasOwn(types, name) ? types[name] : undefined
  if (!schema) throw new TypeError('protocol-schema-unknown')
  jsonValue(value, '$', 0, maxDepth, new Set())
  matches(value, schema, types, '$')
}
