#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testProjectAlgorithm } from '../application/algorithm-test.js'
import { doctor, setup } from '../application/environment.js'
import { ProjectApplication, targetAdapter } from '../application/project.js'
import { readProject, resolveProjectAlgorithm } from '../application/project-config.js'
import { initProject } from '../application/project-init.js'
import { GearError, invalid } from '../domain/errors.js'
import { renderProjectError, renderProjectResult } from './project-output.js'

const usage =
  'gear setup | doctor | init DIRECTORY [--adapter dsh|pi] [--template text|json|file|harbor] [--from SOURCE] [--manifest SPLITS.csv|SPLITS.jsonl] [--validation holdout|research] | benchmark check|compile | algorithm test MODULE:FACTORY [--source DIRECTORY] [--kind auto|algorithm|parent] | evaluate [--split seed|held_out] [--limit N] | refine [--rounds N] [--algorithm-source DIRECTORY --algorithm-entrypoint MODULE:FACTORY] | report [RUN_ID] | resume|cancel|export RUN_ID | config explain'
export async function projectCommand(argv: string[], cwd = process.cwd()): Promise<unknown> {
  const args = argv.filter((arg) => arg !== '--json')
  if (!args.length || args[0] === '--help' || args[0] === 'help') return { usage }
  const options = new Map<string, string>(),
    positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      if (options.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('--'))
        invalid(`Missing or duplicate option ${arg}`)
      options.set(arg, args[++i]!)
    } else positional.push(arg)
  }
  const [command, sub, ...extra] = positional
  if (extra.length && !(command === 'algorithm' && sub === 'test' && extra.length === 1))
    invalid('Unexpected positional arguments')
  const allowed: Record<string, string[]> = {
    init: ['--adapter', '--template', '--from', '--manifest', '--validation', '--target-profile', '--meta-profile'],
    setup: ['--profiles', '--native', '--model'],
    evaluate: ['--split', '--limit', '--view'],
    refine: ['--rounds', '--view', '--algorithm-source', '--algorithm-entrypoint'],
    benchmark: ['--view'],
    algorithm: ['--source', '--kind'],
    report: ['--view'],
    resume: ['--view'],
  }
  for (const option of options.keys())
    if (!(allowed[command!] ?? []).includes(option)) invalid(`Unknown option ${option} for ${command}`)
  const positive = (name: string): number | undefined => {
    const value = options.get(name)
    if (value === undefined) return undefined
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
      invalid(`${name} requires a positive integer`)
    return Number(value)
  }
  const view = options.get('--view') ?? 'operator'
  if (view !== 'operator' && view !== 'meta') invalid('--view must be operator or meta')
  const app = new ProjectApplication(cwd)
  if (command === 'algorithm' && sub === 'test') {
    if (!extra[0]) invalid('algorithm test requires module:factory or module:parent_policy')
    return testProjectAlgorithm(extra[0], resolve(cwd, options.get('--source') ?? '.'), options.get('--kind'))
  }
  if (command === 'init') {
    if (!sub) invalid('init requires a directory')
    const adapter = options.get('--adapter') ?? 'dsh',
      template = options.get('--template') ?? 'text'
    if (adapter !== 'dsh' && adapter !== 'pi') invalid('adapter must be dsh or pi')
    if (template !== 'text' && template !== 'json' && template !== 'file' && template !== 'harbor')
      invalid('template must be text, json, file or harbor')
    const validation = options.get('--validation') ?? 'holdout'
    if (validation !== 'holdout' && validation !== 'research') invalid('validation must be holdout or research')
    return initProject(resolve(cwd, sub), targetAdapter(adapter), template, {
      ...(options.has('--from') ? { source: resolve(cwd, options.get('--from')!) } : {}),
      ...(options.has('--manifest') ? { manifest: resolve(cwd, options.get('--manifest')!) } : {}),
      validation,
      ...(options.has('--target-profile') ? { targetProfile: options.get('--target-profile')! } : {}),
      ...(options.has('--meta-profile') ? { metaProfile: options.get('--meta-profile')! } : {}),
    })
  }
  if (command === 'benchmark' && sub === 'check') return app.check(view)
  if (command === 'benchmark' && sub === 'compile') {
    if (view === 'meta') invalid('Benchmark export is an operator operation')
    return app.compile()
  }
  if (command === 'config' && sub === 'explain')
    return {
      project: await readProject(cwd),
      precedence: ['template defaults', 'gear.yaml', 'explicit CLI options'],
      resume: 'frozen run plan',
    }
  if (command === 'report') return app.report(sub, view)
  if (['resume', 'cancel', 'export'].includes(command!)) {
    if (!sub) invalid(`${command} requires RUN_ID`)
    if (command === 'resume') return app.resume(sub, new AbortController().signal, view)
    if (command === 'cancel') return app.cancel(sub)
    return app.export(sub)
  }
  if (sub) invalid(`Unexpected argument ${sub}`)
  if (command === 'doctor') return doctor()
  if (command === 'setup') {
    const adapter = options.get('--native'),
      model = options.get('--model')
    if (adapter !== undefined && adapter !== 'dsh' && adapter !== 'pi') invalid('--native must be dsh or pi')
    if (adapter && (!model || options.has('--profiles')))
      invalid('--native requires --model and cannot be combined with --profiles')
    if (model && !adapter) invalid('--model requires --native')
    return setup(options.get('--profiles'), adapter ? { adapter, model: model! } : undefined)
  }
  if (command === 'evaluate' || command === 'refine') {
    const split = options.get('--split') ?? 'seed'
    if (split !== 'seed' && split !== 'held_out') invalid('split must be seed or held_out')
    const limit = positive('--limit'),
      rounds = positive('--rounds')
    const source = options.get('--algorithm-source'),
      entrypoint = options.get('--algorithm-entrypoint')
    if ((source === undefined) !== (entrypoint === undefined))
      invalid('--algorithm-source and --algorithm-entrypoint must be supplied together')
    const algorithm = source === undefined ? undefined : resolveProjectAlgorithm({ source, entrypoint }, cwd)
    return app.run(
      command,
      {
        split,
        view,
        ...(limit === undefined ? {} : { limit }),
        ...(rounds === undefined ? {} : { rounds }),
        ...(algorithm === undefined ? {} : { algorithm }),
      },
      new AbortController().signal,
    )
  }
  return invalid(usage)
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  projectCommand(process.argv.slice(2))
    .then((result) =>
      process.stdout.write(
        `${process.argv.includes('--json') ? JSON.stringify(result, null, 2) : renderProjectResult(result)}\n`,
      ),
    )
    .catch((error) => {
      const details =
        error instanceof GearError
          ? error.toJSON()
          : {
              code: 'operation-failed',
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
              next_action: 'Run gear doctor and inspect the indicated configuration.',
            }
      process.stderr.write(
        `${process.argv.includes('--json') ? JSON.stringify(details, null, 2) : renderProjectError(details)}\n`,
      )
      process.exitCode = 1
    })
}
