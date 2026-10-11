import copy
from dataclasses import asdict, replace
import json
from pathlib import Path
import unittest

from gear.algorithms import Candidate, SearchView, StagedGEPA, EpochPolicy
from gear.algorithms.gepa.history import (
    SamplingDiagnosis,
    SamplingFeature,
    SamplingObservation,
    SamplingTaskContract,
    project_sampling_evidence,
    sampling_evidence,
)
from gear.algorithms.gepa.scope_types import SamplingTask
from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit

FIXTURE = Path(__file__).resolve().parents[2] / "test-contracts/gepa-history-v1.json"


def build(spec):
    return sampling_evidence(
        tuple(
            SamplingTaskContract(
                SamplingTask(
                    **{
                        **c["task"],
                        "family_ids": tuple(c["task"]["family_ids"]),
                        "submodes": tuple(c["task"]["submodes"]),
                        "modification_paths": tuple(c["task"]["modification_paths"]),
                    }
                ),
                c["identity"],
                tuple(c["slots"]),
                c["success_utility"],
            )
            for c in spec["contracts"]
        ),
        spec["condition_identity"],
        spec["cutoff_identity"],
        tuple(
            SamplingDiagnosis(
                d["family_id"],
                tuple(d["task_ids"]),
                tuple(d["successful_control_task_ids"]),
                tuple(d["modification_paths"]),
                {
                    t: SamplingFeature(tuple(v["submodes"]), tuple(v["modification_paths"]))
                    for t, v in d["features"].items()
                },
            )
            for d in spec["diagnoses"]
        ),
        tuple(SamplingObservation(**c) for c in spec["observations"]),
        objective=spec["objective"],
    )


class SamplingHistoryTests(unittest.TestCase):
    def test_fixed_historical_metadata_and_complete_version_difficulty(self):
        for case in json.loads(FIXTURE.read_text())["cases"]:
            with self.subTest(case=case["name"]):
                before = copy.deepcopy(case["input"])
                result = build(case["input"])
                self.assertEqual(json.loads(json.dumps(asdict(result))), case["expected"])
                self.assertEqual(build(case["input"]), result)
                self.assertEqual(before, case["input"])
                self.assertEqual(
                    build({**before, "observations": list(reversed(before["observations"]))}),
                    result,
                )

    def test_rejects_foreign_conditions_task_contracts_slots_and_outcome_replacement(self):
        spec = json.loads(FIXTURE.read_text())["cases"][1]["input"]
        for change in (
            {"condition_identity": "other"},
            {"task_identity": "other"},
            {"task_id": "HELD-OUT"},
            {"slot": "99:0"},
            {"utility": float("nan")},
        ):
            changed = copy.deepcopy(spec)
            changed["observations"][0].update(change)
            with self.assertRaises(ValueError):
                build(changed)
        for change in ({"utility": 0.1}, {"evidence_identity": "rerun"}):
            changed = copy.deepcopy(spec)
            changed["observations"].append({**changed["observations"][0], **change})
            with self.assertRaisesRegex(ValueError, "replace a valid"):
                build(changed)
        changed = copy.deepcopy(spec)
        changed["diagnoses"] = [
            {
                "family_id": "private",
                "task_ids": ["HELD-OUT"],
                "successful_control_task_ids": [],
                "modification_paths": [],
                "features": {},
            }
        ]
        with self.assertRaisesRegex(ValueError, "outside seed"):
            build(changed)
        with self.assertRaisesRegex(ValueError, "seed-only"):
            sampling_evidence((), "c", "cut", (), (), partition="held-out")

    def test_unavailable_revision_cannot_replace_valid_zero_or_create_difficulty(self):
        contract = SamplingTaskContract(SamplingTask("x", "family"), "task", ("0", "1"))
        valid = SamplingObservation("x", "task", "c", "version", "0", 0, "evidence")
        unavailable = replace(valid, utility=None, evidence_identity="unavailable")
        first = sampling_evidence((contract,), "c", "cut", (), (valid, unavailable))
        self.assertIsNone(first.tasks[0].historical_difficulty)
        second = sampling_evidence(
            (contract,),
            "c",
            "cut",
            (),
            (unavailable, valid, replace(valid, slot="1", utility=1, evidence_identity="other")),
        )
        self.assertEqual(second.tasks[0].historical_difficulty, 1)

    def test_project_cache_alias_and_independent_execution_versions_are_distinct(self):
        first = Candidate("a", {"x": 1}, "same-content", "execution-a", {"x": "evidence-a"})
        alias = replace(first, id="alias")
        failed = Candidate("b", {"x": 0}, "same-content", "execution-b", {"x": "evidence-b"})
        view = SearchView(
            ("x",), (first, failed), "a", 2, 20, "seed", evidence_condition="condition"
        )
        original = project_sampling_evidence(view)
        self.assertEqual(original.tasks[0].historical_difficulty, 0.5)
        self.assertEqual(
            project_sampling_evidence(replace(view, candidates=(alias, failed, first))), original
        )
        with self.assertRaisesRegex(ValueError, "replace a valid"):
            project_sampling_evidence(
                replace(view, candidates=(first, replace(alias, scores={"x": 0})))
            )
        # Legacy/toy callers without execution provenance do not infer reuse from equal content.
        legacy = replace(
            view,
            candidates=(
                replace(first, execution_digest=None, score_evidence={}),
                replace(failed, execution_digest=None, score_evidence={}),
            ),
        )
        self.assertEqual(project_sampling_evidence(legacy).tasks[0].historical_difficulty, 0.5)

    def test_project_provenance_requires_exact_nonempty_seed_references(self):
        candidate = Candidate("a", {"x": 1}, "content", "execution", {"x": "source"})
        view = SearchView(("x",), (candidate,), "a", 1, 10, "seed")
        for references in ({}, {"x": ""}, {"x": "source", "HELD-OUT": "private"}):
            with self.subTest(references=references):
                with self.assertRaisesRegex(ValueError, "complete seed evidence"):
                    project_sampling_evidence(
                        replace(view, candidates=(replace(candidate, score_evidence=references),))
                    )

    def test_staged_planning_records_only_metadata_from_its_frozen_seed_cutoff(self):
        ids = tuple(f"t{i}" for i in range(20))
        view = SearchView(
            ids, (Candidate("initial", dict.fromkeys(ids, 0)),), "initial", 4, 100, "seed"
        )
        decision = StagedGEPA(epoch_policy=EpochPolicy(1)).step(view, {})
        evidence = decision.state["sampling_evidence"]
        self.assertTrue(evidence["cutoff_identity"].startswith("sha256:"))
        self.assertTrue(all(t["historical_difficulty"] == 1 for t in evidence["tasks"]))
        self.assertNotIn("observations", evidence)
        self.assertNotIn(
            "sampling_coverage", decision.state
        )  # needed only while preparation is pending
        self.assertEqual(set(t["id"] for t in evidence["tasks"]), set(ids))

    def test_unrelated_preparation_scores_do_not_enter_current_diagnosis_controls(self):
        ids = tuple(f"t{i:02}" for i in range(20))
        view = SearchView(
            ids, (Candidate("initial", dict.fromkeys(ids, 0)),), "initial", 4, 100, "seed"
        )
        recipe = StagedGEPA(
            scope_config=ScopeConfig(
                local=TaskSetLimit(0.2), shared=TaskSetLimit(0), cross=TaskSetLimit(0)
            ),
            batch_size=1,
        )
        first = recipe.step(view, {})
        scope = first.state["catalog"][-1]["scope"]
        historical = Candidate("historical", dict.fromkeys(scope["task_ids"], 0.5))
        view = replace(view, candidates=(*view.candidates, historical))
        # A committed planning checkpoint after selecting this local parent,
        # before unrelated scope preparation returned additional scores.
        state = {
            **copy.deepcopy(first.state),
            "stage": "epochs",
            "parent_batches": [
                {
                    "batch_id": "round-0-batch-0",
                    "parent": "historical",
                    "scope_id": scope["id"],
                    "slots": 1,
                    "draw_index": 0,
                    "branch": None,
                }
            ],
            "planning_family_history": copy.deepcopy(first.state["family_history"]),
            "epoch_queue": [],
            "sampling_coverage": {c.id: list(c.scores) for c in view.candidates},
            "sampling_evidence": asdict(project_sampling_evidence(view)),
        }
        original = recipe.step(view, state)
        extra = next(t for t in ids if t not in historical.scores)
        updated = replace(historical, scores={**historical.scores, extra: 1})
        after_preparation = recipe.step(
            replace(view, candidates=(view.candidates[0], updated)), state
        )
        self.assertEqual(
            original.state["family_history"], after_preparation.state["family_history"]
        )
        self.assertEqual(
            original.state["batch_sampling"], after_preparation.state["batch_sampling"]
        )
        self.assertEqual(original.operations, after_preparation.operations)


if __name__ == "__main__":
    unittest.main()
