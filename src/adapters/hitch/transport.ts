import { spawn } from 'node:child_process'
import { HitchEvaluationError, type ProcessResult } from './contracts.js'

export async function runHitch(
  executablePath: string,
  terminationGraceMs: number,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  maxOutputBytes: number,
): Promise<ProcessResult> {
  signal.throwIfAborted()
  return new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      cwd,
      env: {
        ...process.env,
        // Hitch controller runtimes are immutable; their Python bridge must not write .pyc files.
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let overflow: 'stdout' | 'stderr' | undefined
    let killTimer: NodeJS.Timeout | undefined
    const append = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (overflow !== undefined) return
      const chunkBytes = Buffer.byteLength(chunk)
      const currentBytes = stream === 'stdout' ? stdoutBytes : stderrBytes
      if (currentBytes + chunkBytes > maxOutputBytes) {
        overflow = stream
        terminate()
        return
      }
      if (stream === 'stdout') {
        stdoutChunks.push(chunk)
        stdoutBytes += chunkBytes
      } else {
        stderrChunks.push(chunk)
        stderrBytes += chunkBytes
      }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      append('stdout', chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      append('stderr', chunk)
    })
    const terminate = (): void => {
      if (killTimer !== undefined) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), terminationGraceMs)
    }
    signal.addEventListener('abort', terminate, { once: true })
    child.once('error', (error) => {
      signal.removeEventListener('abort', terminate)
      if (killTimer !== undefined) clearTimeout(killTimer)
      reject(new HitchEvaluationError(`failed to start Hitch CLI: ${error.message}`, 'hitch_unavailable'))
    })
    child.once('exit', (code, childSignal) => {
      signal.removeEventListener('abort', terminate)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (signal.aborted) return reject(signal.reason)
      if (overflow !== undefined) {
        return reject(
          new HitchEvaluationError(`Hitch ${overflow} exceeded ${maxOutputBytes} bytes`, 'hitch_output_overflow'),
        )
      }
      if (code === null) return reject(new HitchEvaluationError(`Hitch exited from signal ${childSignal ?? 'unknown'}`))
      resolvePromise({ stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode: code })
    })
  })
}
