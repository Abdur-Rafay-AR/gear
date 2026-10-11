from dataclasses import replace
import unittest

from gear.algorithms import Candidate, GEPA, SearchView, StagedGEPA
from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit


def fixture():
    ids = tuple(f"t{i:02}" for i in range(20))
    view = SearchView(ids, (Candidate("initial", dict.fromkeys(ids, 0)),), "initial", 4, 200, "diagnosis",
                      task_families={t: "a" if i < 10 else "b" for i, t in enumerate(ids)},
                      diagnosis_budget={"requests": 1, "inputTokens": 200, "outputTokens": 50})
    recipe = StagedGEPA(ScopeConfig(local=TaskSetLimit(0.2), shared=TaskSetLimit(0), cross=TaskSetLimit(0)), batch_size=4)
    return view, recipe


class DiagnosisBudgetTests(unittest.TestCase):
    def test_default_and_staged_stop_before_unaffordable_diagnosis(self):
        view, staged = fixture()
        for key in view.diagnosis_budget:
            blocked = replace(view, diagnosis_budget={**view.diagnosis_budget, key: 0})
            for recipe in (GEPA(), staged):
                decision = recipe.step(blocked, {})
                self.assertEqual([op.kind for op in decision.operations], ["nominate"])
                self.assertEqual(decision.operations[0].candidate, "initial")

    def test_staged_records_budget_exclusions_without_reassigning_parent_quotas(self):
        view, recipe = fixture()
        unmetered = recipe.step(replace(view, diagnosis_budget=None), {})
        limited = recipe.step(view, {})
        self.assertGreater(sum(op.kind == "diagnose_seed" for op in unmetered.operations), 1)
        self.assertEqual(sum(op.kind == "diagnose_seed" for op in limited.operations), 1)
        self.assertEqual(sum(op.kind == "generate" for op in limited.operations), 0)
        self.assertEqual(limited.state["stage"], "propose")
        self.assertEqual(limited.state["parent_batches"], unmetered.state["parent_batches"])
        self.assertTrue(any(e["reason"] == "diagnosis-budget" for e in limited.state["planning_exclusions"]))


if __name__ == "__main__":
    unittest.main()
