import type { ErrorDetails } from '../domain/errors.js'

/** Human output is separate from the stable JSON interface used by SDK/Skill. */
export function renderProjectResult(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value)
  const result = value as Record<string, unknown>
  const lines: string[] = []
  if (typeof result.usage === 'string') return result.usage
  if (typeof result.run_id === 'string' && Array.isArray(result.candidates)) {
    lines.push(`Run ${result.run_id}: ${result.status}`, `Retained Target: ${result.champion}`)
    if (result.notice) lines.push(String(result.notice))
    for (const candidate of result.candidates as Array<{
      id: string
      partitions: Array<{
        split: string
        passRate: number | null
        valid: number
        planned: number
        validZero: number
        invalid: number
        missing: number
      }>
    }>) {
      lines.push(`\n${candidate.id}`)
      for (const score of candidate.partitions) {
        if (!score.planned) continue
        const rate = score.passRate === null ? 'unavailable' : `${(score.passRate * 100).toFixed(1)}%`
        lines.push(
          `  ${score.split}: ${rate}; valid ${score.valid}/${score.planned}, zero ${score.validZero}, invalid ${score.invalid}, missing ${score.missing}`,
        )
      }
    }
    lines.push(
      `\nPhysical attempts: ${result.physicalAttempts}/${result.maxEvaluations}; still reserved: ${result.reservedAttempts}`,
    )
    lines.push(
      `Generation attempts: ${result.generationAttempts}; invalid proposals: ${Array.isArray(result.invalidCandidates) ? result.invalidCandidates.length : 0}`,
    )
    if (Array.isArray(result.changes))
      lines.push(`Changed files: ${result.changes.map((file: { path: string }) => file.path).join(', ') || 'none'}`)
  } else if (Array.isArray(result.checks)) {
    lines.push(result.ready ? 'Environment ready for a smoke evaluation.' : 'Environment needs attention.')
    for (const check of result.checks as Array<{ name: string; ready: boolean; detail: string }>)
      lines.push(`${check.ready ? 'OK' : 'Required'} ${check.name}: ${check.detail}`)
  } else if (result.ok === true && Array.isArray(result.tasks)) {
    lines.push('Benchmark static checks and scorer fixtures passed. Target execution has not run.')
    for (const task of result.tasks as Array<{
      id: string
      split: string
      instruction: string
      scorer: unknown
      fixtures: unknown
    }>)
      lines.push(
        `\n${task.id} [${task.split}]\n  ${task.instruction}\n  Scorer: ${JSON.stringify(task.scorer)}\n  Fixtures: ${JSON.stringify(task.fixtures)}`,
      )
    lines.push('\nNext: gear evaluate --split seed --limit 1')
  } else {
    for (const [key, item] of Object.entries(result)) {
      if (key === 'next_action') continue
      lines.push(`${key}: ${typeof item === 'string' ? item : JSON.stringify(item, null, 2)}`)
    }
  }
  if (result.next_action) lines.push(`\nNext: ${result.next_action}`)
  return lines.join('\n')
}

export function renderProjectError(error: ErrorDetails): string {
  return `${error.message} [${error.code}]${error.location ? `\nLocation: ${error.location}` : ''}${error.run_id ? `\nRun: ${error.run_id}` : ''}\nNext: ${error.next_action}`
}
