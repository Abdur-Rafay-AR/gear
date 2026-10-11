import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const rules = {
  capabilities: ['application', 'runtime', 'adapters', 'training'],
  domain: ['application', 'runtime', 'adapters', 'training', 'types.ts'],
  ports: ['application', 'runtime', 'adapters', 'training', 'types.ts'],
  runtime: ['application', 'adapters', 'training', 'types.ts'],
}
async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await files(path)))
    else if (path.endsWith('.ts')) result.push(path)
  }
  return result
}
const graph = new Map(),
  errors = []
for (const file of await files(join(root, 'src'))) {
  const name = relative(join(root, 'src'), file),
    layer = name.split('/')[0]
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest)
  const edges = []
  for (const node of source.statements) {
    if (
      (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) ||
      !node.moduleSpecifier ||
      !ts.isStringLiteral(node.moduleSpecifier)
    )
      continue
    const specifier = node.moduleSpecifier.text
    if (!specifier.startsWith('.')) continue
    const target = relative(join(root, 'src'), resolve(dirname(file), specifier)).replace(/\.js$/, '.ts')
    if (rules[layer]?.includes(target.split('/')[0])) errors.push(`${name} imports forbidden dependency ${target}`)
    const typeOnly = node.isTypeOnly || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
    if (!typeOnly) edges.push(target)
  }
  graph.set(name, edges)
}
const active = new Set(),
  visited = new Set()
function visit(name, path = []) {
  if (active.has(name)) {
    const cycle = [...path.slice(path.indexOf(name)), name]
    if (cycle.some((file) => /^(domain|ports|runtime|adapters|application|capabilities)\//.test(file)))
      errors.push(`New runtime cycle: ${cycle.join(' -> ')}`)
    return
  }
  if (visited.has(name)) return
  active.add(name)
  for (const target of graph.get(name) ?? []) visit(target, [...path, name])
  active.delete(name)
  visited.add(name)
}
for (const name of graph.keys()) visit(name)
if (errors.length) {
  console.error([...new Set(errors)].join('\n'))
  process.exitCode = 1
} else console.log(`Checked ${graph.size} modules: new-layer dependencies and runtime cycles passed.`)
