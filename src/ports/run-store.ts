export interface RunStore {
  read<T>(runId: string): Promise<T | undefined>
  write(runId: string, state: unknown): Promise<void>
  locked<T>(runId: string, operation: () => Promise<T>): Promise<T>
  cancelRequested(runId: string): Promise<boolean>
  requestCancel(runId: string): Promise<void>
}
