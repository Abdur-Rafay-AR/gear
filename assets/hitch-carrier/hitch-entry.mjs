import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runNative } from './run.mjs'

/** Translate Hitch's adapter invocation to the same pinned native Gear runtime. */
export async function runHitchNative(adapter) {
  if (!['pi', 'dsh'].includes(adapter)) throw new Error('Unsupported Hitch Target adapter')
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write(adapter === 'pi' ? '0.68.0\n' : '0.1.1-rc.2\n')
    return
  }
  if (adapter === 'dsh' && !process.execArgv.includes('--expose-internals')) {
    const child = spawn(process.execPath, ['--expose-internals', process.argv[1], ...args], { stdio: 'inherit' })
    const terminate = () => child.kill('SIGTERM')
    const interrupt = () => child.kill('SIGINT')
    process.on('SIGTERM', terminate)
    process.on('SIGINT', interrupt)
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => resolve(code ?? 1))
      })
    } finally {
      process.off('SIGTERM', terminate)
      process.off('SIGINT', interrupt)
    }
    return
  }
  let model, prompt
  const options = { target: join(dirname(fileURLToPath(import.meta.url)), '../target') }
  if (adapter === 'pi') {
    if (
      args[0] !== '--mode' ||
      args[1] !== 'json' ||
      args[2] !== '--no-session' ||
      args[3] !== '--model' ||
      args.length !== 5
    )
      throw new Error('Unsupported Hitch Pi invocation')
    model = args[4]
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > 1024 * 1024) throw new Error('Hitch task prompt exceeds 1 MiB')
      chunks.push(chunk)
    }
    prompt = Buffer.concat(chunks).toString('utf8')
    options.onEvent = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
  } else if (adapter === 'dsh') {
    // DSH's Hitch adapter supplies the model through a generated patch. The
    // immutable provider also binds it explicitly so no arbitrary patch is read.
    if (
      args[0] !== '--profile' ||
      args[1] !== 'headless' ||
      !args[2]?.startsWith('--gear-model=') ||
      args[3] !== '--patch' ||
      !args[4] ||
      args[5] !== '--' ||
      args[6] !== '--' ||
      args.length !== 8
    )
      throw new Error('Unsupported Hitch DSH invocation')
    model = args[2].slice('--gear-model='.length)
    prompt = args[7]
    if (!process.env.DSH_HOME) throw new Error('Hitch DSH runtime home is missing')
    options.runtimeHome = process.env.DSH_HOME
  } else throw new Error('Unsupported Hitch Target adapter')
  await runNative(adapter, model, prompt, options)
}
