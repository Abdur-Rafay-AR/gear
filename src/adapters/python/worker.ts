import { execFile } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { AlgorithmDecision, AlgorithmWorker, SearchView } from '../../domain/algorithm.js'
import { type AlgorithmRequest, algorithmProtocol } from '../../domain/algorithm-protocol.js'
import { canonicalDigest } from '../../domain/canonical.js'
import {
  acquireAirGappedSandbox,
  assertAirGappedSandboxActive,
  createAirGappedSandboxConfig,
  sandboxSystemReadPaths,
} from '../../sandbox.js'
import { protocolProcess } from './process.js'

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const source = fileURLToPath(new URL('../../../python/gear', import.meta.url))
async function identityFiles(root: string, prefix = ''): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = []
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (item.name === '__pycache__') continue
    const name = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isSymbolicLink()) throw new Error('Algorithm source cannot contain symlinks')
    if (item.isDirectory()) result.push(...(await identityFiles(root, name)))
    else if (item.isFile() && name.endsWith('.py'))
      result.push([name, (await readFile(join(root, name))).toString('utf8')])
  }
  return result
}
export async function createPythonWorker(
  python: string,
  custom?: { source: string; entrypoint: string },
): Promise<AlgorithmWorker> {
  const executable = join(await realpath(dirname(python)), basename(python))
  const canonicalExecutable = await realpath(python)
  const plugin = custom ? await identityFiles(custom.source) : []
  if (
    plugin.length > 256 ||
    plugin.some(([name]) => ['gear', 'gear_training'].includes(name.split('/')[0]!.replace(/\.py$/u, '')))
  )
    throw new Error('Invalid algorithm source namespace or size')
  if (plugin.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0) > 1024 * 1024)
    throw new Error('Algorithm source exceeds 1 MiB')
  const runtime = (
    await promisify(execFile)(executable, [
      '-c',
      'import sys,importlib.metadata,json; print(json.dumps([sys.version,sorted((d.metadata["Name"],d.version) for d in importlib.metadata.distributions())]))',
    ])
  ).stdout
  const implementation = {
    protocol: 1,
    files: await identityFiles(source),
    plugin,
    entrypoint: custom?.entrypoint ?? 'gear.algorithms:GEPA',
    runtime,
  }
  const identity = canonicalDigest(implementation)
  return {
    identity,
    async step(view: SearchView, state, context, signal): Promise<AlgorithmDecision> {
      const scratch = await realpath(await mkdtemp(join(tmpdir(), 'gear-algorithm-')))
      let lease: Awaited<ReturnType<typeof acquireAirGappedSandbox>> | undefined
      try {
        lease = await acquireAirGappedSandbox(undefined, 'Python algorithm worker')
        await cp(source, join(scratch, 'code/gear'), {
          recursive: true,
          filter: (path) => !path.includes('__pycache__'),
        })
        if (canonicalDigest({ ...implementation, files: await identityFiles(join(scratch, 'code/gear')) }) !== identity)
          throw new Error('Algorithm source changed; start a new run')
        if (custom) {
          const { mkdir, writeFile } = await import('node:fs/promises')
          for (const [path, text] of plugin) {
            await mkdir(dirname(join(scratch, 'code', path)), { recursive: true })
            await writeFile(join(scratch, 'code', path), text, { flag: 'wx' })
          }
          if (canonicalDigest(await identityFiles(custom.source)) !== canonicalDigest(plugin))
            throw new Error('Algorithm source changed; start a new run')
        }
        const payload = { view, state }
        const request: AlgorithmRequest = {
          capabilities: algorithmProtocol.capabilities,
          protocol_version: 1,
          request_id: crypto.randomUUID(),
          run_id: context.runId,
          step_id: context.stepId,
          input_digest: canonicalDigest(payload),
          input: payload,
        }
        const policy = await createAirGappedSandboxConfig({
          allowRead: [
            ...sandboxSystemReadPaths(),
            ...(process.platform === 'darwin'
              ? ['/opt/homebrew/opt', '/opt/homebrew/Cellar', '/opt/homebrew/etc/openssl@3']
              : []),
            dirname(dirname(executable)),
            dirname(dirname(canonicalExecutable)),
            join(scratch, 'code'),
          ],
          allowWrite: [],
          denyRead: ['/'],
        })
        assertAirGappedSandboxActive(policy)
        const wrapped = await SandboxManager.wrapWithSandboxArgv(
          [executable, '-B', '-m', 'gear._protocol.worker', ...(custom ? [custom.entrypoint] : [])]
            .map(quote)
            .join(' '),
          '/bin/bash',
          policy,
        )
        const raw = await protocolProcess(
          [...wrapped.argv],
          join(scratch, 'code'),
          {
            PATH: '/usr/bin:/bin',
            PYTHONPATH: join(scratch, 'code'),
            PYTHONNOUSERSITE: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            HOME: scratch,
          },
          `${JSON.stringify(request)}\n`,
          signal,
          algorithmProtocol.maxBytes,
        )
        const response = JSON.parse(raw) as Record<string, unknown>
        if (
          !response ||
          Array.isArray(response) ||
          Object.keys(response).sort().join() !== [...algorithmProtocol.responseFields].sort().join()
        )
          throw new Error('protocol-response-fields')
        for (const key of ['protocol_version', 'request_id', 'run_id', 'step_id', 'input_digest'] as const) {
          if (response[key] !== request[key]) throw new Error(`stale-or-invalid-worker-response: ${key}`)
        }
        if (canonicalDigest(response.capabilities) !== canonicalDigest(algorithmProtocol.capabilities))
          throw new Error('protocol-capability-mismatch')
        return response.decision as AlgorithmDecision
      } finally {
        SandboxManager.cleanupAfterCommand()
        await lease?.release()
        await rm(scratch, { recursive: true, force: true })
      }
    },
  }
}
