import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { TaskInput } from '../../domain/benchmark.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GenerationFailed } from '../../domain/errors.js'
import type { EvaluationInput, GenerationInput, ProjectProvider, TrialResult } from '../../ports/project.js'
import { atomicJSON } from '../storage/atomic.js'

const execute = promisify(execFile)
export interface DockerProfile {
  image: string
  command: string[]
  /** Names of host environment variables, never credential values. */
  environment: string[]
  model: string
}
interface Receipt {
  kind: 'evaluation' | 'generation'
  name: string
  outputPath?: string
  inputDigest: string
}

export function validateProfile(profile: DockerProfile): void {
  if (
    !profile ||
    !/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/u.test(profile.image) ||
    !Array.isArray(profile.command) ||
    !profile.command.length ||
    profile.command.some((arg) => typeof arg !== 'string' || !arg) ||
    !Array.isArray(profile.environment) ||
    profile.environment.some((key) => !/^[A-Z][A-Z0-9_]*$/u.test(key)) ||
    typeof profile.model !== 'string' ||
    !profile.model
  )
    throw new TypeError('Profiles require a pinned image digest, command, model and environment variable names')
}

/** Docker owns the external process, allowing inspection after the Gear process exits.
 * Images supply the installed native Target/Meta CLI; no project directory is mounted.
 * The adapter makes exactly one process start per reserved operation and never retries.
 */
export class DockerProjectProvider implements ProjectProvider {
  readonly identity: string
  readonly capabilities = { meteredAttempts: true, recovery: true, isolatedTarget: true, isolatedMeta: true } as const
  constructor(
    readonly root: string,
    readonly target: DockerProfile,
    readonly meta: DockerProfile,
    readonly adapter: 'dsh' | 'pi',
  ) {
    validateProfile(target)
    validateProfile(meta)
    this.identity = canonicalDigest({ version: 1, target, meta, adapter })
  }
  private directory(id: string): string {
    if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new TypeError('invalid-operation-id')
    return join(this.root, id.slice(7))
  }
  private async docker(args: string[], signal: AbortSignal) {
    return execute('docker', args, { signal, maxBuffer: 2 * 1024 * 1024, timeout: 300_000, encoding: 'utf8' })
  }
  private async submit(
    id: string,
    receipt: Receipt,
    files: Record<string, string>,
    profile: DockerProfile,
    prompt: string,
    signal: AbortSignal,
    inputs: TaskInput[] = [],
  ): Promise<void> {
    const directory = this.directory(id)
    await mkdir(join(directory, 'target'), { recursive: true, mode: 0o700 })
    await mkdir(join(directory, 'workspace'), { recursive: true, mode: 0o700 })
    for (const [path, text] of Object.entries(files)) {
      if (
        !path ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').some((p) => p === '..' || p === '.' || !p)
      )
        throw new Error('invalid-target-path')
      await mkdir(dirname(join(directory, 'target', path)), { recursive: true })
      await writeFile(join(directory, 'target', path), text, { mode: 0o600 })
    }
    for (const input of inputs) {
      if (
        !input.path.startsWith('inputs/') ||
        !/^[a-zA-Z0-9_./-]+$/u.test(input.path) ||
        input.path.split('/').some((p) => !p || p === '.' || p === '..')
      )
        throw new Error('invalid-input-path')
      const bytes = Buffer.from(input.base64, 'base64')
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== input.digest)
        throw new Error('input-digest-mismatch')
      await mkdir(dirname(join(directory, 'workspace', input.path)), { recursive: true })
      await writeFile(join(directory, 'workspace', input.path), bytes, { mode: 0o600 })
    }
    await atomicJSON(join(directory, 'receipt.json'), receipt)
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of profile.environment)
      if (!process.env[name]) throw new Error(`Missing authentication environment variable: ${name}`)
    // Passing only names keeps credential values out of argv, receipts and locks.
    const args = [
      'create',
      '--name',
      receipt.name,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=256',
      '--memory=2g',
      '--cpus=2',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=256m',
      '--workdir',
      '/app',
      '--mount',
      `type=bind,src=${join(directory, 'workspace')},dst=/app`,
      '--mount',
      `type=bind,src=${join(directory, 'target')},dst=/target,readonly`,
      '--env',
      'HOME=/tmp/agent-home',
      ...(receipt.kind === 'evaluation'
        ? ['--env', `${this.adapter === 'pi' ? 'PI_CODING_AGENT_DIR' : 'DSH_HOME'}=/target`]
        : []),
      ...profile.environment.flatMap((name) => ['--env', name]),
      profile.image,
      ...profile.command.map((arg) => arg.replaceAll('{model}', profile.model)),
      prompt,
    ]
    await execute('docker', args, { env, signal, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60_000 })
    // start is issued once; an interrupted connection leaves the durable container inspectable.
    await this.docker(['start', receipt.name], signal)
    await this.docker(['wait', receipt.name], signal)
  }
  private async receipt(
    id: string,
    signal: AbortSignal,
  ): Promise<{ receipt: Receipt; exitCode: number; logs: string } | undefined> {
    let receipt: Receipt
    try {
      receipt = JSON.parse(await readFile(join(this.directory(id), 'receipt.json'), 'utf8')) as Receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let observation: { Status: string; ExitCode: number }
    try {
      observation = JSON.parse(
        (await this.docker(['inspect', '--format', '{{json .State}}', receipt.name], signal)).stdout,
      ) as typeof observation
    } catch {
      return undefined
    }
    if (observation.Status !== 'exited') return undefined
    const logs = (await this.docker(['logs', receipt.name], signal)).stdout
    return { receipt, exitCode: observation.ExitCode, logs }
  }
  async evaluate(input: EvaluationInput, signal: AbortSignal): Promise<TrialResult> {
    const name = `gear-${input.operationId.slice(7, 39)}`
    const receipt: Receipt = {
      kind: 'evaluation',
      name,
      outputPath: input.task.outputPath,
      inputDigest: canonicalDigest(input),
    }
    const prompt = `${input.task.instruction}${input.task.inputs?.length ? `\nInput files: ${input.task.inputs.map((f) => `/app/${f.path}`).join(', ')}` : ''}\nWrite the final answer to ${input.task.outputPath}.`
    await this.submit(input.operationId, receipt, input.target.files, this.target, prompt, signal, input.task.inputs)
    const result = await this.inspectEvaluation(input.operationId, signal)
    if (!result) throw new Error('Evaluation has not settled; resume to inspect it')
    return result
  }
  async inspectEvaluation(id: string, signal: AbortSignal): Promise<TrialResult | undefined> {
    const state = await this.receipt(id, signal)
    if (!state) return undefined
    if (state.receipt.kind !== 'evaluation') throw new Error('operation-kind-mismatch')
    if (state.exitCode !== 0)
      return { status: 'infrastructure-failed', physicalAttempts: 1, reason: `Target process exited ${state.exitCode}` }
    const outputPath = state.receipt.outputPath!
    if (!outputPath.startsWith('/app/') || outputPath.split('/').includes('..')) throw new Error('invalid-output-path')
    try {
      const { lstat } = await import('node:fs/promises')
      const parts = outputPath.slice('/app/'.length).split('/')
      let local = join(this.directory(id), 'workspace')
      for (const [index, part] of parts.entries()) {
        local = join(local, part)
        const info = await lstat(local)
        if (
          info.isSymbolicLink() ||
          (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink > 1 || info.size > 1024 * 1024)
        )
          throw new Error('unsafe-output-file')
      }
      return {
        status: 'completed',
        physicalAttempts: 1,
        output: new TextDecoder('utf-8', { fatal: true }).decode(await readFile(local)),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { status: 'task-failed', physicalAttempts: 1, reason: 'Target did not create its requested output' }
      return { status: 'scorer-failed', physicalAttempts: 1, reason: 'Output could not be read safely' }
    }
  }
  async generate(input: GenerationInput, signal: AbortSignal): Promise<Record<string, string>> {
    const receipt: Receipt = {
      kind: 'generation',
      name: `gear-${input.operationId.slice(7, 39)}`,
      inputDigest: canonicalDigest(input),
    }
    const prompt = `Improve the ${this.adapter} Target using these seed observations. When a workplan is provided, address its hypothesis and restrict every addition, edit and deletion to its modification_paths. Write /app/candidate.json containing a JSON object mapping every candidate relative file path to its complete text, including unchanged files. Do not include credentials or dependencies.\n${JSON.stringify({ files: input.parent.files, seed: input.seed, diagnosisId: input.diagnosisId, diagnosis: input.diagnosis, delivery: input.delivery })}`
    await this.submit(input.operationId, receipt, input.parent.files, this.meta, prompt, signal)
    const files = await this.inspectGeneration(input.operationId, signal)
    if (!files) throw new Error('Generation has not settled; resume to inspect it')
    return files
  }
  async inspectGeneration(id: string, signal: AbortSignal): Promise<Record<string, string> | undefined> {
    const state = await this.receipt(id, signal)
    if (!state) return undefined
    if (state.receipt.kind !== 'generation') throw new Error('operation-kind-mismatch')
    if (state.exitCode !== 0) throw new GenerationFailed('process-exit')
    const path = join(this.directory(id), 'workspace/candidate.json')
    const { lstat } = await import('node:fs/promises')
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 1024 * 1024)
        throw new GenerationFailed('invalid-proposal')
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, string>
    } catch (error) {
      if (error instanceof SyntaxError) throw new GenerationFailed('invalid-proposal')
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GenerationFailed('missing-proposal')
      throw error
    }
  }
  async cancel(id: string, signal: AbortSignal): Promise<void> {
    let receipt: Receipt
    try {
      receipt = JSON.parse(await readFile(join(this.directory(id), 'receipt.json'), 'utf8')) as Receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const state = await this.docker(
      ['ps', '-a', '--filter', `name=^/${receipt.name}$`, '--format', '{{.Names}}'],
      signal,
    )
    if (state.stdout.trim() === receipt.name) await this.docker(['stop', '--time', '10', receipt.name], signal)
  }
}
