"""Frozen outputs were produced by the historical TypeScript sampler, not Python."""

import dataclasses
import json
from pathlib import Path
import unittest

from gear.algorithms import Candidate, GEPA, ScopeSampler, SearchView
from gear.algorithms.gepa.scope_ordering import cross_order, representative_order
from gear.algorithms.gepa.scope_types import task_index
from gear.algorithms.gepa.scopes import (
    FailureFamily, SamplingTask, ScopeConfig, TaskSetLimit, create_scope, resolve_sizing,
)
from gear.testing import toy_round


def fixture_inputs(case):
    tasks = tuple(SamplingTask(**{key: tuple(value) if isinstance(value, list) else value
                                 for key, value in task.items()}) for task in case['tasks'])
    config = ScopeConfig(**{
        key: TaskSetLimit(**value) if key in ('local', 'shared', 'cross', 'bridge') else
        tuple(value) if isinstance(value, list) else value
        for key, value in case['config'].items()
    })
    family = FailureFamily(**{key: tuple(value) if isinstance(value, list) else value
                              for key, value in case['family'].items()})
    return tasks, config, family


class GepaScopeTests(unittest.TestCase):
    def test_frozen_typescript_scope_selections(self):
        path = Path(__file__).resolve().parents[2] / 'test-contracts/gepa-scopes-v1.json'
        fixtures = json.loads(path.read_text())
        for case in fixtures['cases']:
            with self.subTest(case=case['name']):
                tasks, config, family = fixture_inputs(case)
                indexed = task_index(tasks)
                scope = create_scope(tasks, config, family, tuple(case['successful_ids']),
                                     epoch=case['epoch'])
                cross, general = cross_order(indexed, set(family.task_ids), family.id,
                                             family.modification_paths, config.seed)
                result = {
                    'quantities': {k: dataclasses.asdict(v) for k, v in resolve_sizing(len(tasks), config).items()},
                    'representative': representative_order(indexed, list(indexed), config.seed),
                    'cross': {'ids': cross, 'general_ids': general},
                    'scope': dataclasses.asdict(scope) if scope else None,
                }
                result = json.loads(json.dumps(result))
                self.assertEqual(result, case['expected'])
                if scope:
                    self.assertAlmostEqual(sum(scope.weights.values()), 1)
                    self.assertEqual(len(scope.task_ids), len(set(scope.task_ids)))
                    self.assertLessEqual(set(scope.task_ids), set(indexed))

    def test_decimal_ratio_does_not_round_seven_up_to_eight(self):
        config = ScopeConfig(local=TaskSetLimit(.07), shared=TaskSetLimit(0), cross=TaskSetLimit(0))
        self.assertEqual(resolve_sizing(100, config)['local'].requested, 7)

    def test_invalid_limits_are_rejected_before_sampling(self):
        for local in [TaskSetLimit(0), TaskSetLimit(float('nan')), TaskSetLimit(-.1),
                      TaskSetLimit(.3, 4, 2), TaskSetLimit(.3, max_tasks=0),
                      TaskSetLimit(.3, min_tasks=True), TaskSetLimit(.3, min_tasks=2**53)]:
            with self.subTest(local=local), self.assertRaises(ValueError):
                resolve_sizing(10, ScopeConfig(local=local))
        with self.assertRaises(ValueError):
            resolve_sizing(10, ScopeConfig(local=TaskSetLimit(.95)))
        with self.assertRaises(ValueError):
            resolve_sizing(10, ScopeConfig(shared=TaskSetLimit(0, min_tasks=1)))

    def test_unknown_guard_control_core_and_failure_cannot_enter_scope(self):
        tasks = (SamplingTask('seed', 'family'),)
        for config, family, successes in [
            (ScopeConfig(guard_task_ids=('held-out',)), FailureFamily('family', ('seed',)), ()),
            (ScopeConfig(shared_core_task_ids=('held-out',)), FailureFamily('family', ('seed',)), ()),
            (ScopeConfig(), FailureFamily('family', ('held-out',)), ()),
            (ScopeConfig(), FailureFamily('family', ('seed',), ('held-out',)), ()),
            (ScopeConfig(), FailureFamily('family', ('seed',)), ('held-out',)),
        ]:
            with self.subTest(config=config, family=family), self.assertRaises(ValueError):
                create_scope(tasks, config, family, successes)

    def test_invalid_metadata_and_zero_score_mass_are_rejected(self):
        for tasks in [(), (SamplingTask('x', 'a'), SamplingTask('x', 'a')),
                      (SamplingTask('x', 'a', estimated_cost=float('inf')),),
                      (SamplingTask('x', 'a', historical_difficulty=1.1),)]:
            with self.subTest(tasks=tasks), self.assertRaises(ValueError):
                create_scope(tasks, ScopeConfig(), FailureFamily('a', ('x',)))
        with self.assertRaisesRegex(ValueError, 'positive scoring weight'):
            create_scope((SamplingTask('x', 'a'),),
                         ScopeConfig(bucket_weights={'shared': 1, 'local': 0, 'cross': 0}),
                         FailureFamily('a', ('x',)))
        with self.assertRaisesRegex(ValueError, 'finite positive scoring weight'):
            create_scope((SamplingTask('x', 'a'), SamplingTask('y', 'b')),
                         ScopeConfig(bucket_weights={'shared': 1e308, 'local': 1e308, 'cross': 1e308}),
                         FailureFamily('a', ('x',)), ('y',))

    def test_recipe_adapter_uses_seed_family_and_observed_parent_only(self):
        view = SearchView(('a', 'b', 'c', 'd', 'e'),
                          (Candidate('parent', {'a': 0, 'b': 0, 'c': 1, 'd': 0, 'e': 1}),),
                          'parent', 1, 20, 'fixed', task_families={'a':'A','b':'A','c':'A','d':'B','e':'B'})
        sampler = ScopeSampler(ScopeConfig(local=TaskSetLimit(.4), shared=TaskSetLimit(.2), cross=TaskSetLimit(.2)))
        expected = create_scope(tuple(SamplingTask(t, view.task_families[t]) for t in view.seed_tasks),
                                dataclasses.replace(sampler.config, seed=view.random_seed),
                                FailureFamily('A', ('a', 'b'), ('c',)), ('c', 'e'))
        self.assertEqual(sampler(view, 'parent'), expected.task_ids)
        decision = GEPA(task_sampler=sampler).step(view, {'stage':'local', 'index':0, 'parent':'parent'})
        self.assertEqual(decision.operations[0].tasks, expected.task_ids)
        self.assertEqual(sampler(view, 'parent'), sampler(view, 'parent'))

    def test_missing_invalid_and_unbounded_parent_scores_are_not_failures(self):
        for scores in [{}, {'seed': float('nan')}, {'seed': 2}, {'seed': -1}]:
            view = SearchView(('seed',), (Candidate('parent', scores),), 'parent', 1, 10, 's')
            with self.subTest(scores=scores), self.assertRaises(ValueError):
                ScopeSampler()(view, 'parent')
        with self.assertRaises(ValueError):
            ScopeSampler()(view, 'unknown')

    def test_recipe_adapter_completes_cpu_toy_round(self):
        result = toy_round(GEPA(task_sampler=ScopeSampler()))
        self.assertEqual(result['nominee'], 'candidate-1')


if __name__ == '__main__':
    unittest.main()
