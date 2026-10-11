import dataclasses
import json
from pathlib import Path
import unittest

from gear.algorithms import Candidate, FrontierParentPolicy, SearchView, StagedGEPA
from gear.algorithms.gepa.archive import FrontierCandidate, comparison_key, scope_frontier, weighted_choice
from gear.algorithms.gepa.bridge import BridgeNominee, select_bridge
from gear.algorithms.gepa.scopes import SamplingTask, ScopeConfig, TaskSetLimit
from gear.testing import toy_round


def wire(value):
    return json.loads(json.dumps(dataclasses.asdict(value)))


class GepaStageTests(unittest.TestCase):
    def test_frozen_frontier_and_bridge_fixtures(self):
        fixture = json.loads((Path(__file__).resolve().parents[2] / 'test-contracts/gepa-stages-v1.json').read_text())
        for case in fixture['archive']:
            with self.subTest(case=case['name']):
                spec = case['input']
                candidates = tuple(FrontierCandidate(**{
                    **c,
                    'score_keys': {t:int(v) for t,v in c['score_keys'].items()},
                    'process_keys': {t:int(v) for t,v in c['process_keys'].items()},
                    'aggregate_key': None if c['aggregate_key'] is None else int(c['aggregate_key']),
                }) for c in spec['candidates'])
                result = scope_frontier(tuple(spec['task_ids']), spec['weights'], candidates, spec['champion'],
                                        process_fraction=spec['process_fraction'], tie_order=tuple(spec['tie_order']))
                self.assertEqual(wire(result), case['expected'])
                live = set(result.parent_probabilities)
                for front in result.fronts:
                    if front.informative and spec['weights'][front.task_id] > 0:
                        self.assertTrue(set(front.candidate_ids) & live)
        for case in fixture['bridge']:
            with self.subTest(case=case['name']):
                spec = case['input']
                quotes = []
                def affordable(ids, tasks):
                    allowed = sum(f'{candidate}:{task}' not in spec['cached'] for candidate in ids for task in tasks) <= spec['budget']
                    quotes.append(dict(ids=list(ids), tasks=list(tasks), affordable=allowed))
                    return allowed
                result = select_bridge(tuple(SamplingTask(**t) for t in spec['tasks']),
                                       ScopeConfig(seed=spec['seed'], bridge=TaskSetLimit(spec['ratio'])),
                                       spec['round_index'], tuple(BridgeNominee(n['candidate_id'], n['scope_id'], tuple(n['task_ids'])) for n in spec['ordered_nominees']),
                                       'champion', tuple(spec['guards']), spec['max_candidates'], affordable)
                self.assertEqual({**wire(result), 'quotes': quotes}, case['expected'])

    def test_frontier_rejects_bad_weights_keys_scope_and_order(self):
        good = FrontierCandidate('A','tree',{'x':1},1)
        with self.assertRaises(ValueError):scope_frontier(('x',), {'x':2}, (good,), 'A')
        with self.assertRaises(ValueError):scope_frontier(('x',), {'x':1}, (dataclasses.replace(good,score_keys={'held-out':1}),), 'A')
        with self.assertRaises(ValueError):scope_frontier(('x',), {'x':1}, (dataclasses.replace(good,score_keys={'x':.1}),), 'A')
        with self.assertRaises(ValueError):scope_frontier(('x',), {'x':1}, (good,), 'A',tie_order=('unknown',))

    def test_identical_targets_and_partial_parents_do_not_get_extra_draws(self):
        view = SearchView(('x','y'), (Candidate('first',{'x':0,'y':0},'same'),Candidate('clone',{'x':1,'y':1},'same'),Candidate('partial',{'x':1},'other')),
                          'first',3,20,'frozen')
        self.assertEqual(FrontierParentPolicy()(view), 'first')
        for invalid in [float('nan'),2,-1]:
            with self.assertRaises(ValueError):FrontierParentPolicy()(dataclasses.replace(view,candidates=(Candidate('first',{'x':invalid,'y':1}),)))

    def test_quantization_and_indexed_random_replay(self):
        self.assertEqual(comparison_key(.5000001),comparison_key(.5))
        self.assertEqual(comparison_key(-.0000005),0)
        self.assertEqual(comparison_key(-.0000006),-1)
        probabilities={'A':.25,'B':.75}
        self.assertEqual([weighted_choice(probabilities,'fixed',i) for i in range(30)],
                         [weighted_choice(dict(reversed(list(probabilities.items()))),'fixed',i) for i in range(30)])
        for invalid in [{},{'A':.1},{'A':float('nan')},{'A':-1,'B':2}]:
            with self.assertRaises(ValueError):weighted_choice(invalid,'fixed')

    def test_bridge_rejects_outside_tasks_and_duplicate_or_champion_nominees(self):
        tasks=(SamplingTask('x','a'),)
        for nominees in [(BridgeNominee('champion','s',('x',)),),
                         (BridgeNominee('A','s',('held-out',)),),
                         (BridgeNominee('A','s',('x',)),BridgeNominee('A','t',('x',)))]:
            with self.assertRaises(ValueError):select_bridge(tasks,ScopeConfig(),0,nominees,'champion',(),2,lambda *_:True)

    def run_recipe(self, *, remaining=100, invalid_generation=False):
        ids=tuple(f't{i}' for i in range(10))
        view=SearchView(ids,(Candidate('initial',{t:0 for t in ids},'initial'),),'initial',2,remaining,'fixed',
                        task_families={t:f'family-{i%2}' for i,t in enumerate(ids)})
        recipe=StagedGEPA(scope_config=ScopeConfig(bridge=TaskSetLimit(.6)))
        state={}; decisions=[]; physical=0
        for step in range(30):
            decision=recipe.step(view,state)
            # Reconstructing the recipe/JSON state produces the same decision.
            self.assertEqual(wire(decision),wire(StagedGEPA(scope_config=recipe.scope_config).step(view,json.loads(json.dumps(state)))))
            decisions.append(decision); state=json.loads(json.dumps(decision.state))
            for op in decision.operations:
                self.assertLessEqual(set(op.tasks),set(ids))
                if op.kind=='generate':
                    if invalid_generation:
                        view=dataclasses.replace(view,completed={**view.completed,f'receipt-{step}-{op.candidate}':{'kind':'generate','candidate':op.candidate,'status':'invalid-candidate'}})
                    else:view=dataclasses.replace(view,candidates=(*view.candidates,Candidate(op.candidate,{},op.candidate)))
                if op.kind=='evaluate_seed':
                    old=next(c for c in view.candidates if c.id==op.candidate)
                    needed=sum(t not in old.scores for t in op.tasks)
                    self.assertLessEqual(needed,view.remaining_evaluations)
                    physical+=needed
                    view=dataclasses.replace(view,remaining_evaluations=view.remaining_evaluations-needed,
                        candidates=tuple(dataclasses.replace(c,scores={**c.scores,**{t:1 for t in op.tasks if t not in c.scores}}) if c.id==op.candidate else c for c in view.candidates))
                if op.kind=='nominate':return decisions,view,op.candidate,physical
        self.fail('Recipe did not terminate')

    def test_staged_recipe_runs_local_bridge_global_then_nominates_complete_seed(self):
        decisions,view,nominee,physical=self.run_recipe()
        self.assertIn('candidate-',nominee)
        self.assertEqual(set(next(c for c in view.candidates if c.id==nominee).scores),set(view.seed_tasks))
        self.assertTrue(any('bridge participants' in d.reason for d in decisions))
        self.assertTrue(any('global seed' in d.reason for d in decisions))
        self.assertLess(physical,30)

    def test_budget_insufficient_for_expansion_never_generates(self):
        decisions,view,nominee,physical=self.run_recipe(remaining=10)
        self.assertEqual(nominee,'initial')
        self.assertEqual(physical,0)
        self.assertFalse(any(op.kind=='generate' for d in decisions for op in d.operations))

    def test_invalid_generation_consumes_each_candidate_attempt_once(self):
        decisions,view,nominee,physical=self.run_recipe(invalid_generation=True)
        generated=[op.candidate for d in decisions for op in d.operations if op.kind=='generate']
        self.assertEqual(generated,['candidate-1','candidate-2'])
        self.assertEqual(nominee,'initial')
        self.assertEqual(physical,0)

    def test_recipe_state_identity_and_toy_entrypoint(self):
        with self.assertRaisesRegex(ValueError,'another recipe'):
            StagedGEPA().step(SearchView((),(),'initial',1,1,'s'),{'version':1,'stage':'local'})
        self.assertEqual(toy_round(StagedGEPA(scope_config=ScopeConfig(bridge=TaskSetLimit(1))))['nominee'],'candidate-1')


if __name__=='__main__':unittest.main()
