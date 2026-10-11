import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  const carrierRoot = join(temp, 'node_modules/rsi-gear/assets/hitch-carrier')
  for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'build-carrier.mjs', 'hitch-entry.mjs'])
    assert.ok(
      (await readFile(join(carrierRoot, name))).byteLength > 0,
      `missing published Hitch carrier asset: ${name}`,
    )
  const artifactGuard = join(temp, 'node_modules/rsi-gear/assets/harbor-runtime/gear_harbor_artifacts.py')
  for (const name of ['launch.mjs', 'harbor_cli.py'])
    assert.ok(
      (await readFile(join(temp, 'node_modules/rsi-gear/assets/harbor-runtime', name))).byteLength > 0,
      `missing published Harbor runtime asset: ${name}`,
    )
  // Loading and using the metadata checker must not import Harbor or optional model packages.
  const artifactFixture = join(temp, 'artifact-fixture')
  await mkdir(artifactFixture)
  await writeFile(join(artifactFixture, 'answer.txt'), 'owned fixture')
  run(python, [
    '-I',
    '-c',
    'import pathlib,runpy,sys; m=runpy.run_path(sys.argv[1]); m["validate_artifacts"](pathlib.Path(sys.argv[2])); assert "harbor" not in sys.modules',
    artifactGuard,
    artifactFixture,
  ])
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
    const source = JSON.parse(
      run(process.execPath, [cli, 'benchmark', 'compile', '--json'], join(temp, `${adapter}-text`)),
    ).root
    const manifest = join(temp, `${adapter}-harbor.csv`)
    await writeFile(
      manifest,
      'id,path,family,split\nseed,seed/sum-01,addition,seed\nheld,held_out/word-01,case,held_out\n',
    )
    const imported = join(temp, `${adapter}-harbor`)
    run(process.execPath, [
      cli,
      'init',
      imported,
      '--adapter',
      adapter,
      '--template',
      'harbor',
      '--from',
      source,
      '--manifest',
      manifest,
    ])
    const checked = JSON.parse(run(process.execPath, [cli, 'benchmark', 'check', '--json'], imported))
    assert.deepEqual(checked.checks, { static: 'passed', verifierFixtures: 'not_run', runtime: 'not_run' })
    assert.match(
      run(process.execPath, [cli, 'benchmark', 'check'], imported),
      /Harbor verifier self-tests and Target execution have not run/,
    )
    const exported = JSON.parse(run(process.execPath, [cli, 'benchmark', 'compile', '--json'], imported)).root
    assert.deepEqual(
      await readFile(join(exported, 'seed/seed/tests/verify.py')),
      await readFile(join(source, 'seed/sum-01/tests/verify.py')),
    )
  }
  await writeFile(
    join(temp, 'journey.mjs'),
    `
    import assert from 'node:assert/strict'
    import {execFileSync} from 'node:child_process'
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

      const harborProvider={...provider,capabilities:{...provider.capabilities,harborVerification:true},
        async evaluate(input){
          assert.ok(input.task.harbor.files.some(f=>f.path==='tests/verify.py'))
          const result={status:'completed',physicalAttempts:1,output:'1',verification:{operationId:input.operationId,
            taskDigest:input.task.harbor.digest,metrics:{reward:input.target.id==='initial'?0:0.75}}}
          results.set(input.operationId,result);return result
        }}
      const harbor=new ProjectApplication(new URL('./'+adapter+'-harbor',import.meta.url).pathname,{provider:harborProvider,algorithm})
      const harborReport=await harbor.run('refine',{rounds:1},new AbortController().signal)
      assert.equal(harborReport.gate.policy,'paired-mean-reward-v1')
      assert.equal(harborReport.gate.accepted,true)
      assert.equal(harborReport.candidates[0].partitions[0].validZero,1)
      assert.equal(harborReport.candidates[1].partitions[0].meanScore,0.75)
      assert.equal(harborReport.candidates[1].partitions[0].passRate,null)
      assert.deepEqual(await harbor.resume(harborReport.run_id,new AbortController().signal),harborReport)

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
          const result={facts:input.observations.map(o=>({task_id:o.taskId,evidence_refs:[o.evidenceRef],
            status:'supported-hypothesis',family_id:'instruction-handling',hypothesis:'Follow the seed instruction',
            mechanism:'Verified seed output mismatch',modification_paths:['AGENTS.md']})),
            usage:{requests:1,inputTokens:10,outputTokens:5}}
          diagnoses.set(input.operationId,result); return result
        },
        async inspectDiagnosis(id){const result=diagnoses.get(id);return result?{status:'complete',result}:{status:'pending'}},
        async cancel(){}
      }
      const metered=new ProjectApplication(new URL('./'+adapter+'-text',import.meta.url).pathname,{
        provider:{...provider,diagnosis,async generate(input){
          assert.ok(input.diagnosisId)
          assert.equal(input.diagnosis,undefined)
          assert.equal(input.delivery.dossier.parent_identity,input.parent.digest)
          assert.equal(input.delivery.dossier.classifier_identity,diagnosis.identity)
          assert.deepEqual(input.delivery.workplan.modification_paths,['AGENTS.md'])
          return provider.generate(input)
        }},
        algorithm:{identity:'package-staged-workplan-v1',async step(view,state){
          return JSON.parse(execFileSync(process.env.GEAR_PACKAGE_PYTHON,['-c',
            'import json,sys\\nfrom dataclasses import asdict\\nfrom gear.algorithms import Candidate, SearchView, StagedGEPA\\nfrom gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit\\np=json.load(sys.stdin)\\nv=p["view"]\\nv["candidates"]=tuple(Candidate(**c) for c in v["candidates"])\\nv["seed_tasks"]=tuple(v["seed_tasks"])\\na=StagedGEPA(ScopeConfig(local=TaskSetLimit(1),shared=TaskSetLimit(0),cross=TaskSetLimit(0),bridge=TaskSetLimit(1)),batch_size=1)\\nprint(json.dumps(asdict(a.step(SearchView(**v),p["state"]))))'
          ],{input:JSON.stringify({view,state}),encoding:'utf8'}))
        }}
      })
      const diagnosed=await metered.run('refine',{rounds:1},new AbortController().signal)
      assert.equal(diagnosed.champion,'candidate-1'); assert.equal(diagnosed.gate.accepted,true)
      assert.deepEqual(diagnosed.diagnosisBudget.spent,{requests:1,inputTokens:10,outputTokens:5})
      assert.deepEqual(diagnosed.diagnosisBudget.reserved,{requests:0,inputTokens:0,outputTokens:0})
      assert.deepEqual(await metered.resume(diagnosed.run_id,new AbortController().signal),diagnosed)
      assert.equal(diagnoses.size,1)
    }
  `,
  )
  const wheels = join(temp, 'wheels')
  await mkdir(wheels)
  run(python, ['-m', 'pip', 'wheel', '--no-deps', '--wheel-dir', wheels, join(temp, 'node_modules/rsi-gear/python')])
  run(python, ['-m', 'venv', join(temp, 'venv')])
  const installed = join(temp, 'venv/bin/python')
  const wheel = (await readdir(wheels)).find((name) => name.endsWith('.whl'))
  assert.ok(wheel)
  run(installed, ['-m', 'pip', 'install', join(wheels, wheel)])
  run(process.execPath, [join(temp, 'journey.mjs')], temp, { GEAR_PACKAGE_PYTHON: installed })
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
    'Published tgz and wheel: six template/Target combinations, two Harbor imports with verifier rewards, evaluate/refine/report/resume/export, metered diagnosis and StagedGEPA workplans, CPU imports, sync/async SDK, source freezing and both algorithm author CLIs passed (offline fixture provider).',
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
