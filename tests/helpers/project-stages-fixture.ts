import { passesExploration, scopeView } from '../../src/search/archive.js'
import { resolveSizing } from '../../src/search/contracts.js'
import { profile } from '../../src/search/evidence.js'
import { bridgeSelection } from '../../src/search/scopes.js'
import { evaluatedFixture, scopeFixture, settings, snapshot, universe } from '../../src/search/testing.js'

export interface ArchiveFixture {
  name: string
  size: number
  process: boolean
  champion: string
  guard?: number
  process_fraction: number
  candidates: Array<{id: string; tree?: string; scores: Array<number | null>; process_scores?: Array<number | null>; observed_at: number}>
  input: ReturnType<typeof legacyFrontier>['input']
  expected: ReturnType<typeof legacyFrontier>['expected']
}

export function legacyFrontier(f: ArchiveFixture) {
  const u = universe(f.size, 'seed', f.process)
  const scope = scopeFixture(u, u.tasks.filter((_,i)=>i!==f.guard).map(t=>t.id), 'fixture', 1,
    f.guard === undefined ? [] : [{taskId:`task-${f.guard}`,partition:'seed',rule:'must-pass'}])
  const config = settings().search
  config.process.parentBudgetFraction = f.process_fraction
  const snapshots = f.candidates.map(c=>snapshot(c.id, [], c.tree))
  const records = f.candidates.map((c,i)=>{
    const row = evaluatedFixture(u,scope,snapshots[i]!,id=>{
      const k=Number(id.slice(5)), outcome=c.scores[k], process=c.process_scores?.[k]
      return outcome == null ? undefined : {outcome, ...(process == null ? {} : {process})}
    },{completedAt:new Date(1767225600000+c.observed_at).toISOString()})
    return {snapshot:snapshots[i]!,result:row.result,plan:row.plan}
  })
  const view = scopeView(scope,u,snapshots,records,config,f.champion)
  return {
    input: {
      task_ids:scope.taskIds,weights:scope.weights,champion:f.champion,process_fraction:f.process_fraction,
      tie_order:f.candidates.map(c=>c.id).sort((a,b)=>a.localeCompare(b)),
      candidates:records.map((record,i)=>{
        const p=profile(u,record.plan,record.snapshot,record.result,config.process.mode,scope.weights)
        return {id:record.snapshot.candidateId,identity:`${record.snapshot.tree}:${record.snapshot.manifestDigest}`,
          score_keys:Object.fromEntries(p.tasks.filter(t=>t.outcomeKey!==undefined).map(t=>[t.taskId,t.outcomeKey])),
          aggregate_key:p.outcomeKey ?? null,observed_at:f.candidates[i]!.observed_at,
          guard_passed:passesExploration(scope,p,u),
          process_keys:Object.fromEntries(p.tasks.filter(t=>t.processKey!==undefined).map(t=>[t.taskId,t.processKey])),
          process_complete:p.processComplete,
        }
      }),
    },
    expected:{eligible_ids:view.outcomeEligibleIds,process_eligible_ids:view.processEligibleIds,
      fronts:view.fronts.map(f=>({task_id:f.taskId,channel:f.channel,candidate_ids:f.candidateIds,informative:f.informative})),
      representatives:view.representatives,pruned_ids:view.prunedIds,parent_probabilities:view.conditionalParentProbabilities,
      pending_ids:view.pendingEvidenceIds,ineligible_ids:view.ineligibleIds},
  }
}

export interface BridgeFixture {
  name:string
  size:number
  seed:number
  ratio:number
  max_candidates:number
  round_index:number
  budget:number
  guards:string[]
  cached:string[]
  nominees:Array<{candidate_id:string;family_id:string;scope_id:string;task_ids:string[]}>
  input: Awaited<ReturnType<typeof legacyBridge>>['input']
  expected: Awaited<ReturnType<typeof legacyBridge>>['expected']
}
export async function legacyBridge(f:BridgeFixture) {
  const u=universe(f.size),config=settings().search
  config.seed=f.seed
  config.taskSetSizing.bridge={ratio:f.ratio}
  config.evaluationStages.bridge.maxCandidates=f.max_candidates
  const nominees=f.nominees.map(n=>({candidateId:n.candidate_id,scope:scopeFixture(u,n.task_ids,n.family_id)}))
  const quotes:Array<{ids:string[];tasks:string[];affordable:boolean}>=[]
  const result=await bridgeSelection(u,resolveSizing(u,config.taskSetSizing),config,f.round_index,nominees,'champion',f.guards,(ids,tasks)=>{
    const affordable=ids.reduce((total,id)=>total+tasks.filter(t=>!f.cached.includes(`${id}:${t}`)).length,0)<=f.budget
    quotes.push({ids,tasks,affordable});return affordable
  })
  return {
    input:{tasks:u.tasks.map(t=>({id:t.id,stratum:t.stratum,estimated_cost:t.estimatedCost})),
      seed:String(f.seed),ratio:f.ratio,round_index:f.round_index,max_candidates:f.max_candidates,
      ordered_nominees:[...f.nominees].sort((a,b)=>a.family_id.localeCompare(b.family_id)).map(n=>({candidate_id:n.candidate_id,scope_id:n.scope_id,task_ids:n.task_ids})),
      guards:f.guards,budget:f.budget,cached:f.cached},
    expected:{plan:result.plan?{task_ids:result.plan.taskIds,participant_ids:result.plan.participantIds}:null,
      skipped:result.skipped,exclusions:result.exclusions.map(e=>({candidate_id:e.candidateId,
        scope_id:f.nominees.find(n=>n.candidate_id===e.candidateId)!.scope_id,reason:e.reason})),quotes},
  }
}
