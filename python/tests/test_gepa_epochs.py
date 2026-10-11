import copy
from dataclasses import asdict, replace
import json
from pathlib import Path
import unittest

from gear.algorithms import Candidate, EpochPolicy, SearchView, StagedGEPA
from gear.algorithms.gepa.epochs import PreparationCost, admit_scope_epoch
from gear.algorithms.gepa.research import ArchiveScope
from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit


def recipe():
    return StagedGEPA(
        scope_config=ScopeConfig(
            local=TaskSetLimit(0.2), shared=TaskSetLimit(0), cross=TaskSetLimit(0)
        ),
        epoch_policy=EpochPolicy(update_every_rounds=1),
        batch_size=1,
        bridge_max_candidates=0,
    )


class EpochTests(unittest.TestCase):
    def test_period_boundaries_and_invalid_config(self):
        self.assertEqual([EpochPolicy(2).epoch(i) for i in range(6)], [1, 1, 2, 2, 3, 3])
        self.assertEqual([i for i in range(6) if EpochPolicy(2).due(i)], [2, 4])
        self.assertEqual([EpochPolicy().epoch(i) for i in range(6)], [1] * 6)
        for bad in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                EpochPolicy(bad)
        for bad in (-1, True, 31):
            with self.assertRaises(ValueError):
                EpochPolicy(max_historical_specialists=bad)

    def test_shared_epoch_and_state_version_are_frozen(self):
        ids = tuple(f"t{i}" for i in range(10))
        view = SearchView(
            ids, (Candidate("initial", dict.fromkeys(ids, 0)),), "initial", 4, 100, "fixed"
        )
        stable = StagedGEPA(parent_policy=lambda v: v.candidates[-1].id, batch_size=1)
        first = stable.step(view, {})
        view = replace(
            view,
            candidates=(
                *view.candidates,
                Candidate("candidate-1", {**dict.fromkeys(ids, 0), ids[0]: 1}),
            ),
        )
        state = {**json.loads(json.dumps(first.state)), "stage": "parents", "round": 1}
        second = stable.step(view, state)
        self.assertEqual(second.state["epoch_successes"], [])
        self.assertEqual(second.state["shared_epoch_successes"], {"1": []})
        with self.assertRaisesRegex(ValueError, "frozen runtime"):
            stable.step(view, {"recipe": "staged-gepa-v1"})
        self.assertEqual(StagedGEPA(ScopeConfig(), None, 1, 0).batch_size, 1)

    def test_guard_projection_uses_certified_scores_and_frozen_identity(self):
        from gear.algorithms.gepa.archive import project_seed_archive
        from gear.algorithms.gepa.research import must_pass_guard_identity

        scope = ArchiveScope(
            "guarded",
            "guarded",
            1,
            ("x", "guard"),
            {"x": 1, "guard": 0},
            must_pass_guard_identity(("guard",)),
        )
        view = SearchView(
            ("x", "guard"),
            (
                Candidate("initial", {"x": 0, "guard": 1}),
                Candidate("failed", {"x": 1, "guard": 0}),
                Candidate("pending", {"x": 1}),
            ),
            "initial",
            2,
            10,
            "fixed",
        )
        archive = project_seed_archive(view, (scope,), must_pass_guards={"guarded": ("guard",)})
        self.assertEqual(archive.parent_probabilities, {"initial": 1})
        self.assertEqual(archive.views["guarded"].ineligible_ids, ("failed",))
        self.assertEqual(archive.views["guarded"].pending_ids, ("pending",))
        for guards in ({"guarded": ("x",)}, {"guarded": ("HELD-OUT",)}, {"unknown": ("guard",)}):
            with self.assertRaises(ValueError):
                project_seed_archive(view, (scope,), must_pass_guards=guards)
        self.assertEqual(
            must_pass_guard_identity(("x", "guard", "x")), must_pass_guard_identity(("guard", "x"))
        )

    def test_frozen_legacy_epoch_admissions(self):
        fixture = Path(__file__).resolve().parents[2] / "test-contracts/gepa-epochs-v1.json"
        for row in json.loads(fixture.read_text())["cases"]:
            with self.subTest(case=row["name"]):
                spec = row["input"]
                quotes = []
                policy = EpochPolicy(spec["period"], spec["max_historical"])
                self.assertEqual(policy.epoch(spec["round_index"]), row["expected"]["epoch"])
                if not policy.due(spec["round_index"]):
                    self.assertEqual(row["expected"]["admission"], None)
                    continue

                def scope(s):
                    return ArchiveScope(**{**s, "task_ids": tuple(s["task_ids"])})

                def quote(ids, tasks):
                    cells = sum(f"{c}:{t}" not in spec["cached"] for c in ids for t in tasks)
                    cost = PreparationCost(cells, len(ids) * spec["repair_per_candidate"])
                    quotes.append(dict(ids=list(ids), tasks=list(tasks), cost=asdict(cost)))
                    return cost

                result = admit_scope_epoch(
                    scope(spec["previous"]),
                    scope(spec["proposed"]) if spec["proposed"] else None,
                    spec["anchor"],
                    tuple(spec["selected"]),
                    spec["historical_probabilities"],
                    policy,
                    PreparationCost(**spec["remaining"]),
                    quote,
                    historical_order=tuple(spec["historical_order"]),
                )
                self.assertEqual(
                    json.loads(json.dumps(asdict(result))), row["expected"]["admission"]
                )
                self.assertEqual(quotes, row["expected"]["quotes"])

    def _advance(self, *, omit_preparation=False):
        ids = tuple(f"t{i:02}" for i in range(20))
        view = SearchView(
            ids,
            (Candidate("initial", dict.fromkeys(ids, 0), "initial"),),
            "initial",
            4,
            200,
            "epoch-test",
            task_families=dict.fromkeys(ids, "same"),
        )
        state = {}
        decisions = []
        submitted = set()
        omitted = False
        for _ in range(100):
            before = copy.deepcopy(state)
            decision = recipe().step(view, state)
            self.assertEqual(state, before)
            self.assertEqual(
                asdict(decision), asdict(recipe().step(view, json.loads(json.dumps(state))))
            )
            state = json.loads(json.dumps(decision.state))
            decisions.append(decision)
            for op in decision.operations:
                self.assertLessEqual(set(op.tasks), set(ids))
                if op.kind == "generate":
                    view = replace(
                        view,
                        candidates=(*view.candidates, Candidate(op.candidate, {}, op.candidate)),
                    )
                if op.kind == "evaluate_seed":
                    candidate = next(c for c in view.candidates if c.id == op.candidate)
                    needed = [t for t in op.tasks if t not in candidate.scores]
                    self.assertLessEqual(len(needed), view.remaining_evaluations)
                    for t in needed:
                        key = (op.candidate, t)
                        self.assertNotIn(key, submitted)
                        submitted.add(key)
                    skipped = (
                        needed[:1]
                        if omit_preparation
                        and not omitted
                        and state["stage"] == "epoch-results"
                        and needed
                        else []
                    )
                    omitted = omitted or bool(skipped)
                    observed = {**candidate.scores, **{t: 0.5 for t in needed if t not in skipped}}
                    view = replace(
                        view,
                        candidates=tuple(
                            replace(c, scores=observed) if c.id == op.candidate else c
                            for c in view.candidates
                        ),
                        remaining_evaluations=view.remaining_evaluations - len(needed),
                    )
                if op.kind == "nominate":
                    return decisions, view, submitted
        self.fail("Did not terminate")

    def test_periodic_recipe_retains_catalog_and_freezes_selection_before_preparation(self):
        decisions, view, submitted = self._advance()
        prepared = [d for d in decisions if d.state["stage"] == "epoch-results"]
        self.assertGreaterEqual(len(prepared), 2)
        for d in prepared:
            pending = d.state["pending_epoch"]
            self.assertNotIn(pending["scope"]["id"], [c["scope"]["id"] for c in d.state["catalog"]])
            self.assertIn(d.state["parent"], pending["admission"]["participant_ids"])
            self.assertIn("initial", pending["admission"]["participant_ids"])
            # The allocation stays attached to the old archive even as the new scope is prepared.
            self.assertEqual(
                d.state["parent_selection"]["allocations"][0]["scope_id"],
                d.state["parent_scope"]["id"],
            )
            self.assertLess(d.state["parent_scope"]["epoch"], pending["scope"]["epoch"])
        final = decisions[-1].state
        self.assertEqual(
            len([d for d in decisions for op in d.operations if op.kind == "generate"]), 4
        )
        self.assertGreaterEqual(len(final["catalog"]), 4)
        self.assertEqual(final["catalog"][0]["scope"]["family"], "bootstrap")
        self.assertEqual(view.candidates[0].scores, dict.fromkeys(view.seed_tasks, 0))
        self.assertTrue(any(set(c.scores) < set(view.seed_tasks) for c in view.candidates[1:]))
        self.assertEqual(decisions[-1].operations[0].candidate, "initial")

    def test_incomplete_preparation_keeps_previous_scope_eligible(self):
        decisions, _, _ = self._advance(omit_preparation=True)
        rejected = []
        for d in decisions:
            rejected += [
                r
                for r in d.state.get("last_epoch_preparation", [])
                if r["status"] == "baseline-ineligible"
            ]
        self.assertTrue(rejected)
        rejected_scope = rejected[0]["proposed_scope_id"]
        self.assertFalse(
            any(c["scope"]["id"] == rejected_scope for c in decisions[-1].state["catalog"])
        )
        self.assertTrue(
            any(
                c["scope"]["id"] == rejected[0]["previous_scope_id"]
                for c in decisions[-1].state["catalog"]
            )
        )


if __name__ == "__main__":
    unittest.main()
