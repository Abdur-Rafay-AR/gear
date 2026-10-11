import type { BenchmarkSpec } from '../domain/benchmark.js'
import { GearError } from '../domain/errors.js'
import { validateHarborTask } from '../domain/harbor.js'
import type { ProjectProvider } from '../ports/project.js'

export function admitHarbor(benchmark: BenchmarkSpec, provider: ProjectProvider): void {
  for (const task of benchmark.tasks) {
    if (task.scorer.kind !== 'harbor' && !task.harbor) continue
    if (task.scorer.kind !== 'harbor' || !task.harbor || task.scorer.taskDigest !== task.harbor.digest)
      throw new TypeError('harbor-task-scorer-mismatch')
    validateHarborTask(task.harbor)
    if (provider.capabilities.harborVerification !== true)
      throw new GearError({
        code: 'harbor-provider-required',
        message:
          'Harbor tasks require an execution provider that preserves their environment and isolates their verifier',
        retryable: false,
        next_action: 'Configure a Harbor-capable provider; benchmark compile can export the frozen tasks for Hitch.',
      })
  }
}
