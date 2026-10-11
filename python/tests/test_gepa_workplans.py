from copy import deepcopy
from dataclasses import asdict, replace
import unittest

from gear.algorithms import Candidate, SearchView, StagedGEPA
from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit
from gear._protocol.generated import validate_wire_type


def fixture():
    ids = tuple(f"t{i:02}" for i in range(20))
    view = SearchView(ids, (Candidate("initial", dict.fromkeys(ids, 0), "parent"),), "initial", 4, 200, "workplans",
                      task_families={t: "a" if i < 10 else "b" for i, t in enumerate(ids)},
                      diagnosis_budget={"requests": 4, "inputTokens": 2000, "outputTokens": 500})
    recipe = StagedGEPA(ScopeConfig(local=TaskSetLimit(0.2), shared=TaskSetLimit(0), cross=TaskSetLimit(0)), batch_size=4)
    decision = recipe.step(view, {})
    receipts = {}
    for i, op in enumerate(decision.operations):
        assert op.kind == "diagnose_seed"
        task = op.tasks[0]
        receipts[f"receipt-{i}"] = {"kind": "diagnose_seed", "candidate": op.candidate,
            "method": "provider-seed-diagnosis-v1", "tasks": [{"id": t} for t in op.tasks],
            "dossier": {"identity": f"dossier-{i}", "parent_identity": "parent", "cohort_identity": "seed",
                "task_ids": list(op.tasks), "baseline_evidence": [f"baseline-{i}"], "classifier_identity": "fixture",
                "sanitization_identity": "seed-text-projection-v1", "facts": [
                    {"task_id": task, "evidence_refs": [f"ref-{i}"], "status": "supported-hypothesis",
                     "family_id": f"cause-{i}", "hypothesis": "Handle the observed failure", "modification_paths": ["prompts"],
                     "mechanism": "Verified seed failure", "submode": None}]}}
    return recipe, replace(view, completed=receipts, diagnosis_budget={"requests": 0, "inputTokens": 1500, "outputTokens": 400}), decision


class WorkplanStageTests(unittest.TestCase):
    def test_committed_diagnoses_form_frozen_workplans_after_model_budget_is_spent(self):
        recipe, view, pending = fixture()
        self.assertGreater(len(view.completed), 1)
        original = deepcopy(pending.state)
        result = recipe.step(view, pending.state)
        self.assertEqual(pending.state, original)
        self.assertEqual(result.state["parent_batches"], pending.state["parent_batches"])
        self.assertEqual(result.state["stage"], "local")
        self.assertEqual(len(result.operations), len(view.completed))
        for op in result.operations:
            self.assertEqual(op.kind, "generate")
            p = op.workplan
            self.assertEqual(p["dossier_identity"], view.completed[op.diagnosis_id]["dossier"]["identity"])
            self.assertEqual(p["modification_paths"], ("prompts",))
            self.assertEqual(p["required_seed_tasks"], view.seed_tasks)
            self.assertEqual(p["generation_budget"], {"deadline_ms": None, "max_tokens": None, "max_model_requests": None})
            self.assertTrue(set(p["target_task_ids"]) <= set(op.tasks))
        validate_wire_type("AlgorithmDecision", asdict(result))

    def test_repeated_parent_family_hypothesis_does_not_reassign_unused_slots(self):
        recipe, view, pending = fixture()
        receipts = deepcopy(dict(view.completed))
        for r in receipts.values():
            r["dossier"]["facts"][0]["family_id"] = "shared-cause"
        result = recipe.step(replace(view, completed=receipts), pending.state)
        self.assertEqual(len(result.operations), 1)
        self.assertEqual(result.state["parent_batches"], pending.state["parent_batches"])
        self.assertTrue(any(e["reason"] == "no-new-supported-hypothesis" for e in result.state["planning_exclusions"]))

    def test_unresolved_facts_cannot_authorize_generation(self):
        recipe, view, pending = fixture()
        receipts = deepcopy(dict(view.completed))
        for r in receipts.values(): r["dossier"]["facts"] = []
        result = recipe.step(replace(view, completed=receipts), pending.state)
        self.assertEqual([op.kind for op in result.operations], ["nominate"])

    def test_rejects_missing_unverified_wrong_parent_and_old_recipe(self):
        recipe, view, pending = fixture()
        for kind in ("missing", "method", "parent", "stale"):
            receipts = deepcopy(dict(view.completed))
            if kind == "missing": receipts = {}
            else:
                for r in receipts.values():
                    if kind == "method": r["method"] = "seed-score-projection-v1"
                    if kind == "parent": r["dossier"]["parent_identity"] = "other"
            state = deepcopy(dict(pending.state))
            if kind == "stale": state["diagnosis_before"] = list(receipts)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                recipe.step(replace(view, completed=receipts), state)
        with self.assertRaisesRegex(ValueError, "frozen runtime"):
            recipe.step(view, {"recipe": "staged-gepa-v3"})


if __name__ == "__main__": unittest.main()
