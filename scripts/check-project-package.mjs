import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const temp = await mkdtemp(join(tmpdir(), 'gear-published-project-'))
const run = (command, args, cwd = temp, env = {}) =>
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  })
try {
  const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
  const version = JSON.parse(
    run(python, ['-I', '-c', 'import json,sys; print(json.dumps(list(sys.version_info[:2])))']),
  )
  assert.ok(
    version[0] > 3 || (version[0] === 3 && version[1] >= 10),
    `Python >= 3.10 is required; found ${version.join('.')}. Set GEAR_TRAINING_TEST_PYTHON to a supported interpreter.`,
  )
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], root))[0]
  await writeFile(
    join(temp, 'package.json'),
    JSON.stringify({ name: 'external-project-consumer', private: true, type: 'module' }),
  )
  run('npm', ['install', '--ignore-scripts', '--omit=optional', join(temp, packed.filename)])
  const cli = join(temp, 'node_modules/rsi-gear/lib/cli/project.js')
  for (const adapter of ['dsh', 'pi']) {
    for (const template of ['text', 'json', 'file']) {
      const project = join(temp, `${adapter}-${template}`)
      run(process.execPath, [cli, 'init', project, '--adapter', adapter, '--template', template])
      assert.equal(JSON.parse(run(process.execPath, [cli, 'benchmark', 'check', '--json'], project)).ok, true)
      assert.match(
        run(process.execPath, [cli, 'benchmark', 'check'], project),
        /Benchmark static checks and scorer fixtures passed/,
      )
      assert.match(
        JSON.parse(run(process.execPath, [cli, 'benchmark', 'compile', '--json'], project)).digest,
        /^sha256:/,
      )
    }
  }
  await writeFile(
    join(temp, 'journey.mjs'),
    `
    import assert from 'node:assert/strict'
    import {readFile,writeFile} from 'node:fs/promises'
    import {ProjectApplication} from 'rsi-gear/project'
    const results=new Map(),generations=new Map()
    const provider={identity:'isolated-fixture-v1',capabilities:{meteredAttempts:true,recovery:true,isolatedMeta:true,isolatedTarget:true},
      async evaluate(input){ const output=input.target.id==='initial'?'wrong':input.task.instruction.includes('2 plus 3')?'5':input.task.instruction.includes('4 plus 5')?'9':'APPLE'; const r={status:'completed',physicalAttempts:1,output}; results.set(input.operationId,r); return r },
      async inspectEvaluation(id){return results.get(id)}, async generate(input){generations.set(input.operationId,input.parent.files); return input.parent.files}, async inspectGeneration(id){return generations.get(id)}, async cancel(){} }
    const algorithm={identity:'public-algorithm-fixture-v1',async step(view,state){ const n=state.n??0; const ops=[{kind:'generate',candidate:'next',parent:'initial',tasks:[]},{kind:'evaluate_seed',candidate:'next',parent:'',tasks:view.seed_tasks},{kind:'nominate',candidate:'next',parent:'',tasks:[]}]; return {state:{n:n+1},operations:[ops[n]],reason:'package journey'} }}
    for(const adapter of ['dsh','pi']) {
      const app=new ProjectApplication(new URL('./'+adapter+'-text',import.meta.url).pathname,{provider,algorithm})
      assert.equal((await app.run('evaluate',{limit:1},new AbortController().signal)).status,'complete')
      const report=await app.run('refine',{rounds:1},new AbortController().signal)
      assert.equal(report.champion,'next'); assert.equal(report.gate.accepted,true)
      assert.deepEqual(await app.resume(report.run_id,new AbortController().signal),report)
      assert.equal((await app.report(report.run_id)).status,'complete')
      await app.export(report.run_id)

      const config=new URL('./'+adapter+'-text/gear.yaml',import.meta.url)
      const yaml=await readFile(config,'utf8')
      assert.ok(yaml.includes('budget: {rounds: 1, max_evaluations: 40}'))
      await writeFile(config,yaml.replace('budget: {rounds: 1, max_evaluations: 40}',
        'budget: {rounds: 1, max_evaluations: 40, diagnosis: {max_requests: 1, max_input_tokens: 100, max_output_tokens: 50}}'))
      const diagnoses=new Map()
      const diagnosis={identity:'package-diagnosis-fixture-v1',
        capabilities:{boundedRequests:true,boundedTokens:true,recovery:true,isolated:true},
        async diagnose(input){
          assert.deepEqual(input.limits,{requests:1,inputTokens:100,outputTokens:50})
          assert.ok(input.observations.length>0)
          assert.ok(input.observations.every(o=>o.evidenceRef&&o.score===0))
          const result={facts:[],usage:{requests:1,inputTokens:10,outputTokens:5}}
          diagnoses.set(input.operationId,result); return result
        },
        async inspectDiagnosis(id){const result=diagnoses.get(id);return result?{status:'complete',result}:{status:'pending'}},
        async cancel(){}
      }
      const metered=new ProjectApplication(new URL('./'+adapter+'-text',import.meta.url).pathname,{
        provider:{...provider,diagnosis,async generate(input){
          assert.ok(input.diagnosisId)
          assert.equal(input.diagnosis.dossier.parent_identity,input.parent.digest)
          assert.equal(input.diagnosis.dossier.classifier_identity,diagnosis.identity)
          return provider.generate(input)
        }},
        algorithm:{identity:'package-metered-algorithm-v1',async step(view,state){
          const n=state.n??0
          assert.equal(view.diagnosis_budget.requests,n===0?1:0)
          const receipt=Object.keys(view.completed).find(key=>view.completed[key].kind==='diagnose_seed')
          const ops=[{kind:'diagnose_seed',candidate:'initial',parent:'',tasks:view.seed_tasks},
            {kind:'generate',candidate:'next',parent:'initial',tasks:[],diagnosis_id:receipt},
            {kind:'evaluate_seed',candidate:'next',parent:'',tasks:view.seed_tasks},
            {kind:'nominate',candidate:'next',parent:'',tasks:[]}]
          return {state:{n:n+1},operations:[ops[n]],reason:'metered package journey'}
        }}
      })
      const diagnosed=await metered.run('refine',{rounds:1},new AbortController().signal)
      assert.equal(diagnosed.champion,'next'); assert.equal(diagnosed.gate.accepted,true)
      assert.deepEqual(diagnosed.diagnosisBudget.spent,{requests:1,inputTokens:10,outputTokens:5})
      assert.deepEqual(diagnosed.diagnosisBudget.reserved,{requests:0,inputTokens:0,outputTokens:0})
      assert.deepEqual(await metered.resume(diagnosed.run_id,new AbortController().signal),diagnosed)
      assert.equal(diagnoses.size,1)
    }
  `,
  )
  run(process.execPath, [join(temp, 'journey.mjs')])
  const wheels = join(temp, 'wheels')
  await mkdir(wheels)
  run(python, ['-m', 'pip', 'wheel', '--no-deps', '--wheel-dir', wheels, join(temp, 'node_modules/rsi-gear/python')])
  run(python, ['-m', 'venv', join(temp, 'venv')])
  const installed = join(temp, 'venv/bin/python')
  const wheel = (await readdir(wheels)).find((name) => name.endsWith('.whl'))
  assert.ok(wheel)
  run(installed, ['-m', 'pip', 'install', join(wheels, wheel)])
  run(installed, [
    '-c',
    "import sys; from gear.training import TrainingLoop; from gear_training import TrainingLoop as Legacy; from gear.benchmark import Benchmark; from gear.refine import refine; assert TrainingLoop is Legacy; assert not ({'torch','slime'} & set(sys.modules))",
  ])
  const trainingArgs = [
    join(temp, 'node_modules/rsi-gear/examples/training-loop/linear_cpu.py'),
    '--workspace',
    join(temp, 'cpu-loop'),
    '--rounds',
    '2',
  ]
  const trained = JSON.parse(run(installed, trainingArgs))
  assert.equal(trained.rounds_completed, 2)
  assert.deepEqual(JSON.parse(run(installed, trainingArgs)), trained)
  const toy = JSON.parse(run(installed, ['-m', 'gear', 'toy']))
  assert.equal(toy.nominee, 'candidate-1')
  run(installed, [
    '-c',
    `from gear.algorithms import (DiagnosisTask, DiagnosisFact, DiagnosisDossier, GenerationBudget,
    failure_clusters, plan_hypotheses, candidate_workplan,
    deliver_workplan, consumption_receipt, validate_receipt)
from gear.algorithms.gepa.research import ArchiveScope
fact = DiagnosisFact('seed', ('evidence',), 'supported-hypothesis', 'family', 'Hypothesis', ('AGENTS.md',), 'mechanism')
dossier = DiagnosisDossier('dossier', 'parent', 'cohort', ('seed',), ('baseline',), (fact,), 'classifier', 'sanitization')
families = failure_clusters(dossier, (DiagnosisTask('seed', 'family'),), 'cohort')
proposal = plan_hypotheses(families, 1)[0]
scope = ArchiveScope('scope', 'family', 0, ('seed',), {'seed': 1.0})
workplan = candidate_workplan('child', 'batch', proposal, scope, 'local', ('seed',), GenerationBudget(1767225660000, 42, 3))
delivery = deliver_workplan(workplan, dossier, scope=scope)
receipt = consumption_receipt(delivery, 'session', ('evidence',))
validate_receipt(receipt, delivery, 'session')
assert receipt.workplan_identity == workplan.identity
`,
  ])
  run(installed, [
    '-c',
    "from gear.algorithms import GEPA, ScopeSampler; from gear.testing import toy_round; assert toy_round(GEPA(task_sampler=ScopeSampler()))['nominee'] == 'candidate-1'",
  ])
  run(installed, [
    '-c',
    "from gear.algorithms import EpochPolicy, StagedGEPA; from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit; from gear.testing import toy_round; assert toy_round(StagedGEPA(scope_config=ScopeConfig(bridge=TaskSetLimit(1)), epoch_policy=EpochPolicy(2)))['nominee'] == 'candidate-1'",
  ])
  run(installed, [
    '-c',
    `from gear import Project; assert Project(${JSON.stringify(join(temp, 'pi-json'))}, command=(${JSON.stringify(process.execPath)},${JSON.stringify(cli)})).check()['ok']`,
  ])
  const examples = join(temp, 'node_modules/rsi-gear/examples/python-algorithm')
  for (const entrypoint of [
    'policy:champion_parent',
    'policy:build_algorithm',
    'one_shot:build_algorithm',
    'archive_policy:choose_parent',
    'archive_policy:build_algorithm',
    'multi_parent:build_algorithm',
  ]) {
    const args = ['algorithm', 'test', entrypoint, '--source', examples]
    const checked = JSON.parse(run(installed, ['-m', 'gear', ...args]))
    assert.equal(checked.ok, true)
    assert.equal(checked.nominee, entrypoint.startsWith('one_shot:') ? 'one-shot' : 'candidate-1')
    const forwarded = JSON.parse(run(process.execPath, [cli, ...args, '--json'], temp, { GEAR_PYTHON: installed }))
    assert.deepEqual(forwarded, checked)
    assert.match(
      run(process.execPath, [cli, ...args], temp, { GEAR_PYTHON: installed }),
      /Algorithm offline contract passed/,
    )
  }
  const frozen = JSON.parse(
    run(installed, [
      '-c',
      `
import json, sys
from pathlib import Path
from gear.algorithms import GEPA
from gear.algorithms.source import freeze_algorithm
sys.path.insert(0, ${JSON.stringify(examples)})
from policy import champion_parent
source = freeze_algorithm(GEPA(parent_policy=champion_parent), Path('frozen'))
print(json.dumps({'source':str(Path(source.source).resolve()), 'entrypoint':source.entrypoint}))
`,
    ]),
  )
  assert.equal(
    JSON.parse(run(installed, ['-m', 'gear', 'algorithm', 'test', frozen.entrypoint, '--source', frozen.source])).ok,
    true,
  )
  run(installed, [
    '-c',
    `
import asyncio
from gear import Project
from gear.benchmark import Benchmark
p = Project.open(${JSON.stringify(join(temp, 'pi-json'))}, command=(${JSON.stringify(process.execPath)}, ${JSON.stringify(cli)}))
assert asyncio.run(p.acheck()) == p.check()
assert asyncio.run(Benchmark(p).acheck())['ok']
assert asyncio.run(p.acompile()) == Benchmark(p).compile()
`,
  ])
  console.log(
    'Published tgz and wheel: six templates, both Target layouts, evaluate/refine/report/resume/export, metered diagnosis, CPU imports, sync/async SDK, source freezing and both algorithm author CLIs passed (offline fixture provider).',
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
