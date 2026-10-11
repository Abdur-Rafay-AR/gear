import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = JSON.parse(await readFile(resolve(root, 'contracts/algorithm-v1.json'), 'utf8'))
const { $defs: definitions, ...metadata } = source
const reference = (node) => node.$ref?.replace('#/$defs/', '')
function flatten(node) {
  if (!node.allOf) return node
  assert.deepEqual(Object.keys(node).sort(), ['allOf', 'unevaluatedProperties'])
  assert.equal(node.unevaluatedProperties, false)
  const properties = {},
    required = []
  for (const component of node.allOf) {
    const part = component.$ref ? definitions[reference(component)] : component
    assert.equal(part.type, 'object')
    assert.deepEqual(Object.keys(part).sort(), ['properties', 'required', 'type'])
    for (const [key, value] of Object.entries(part.properties)) {
      assert.ok(!Object.hasOwn(properties, key), `Conflicting inherited field ${key}`)
      properties[key] = value
    }
    required.push(...part.required)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}
const types = Object.fromEntries(Object.entries(definitions).map(([name, node]) => [name, flatten(node)]))
// This is intentionally a small schema compiler, not a permissive JSON Schema
// interpreter. New keywords must be implemented in BOTH runtimes before use.
const keywords = new Set([
  '$ref',
  'type',
  'const',
  'enum',
  'anyOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'minLength',
  'minItems',
  'maxItems',
  'uniqueItems',
])
function check(node) {
  for (const key of Object.keys(node)) assert.ok(keywords.has(key), `Unsupported schema keyword ${key}`)
  if (node.$ref) {
    assert.ok(node.$ref.startsWith('#/$defs/'))
    assert.ok(Object.hasOwn(types, reference(node)), `Unknown schema reference ${node.$ref}`)
  }
  if (node.type) assert.ok(['object', 'array', 'string', 'number', 'integer', 'null'].includes(node.type))
  if (node.enum) assert.ok(node.enum.length && node.enum.every((v) => typeof v === 'string'))
  if ('const' in node) assert.ok(typeof node.const === 'number' && Number.isSafeInteger(node.const))
  if (node.uniqueItems) assert.equal(node.items.type, 'string', 'Uniqueness supports scalar string arrays only')
  if (node.properties) {
    for (const key of node.required) assert.ok(Object.hasOwn(node.properties, key))
    Object.values(node.properties).forEach(check)
  }
  if (typeof node.additionalProperties === 'object') check(node.additionalProperties)
  if (node.items) check(node.items)
  node.anyOf?.forEach(check)
}
Object.values(types).forEach(check)
assert.deepEqual(metadata.capabilities.operations, types.OperationKind.enum)
assert.equal(metadata.protocolVersion, types.ProtocolEnvelope.properties.protocol_version.const)
assert.equal(metadata.maxBytes, metadata.capabilities.max_message_bytes)
assert.equal(metadata.canonicalVersion, metadata.capabilities.canonical_version)
assert.ok(Number.isSafeInteger(metadata.capabilities.max_json_depth) && metadata.capabilities.max_json_depth > 0)
const schema = {
  ...metadata,
  requestFields: types.AlgorithmRequest.required,
  responseFields: types.AlgorithmResponse.required,
  operations: types.OperationKind.enum,
  types,
}
function tsType(node) {
  if (node.$ref) return reference(node)
  if ('const' in node) return JSON.stringify(node.const)
  if (node.enum) return node.enum.map(JSON.stringify).join(' | ')
  if (node.anyOf) return node.anyOf.map(tsType).join(' | ')
  if (node.type === 'array') return `Array<${tsType(node.items)}>`
  if (node.type === 'object') {
    if (!node.properties)
      return `Record<string, ${typeof node.additionalProperties === 'object' ? tsType(node.additionalProperties) : 'unknown'}>`
    return `{ ${Object.entries(node.properties)
      .map(([key, value]) => `${key}${node.required.includes(key) ? '' : '?'}: ${tsType(value)}`)
      .join('; ')} }`
  }
  return { integer: 'number', number: 'number', string: 'string', null: 'null' }[node.type] ?? 'unknown'
}
function pyType(node) {
  if (node.$ref) return reference(node)
  if ('const' in node) return `Literal[${node.const}]`
  if (node.enum) return `Literal[${node.enum.map(JSON.stringify).join(', ')}]`
  if (node.anyOf) return node.anyOf.map(pyType).join(' | ')
  if (node.type === 'array') return `list[${pyType(node.items)}]`
  if (node.type === 'object') {
    assert.ok(!node.properties, 'Nested named objects must use a reference')
    return `dict[str, ${typeof node.additionalProperties === 'object' ? pyType(node.additionalProperties) : 'Any'}]`
  }
  return { integer: 'int', number: 'float', string: 'str', null: 'None' }[node.type] ?? 'Any'
}
const snake = (name) => name.replace(/[A-Z]/g, (c, i) => `${i ? '_' : ''}${c.toLowerCase()}`)
function pyDefinition(name, node) {
  if (!node.properties) return `${name} = ${pyType(node)}\n`
  const optional = Object.keys(node.properties).filter((key) => !node.required.includes(key))
  const fields = (keys) => keys.map((key) => `    ${key}: ${pyType(node.properties[key])}`).join('\n') || '    pass'
  if (!optional.length) return `class ${name}(TypedDict):\n${fields(node.required)}\n`
  return `class _${name}Required(TypedDict):\n${fields(node.required)}\n\nclass ${name}(_${name}Required, total=False):\n${fields(optional)}\n`
}
const outputs = {
  'src/domain/algorithm-protocol.ts': `// Generated by scripts/generate-project-protocol.mjs.\nimport { validateWire } from './wire-validation.js'\n\nexport const algorithmProtocol = ${JSON.stringify(schema, null, 2)} as const\n\n${Object.entries(
    types,
  )
    .map(([name, node]) => `export type ${name} = ${tsType(node)}`)
    .join(
      '\n',
    )}\n\nexport function validateWireType(name: keyof typeof algorithmProtocol.types, value: unknown): void {\n  validateWire(value, name, algorithmProtocol.types, algorithmProtocol.capabilities.max_json_depth)\n}\n\n${Object.keys(
    types,
  )
    .map(
      (name) =>
        `export function validate${name}(value: unknown): asserts value is ${name} {\n  validateWireType('${name}', value)\n}`,
    )
    .join('\n\n')}\n`,
  'python/gear/_protocol/generated.py': `# Generated by scripts/generate-project-protocol.mjs.\nfrom __future__ import annotations\n\nimport json\nfrom typing import Any, Literal, TypedDict, cast\n\nfrom .validation import validate_wire\n\nPROTOCOL = json.loads(${JSON.stringify(JSON.stringify(schema))})\n\n${Object.entries(
    types,
  )
    .map(([name, node]) => pyDefinition(name, node))
    .join(
      '\n',
    )}\ndef validate_wire_type(name: str, value: Any) -> None:\n    validate_wire(value, name, PROTOCOL['types'], PROTOCOL['capabilities']['max_json_depth'])\n\n${Object.keys(
    types,
  )
    .map(
      (name) =>
        `def validate_${snake(name)}(value: Any) -> ${name}:\n    validate_wire_type('${name}', value)\n    return cast(${name}, value)\n`,
    )
    .join('\n')}`,
}
for (const [path, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if ((await readFile(resolve(root, path), 'utf8')) !== content) throw new Error(`Regenerate ${path}`)
  } else await writeFile(resolve(root, path), content)
}
