import { spawn } from 'node:child_process'

/** Wait for process-group teardown before releasing the sandbox lease. */
export async function protocolProcess(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  signal.throwIfAborted()
  if (Buffer.byteLength(input) > maxBytes) throw new Error('protocol-message-size')
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let failure: Error | undefined,
      bytes = 0
    const kill = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error
      }
    }
    const abort = () => {
      failure = new Error('algorithm-worker-cancelled')
      kill()
    }
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      failure = new Error('algorithm-worker-timeout')
      kill()
    }, 30_000)
    let diagnostics = ''
    child.stderr.on('data', (chunk: Buffer) => {
      if (diagnostics.length < 4096) diagnostics += chunk.toString('utf8')
    })
    child.stdin.on('error', () => {})
    child.once('error', (error) => {
      failure = error
    })
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        failure = new Error('protocol-message-size')
        kill()
      } else chunks.push(chunk)
    })
    // A worker may leave descendants holding stdio open. Kill the group as soon
    // as its leader exits, then wait for close before removing its scratch tree.
    child.once('exit', kill)
    child.once('close', (code) => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (failure || code !== 0) reject(failure ?? new Error(`algorithm-worker-failed: ${diagnostics.slice(0, 4096)}`))
      else {
        try {
          resolve(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)))
        } catch {
          reject(new Error('protocol-invalid-utf8'))
        }
      }
    })
    if (signal.aborted) abort()
    child.stdin.end(input)
  })
}
