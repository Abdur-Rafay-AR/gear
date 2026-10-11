import copy
from dataclasses import asdict, replace
import json
from pathlib import Path
import unittest

from gear.algorithms import (
    Candidate,
    EpochPolicy,
    ParentAllocation,
    ParentPlan,
    SearchView,
    StagedGEPA,
)
from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit


def specialists(view, rng):
    options = [(s, p) for s in view.scopes for p in s.parents if p.candidate_id in ("a", "b")]
    selected = [next((s, p) for s, p in options if p.candidate_id == name) for name in ("a", "b")]
    return ParentPlan(
        tuple(ParentAllocation(s.id, p.identity, 1, i) for i, (s, p) in enumerate(selected)),
        {"a": 0.5, "b": 0.5},
        ("two-specialists",),
    )


def repeated_champion(view, rng):
    c = view.champion
    return ParentPlan(
        tuple(ParentAllocation(c.scope_id, c.identity, 1, i) for i in range(view.max_candidates)),
        {c.candidate_id: 1},
        ("repeated-champion",),
    )


def fixture():
    ids = tuple(f"t{i:02}" for i in range(20))
    view = SearchView(
        ids, (Candidate("initial", dict.fromkeys(ids, 0)),), "initial", 6, 200, "batches"
    )
    config = ScopeConfig(local=TaskSetLimit(0.2), shared=TaskSetLimit(0), cross=TaskSetLimit(0))
    recipe = StagedGEPA(
        config, batch_size=2, epoch_policy=EpochPolicy(1), parent_selection_policy=specialists
    )
    first = StagedGEPA(config, batch_size=2).step(view, {})
    state = json.loads(json.dumps(first.state))
    scope = state["catalog"][-1]["scope"]
    scores = dict.fromkeys(scope["task_ids"], 0)
    a = Candidate("a", {**scores, scope["task_ids"][0]: 0.5})
    b = Candidate("b", {**scores, scope["task_ids"][1]: 0.5})
    view = replace(view, candidates=(*view.candidates, a, b))
    state["catalog"][-1]["registrations"].extend(("a", "b"))
    state.update(stage="parents", index=2, round=1)
    return recipe, view, state


def finish_preparation(view, decision):
    for operation in decision.operations:
        if operation.kind == "evaluate_seed":
            view = replace(
                view,
                candidates=tuple(
                    replace(c, scores={**dict.fromkeys(operation.tasks, 0.25), **c.scores})
                    if c.id == operation.candidate
                    else c
                    for c in view.candidates
                ),
            )
    return view


class ParentBatchTests(unittest.TestCase):
    def test_frozen_legacy_materialization_keeps_every_allocation(self):
        from gear.algorithms import ParentInput, ParentOption, ParentScope, parent_batches

        fixture_path = (
            Path(__file__).resolve().parents[2] / "test-contracts/gepa-parent-batches-v1.json"
        )
        for case in json.loads(fixture_path.read_text())["cases"]:
            with self.subTest(case=case["name"]):
                spec = case["input"]
                view = ParentInput(
                    tuple(
                        ParentScope(
                            **{**s, "parents": tuple(ParentOption(**p) for p in s["parents"])}
                        )
                        for s in spec["scopes"]
                    ),
                    spec["max_candidates"],
                    spec["random_seed"],
                )
                plan = ParentPlan(
                    **{
                        **case["plan"],
                        "allocations": tuple(
                            ParentAllocation(**a) for a in case["plan"]["allocations"]
                        ),
                    }
                )
                actual = [asdict(b) for b in parent_batches(view, plan, "fixture-round")]
                self.assertEqual(actual, case["expected"])

    def test_every_selected_parent_is_mandatory_in_epoch_preparation(self):
        recipe, view, state = fixture()
        before = copy.deepcopy(state)
        decision = recipe.step(view, state)
        self.assertEqual(state, before)
        self.assertEqual(decision, recipe.step(view, state))
        self.assertEqual(decision.state["stage"], "epoch-results")
        self.assertEqual(
            decision.state["pending_epoch"]["admission"]["participant_ids"],
            ("initial", "a", "b"),
        )
        self.assertEqual([b["parent"] for b in decision.state["parent_batches"]], ["a", "b"])
        self.assertEqual([b["slots"] for b in decision.state["parent_batches"]], [1, 1])
        frozen = json.loads(json.dumps(decision.state))
        prepared = finish_preparation(view, decision)
        result = recipe.step(prepared, frozen)
        if result.state["stage"] == "generate":
            result = recipe.step(finish_preparation(prepared, result), result.state)
        self.assertEqual(result.state["stage"], "local")
        self.assertEqual([o.parent for o in result.operations if o.kind == "generate"], ["a", "b"])
        self.assertEqual(len({p["batch_id"] for p in result.state["plans"]}), 2)
        self.assertEqual(result.state["parent_selection"], frozen["parent_selection"])
        self.assertEqual(len(result.state["batch_sampling"]), 2)
        from gear.algorithms.gepa.history import project_sampling_evidence

        for batch, evidence in zip(result.state["parent_batches"], result.state["batch_sampling"]):
            isolated = replace(
                view,
                candidates=tuple(
                    next(new for new in prepared.candidates if new.id == c.id)
                    if c.id == batch["parent"]
                    else c
                    for c in view.candidates
                ),
            )
            self.assertEqual(
                evidence["cutoff_identity"],
                project_sampling_evidence(isolated).cutoff_identity,
            )
        self.assertEqual(result.state["index"], 4)

    def test_mandatory_specialist_cannot_be_dropped_to_fit_budget(self):
        recipe, view, state = fixture()
        decision = recipe.step(view, state)
        cost = decision.state["pending_epoch"]["admission"]["cost"]["cells"]
        from gear.algorithms.gepa.epochs import PreparationCost, admit_scope_epoch
        from gear.algorithms.gepa.stage_catalog import read_scope

        old = next(
            c["scope"]
            for c in state["catalog"]
            if c["scope"]["id"] == decision.state["parent_batches"][0]["scope_id"]
        )
        new = decision.state["pending_epoch"]["scope"]
        result = admit_scope_epoch(
            read_scope(old),
            read_scope(new),
            "initial",
            ("a", "b"),
            {},
            EpochPolicy(1),
            PreparationCost(cost - 1),
            lambda ids, tasks: PreparationCost(cost),
        )
        self.assertEqual(result.status, "budget-insufficient")
        self.assertEqual(result.participant_ids, ("initial", "a", "b"))

    def test_duplicate_parent_family_is_not_generated_twice(self):
        ids = tuple(f"t{i}" for i in range(20))
        view = SearchView(
            ids, (Candidate("initial", dict.fromkeys(ids, 0)),), "initial", 4, 100, "seed"
        )
        decision = StagedGEPA(batch_size=4, parent_selection_policy=repeated_champion).step(
            view, {}
        )
        self.assertEqual(len(decision.state["parent_batches"]), 4)
        self.assertEqual(sum(o.kind == "generate" for o in decision.operations), 1)
        self.assertEqual(len(decision.state["planning_exclusions"]), 3)
        self.assertTrue(
            all(
                r["reason"] == "duplicate-parent-family"
                for r in decision.state["planning_exclusions"]
            )
        )

    def test_many_batches_fit_the_public_worker_message_limit(self):
        from gear._protocol.generated import PROTOCOL

        ids = tuple(f"task-{i:04}" for i in range(500))
        view = SearchView(
            ids, (Candidate("initial", dict.fromkeys(ids, 0)),), "initial", 16, 2000, "size"
        )
        decision = StagedGEPA(batch_size=16, parent_selection_policy=repeated_champion).step(
            view, {}
        )
        self.assertEqual(len(decision.state["batch_sampling"]), 16)
        encoded = json.dumps({"decision": asdict(decision)}).encode()
        self.assertLess(len(encoded), PROTOCOL["maxBytes"])
        self.assertLess(
            len(json.dumps({"view": asdict(view), "state": decision.state}).encode()),
            PROTOCOL["maxBytes"],
        )

    def test_invalid_policy_or_state_is_rejected_and_abstention_is_explicit(self):
        recipe, view, _ = fixture()

        def bad(parent, rng):
            return ParentPlan(
                (ParentAllocation("outside", "outside", 1, 0),), {"initial": 1}, ("bad",)
            )

        with self.assertRaisesRegex(ValueError, "ineligible"):
            replace(recipe, parent_selection_policy=bad).step(view, {})
        stopped = replace(
            recipe, parent_selection_policy=lambda v, r: ParentPlan.abstain(reason="done")
        ).step(view, {})
        self.assertEqual(stopped.operations[0].kind, "nominate")
        self.assertEqual(stopped.state["parent_selection"]["reason_codes"], ("done",))
        for version in ("staged-gepa-v1", "staged-gepa-v2"):
            with self.assertRaisesRegex(ValueError, "frozen runtime"):
                recipe.step(view, {"recipe": version})
        with self.assertRaisesRegex(ValueError, "single-parent override"):
            replace(recipe, parent_policy=lambda v: v.champion)


if __name__ == "__main__":
    unittest.main()
