import type { MutationPolicy } from '../ports/harness.js'
import { MutationValidationError, SubstrateExpansionError } from './harness.js'

export const protectedArtifactNames = Object.freeze([
  'manifest.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  '.git',
  'auth.json',
  '.env',
])

export function validateArtifactPath(path: string, policy: MutationPolicy): string {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) {
    throw new MutationValidationError(`artifact path must be a non-empty POSIX relative path: ${path}`)
  }
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new MutationValidationError(`artifact path escapes or is not normalized: ${path}`)
  }
  if (!policy.roots.includes(parts[0]!)) throw new SubstrateExpansionError(`artifact root is fixed substrate: ${path}`)
  if (parts.some((part) => policy.protectedNames.includes(part)))
    throw new SubstrateExpansionError(`artifact path is protected: ${path}`)
  return path
}
