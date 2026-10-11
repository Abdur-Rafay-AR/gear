export interface ErrorDetails {
  code: string
  message: string
  location?: string
  retryable: boolean
  next_action: string
  run_id?: string
  operation_id?: string
}
export class GearError extends Error {
  constructor(readonly details: ErrorDetails) {
    super(details.message)
    this.name = 'GearError'
  }
  toJSON(): ErrorDetails {
    return this.details
  }
}
export function invalid(message: string, location?: string): never {
  throw new GearError({
    code: 'invalid-configuration',
    message,
    ...(location ? { location } : {}),
    retryable: false,
    next_action: 'Correct the indicated field and run gear benchmark check again.',
  })
}

/** A provider has observed a terminal Meta operation with no usable proposal. */
export class GenerationFailed extends Error {
  constructor(readonly reason: 'process-exit' | 'missing-proposal' | 'invalid-proposal' | 'workplan-boundary') {
    super(`Meta generation failed: ${reason}`)
    this.name = 'GenerationFailed'
  }
}
