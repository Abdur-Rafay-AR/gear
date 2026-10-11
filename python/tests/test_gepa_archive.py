import copy
import dataclasses
import json
from pathlib import Path
import unittest

from gear.algorithms.gepa.archive import FrontierCandidate
from gear.algorithms.gepa.parent_plan import (
    ParentAllocation,
    ParentPlan,
    parent_input,
    validate_parent_plan,
)
from gear.algorithms.gepa.parent_policies import ChampionGepaPolicy, ScopedFrontierPolicy
from gear.algorithms.gepa.parent_random import RandomSource
from gear.algorithms.gepa.research import (
    ArchiveMember,
    ArchiveScope,
    ScopedProfile,
    build_research_archive,
)

FIXTURE = Path(__file__).resolve().parents[2] / "test-contracts/gepa-archive-v1.json"


def wire(value):
    return json.loads(json.dumps(dataclasses.asdict(value)))


def build(spec):
    return build_research_archive(
        tuple(spec["seed_tasks"]),
        tuple(ArchiveMember(**member) for member in spec["members"]),
        tuple(ArchiveScope(**{**s, "task_ids": tuple(s["task_ids"])}) for s in spec["scopes"]),
        tuple(
            ScopedProfile(
                p["scope_id"],
                FrontierCandidate(
                    **{
                        **p["candidate"],
                        "score_keys": {k: int(v) for k, v in p["candidate"]["score_keys"].items()},
                        "process_keys": {
                            k: int(v) for k, v in p["candidate"]["process_keys"].items()
                        },
                        "aggregate_key": int(p["candidate"]["aggregate_key"])
                        if p["candidate"]["aggregate_key"] is not None
                        else None,
                    }
                ),
            )
            for p in spec["observations"]
        ),
        spec["champion"],
        candidate_order=tuple(spec["candidate_order"]),
        family_order=tuple(spec["family_order"]),
        scope_order=tuple(spec["scope_order"]),
    )


class ResearchArchiveTests(unittest.TestCase):
    def test_frozen_legacy_archives_and_all_parent_allocations(self):
        for case in json.loads(FIXTURE.read_text())["cases"]:
            with self.subTest(case=case["name"]):
                original = copy.deepcopy(case["input"])
                archive = build(original)
                projection = wire(archive)
                for key in (
                    "views",
                    "scope_probabilities",
                    "parent_probabilities",
                    "active_parent_ids",
                    "champion",
                ):
                    self.assertEqual(projection[key], case["expected"][key], key)
                view = parent_input(archive, 5, original["random_seed"], include_champion=True)
                random = RandomSource(view.random_seed, tuple(original["random_order"]))
                for spec in case["expected"]["policies"]:
                    policy = (
                        ScopedFrontierPolicy(spec["config"])
                        if spec["name"] == "scoped"
                        else ChampionGepaPolicy(spec["config"])
                    )
                    first = policy(view, random)
                    self.assertEqual(wire(first), spec["expected"], (spec["name"], spec["config"]))
                    self.assertEqual(first, policy(view, random))
                self.assertEqual(original, case["input"])

    def test_seed_identity_epoch_and_profile_conflicts_are_rejected(self):
        spec = json.loads(FIXTURE.read_text())["cases"][1]["input"]
        variants = []
        outside = copy.deepcopy(spec)
        outside["scopes"][0]["task_ids"].append("PRIVATE-HELDOUT")
        variants.append((outside, "outside seed"))
        identity = copy.deepcopy(spec)
        identity["observations"][0]["candidate"]["identity"] = "changed"
        variants.append((identity, "identity changed"))
        epoch = copy.deepcopy(spec)
        epoch["scopes"][1]["family"] = "bootstrap"
        epoch["scopes"][1]["epoch"] = 0
        epoch["family_order"].remove("alpha")
        variants.append((epoch, "epoch manifest changed"))
        conflict = copy.deepcopy(spec)
        row = copy.deepcopy(conflict["observations"][0])
        row["candidate"]["score_keys"]["task-0"] = "999"
        conflict["observations"].append(row)
        variants.append((conflict, "Conflicting certified"))
        for value, message in variants:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                build(value)
        with self.assertRaisesRegex(ValueError, "seed-only"):
            build_research_archive(("x",), (), (), (), "champion", partition="held-out")

    def test_parent_contract_rejects_outside_allocations_and_invalid_budget(self):
        spec = json.loads(FIXTURE.read_text())["cases"][0]["input"]
        view = parent_input(build(spec), 2, "fixed", include_champion=True)
        good = ScopedFrontierPolicy()(view, RandomSource("fixed"))
        invalid = [
            dataclasses.replace(
                good, allocations=(dataclasses.replace(good.allocations[0], scope_id="unknown"),)
            ),
            dataclasses.replace(
                good, allocations=(dataclasses.replace(good.allocations[0], slots=3),)
            ),
            dataclasses.replace(
                good, allocations=(dataclasses.replace(good.allocations[0], slots=True),)
            ),
            dataclasses.replace(good, parent_probabilities={"outside": 1}),
            dataclasses.replace(good, reason_codes=()),
            ParentPlan((), {"initial": 1}, ("bad abstention",)),
        ]
        for plan in invalid:
            with self.assertRaises(ValueError):
                validate_parent_plan(view, plan)
        validate_parent_plan(view, ParentPlan.abstain(reason="no budget"))
        with self.assertRaises(ValueError):
            ScopedFrontierPolicy(3)(view, RandomSource("fixed"))
        with self.assertRaises(ValueError):
            ChampionGepaPolicy()(dataclasses.replace(view, champion=None), RandomSource("fixed"))

    def test_project_projection_keeps_local_complete_parents_without_inventing_global_evidence(
        self,
    ):
        from gear.algorithms import Candidate, SearchView
        from gear.algorithms.gepa.archive import project_seed_archive
        from gear.algorithms.gepa.sampling import sample_tasks

        view = SearchView(
            ("x", "y"),
            (
                Candidate("initial", {"x": 0, "y": 0}),
                Candidate("A", {"x": 1}),
                Candidate("B", {"y": 1}),
            ),
            "initial",
            2,
            10,
            "fixed",
        )
        scopes = (
            ArchiveScope("left", "left", 1, ("x",), {"x": 1}),
            ArchiveScope("right", "right", 1, ("y",), {"y": 1}),
        )
        archive = project_seed_archive(view, scopes, {"left": ("A",), "right": ("B",)})
        self.assertEqual(archive.parent_probabilities, {"A": 0.5, "B": 0.5})
        self.assertIsNone(archive.champion)
        self.assertEqual(view.candidates[1].scores, {"x": 1})
        partial = dataclasses.replace(view, candidates=(Candidate("initial", {"x": 0}),))
        self.assertEqual(sample_tasks(partial, "initial"), ("x",))
        with self.assertRaisesRegex(ValueError, "Unknown scope/candidate"):
            project_seed_archive(view, scopes, {"left": ("unknown",)})
        with self.assertRaisesRegex(ValueError, "trusted guard"):
            project_seed_archive(view, (dataclasses.replace(scopes[0], guard_identity="guard-v1"),))

    def test_choice_records_whole_distribution_and_index_without_mutable_rng_state(self):
        random = RandomSource("fixed")
        one = random.choice({"A": 0.1, "B": 0.9}, index=5)
        random.choice({"A": 0.9, "B": 0.1}, index=100)
        self.assertEqual(one, random.choice({"B": 0.9, "A": 0.1}, index=5))
        self.assertEqual(one.probabilities, {"A": 0.1, "B": 0.9})
        self.assertNotEqual(
            one.input_digest, random.choice({"A": 0.1, "B": 0.9}, index=6).input_digest
        )
        with self.assertRaises(ValueError):
            random.choice({"A": 1}, index=True)
        with self.assertRaises(ValueError):
            RandomSource("fixed", ("A",)).choice({"B": 1}, index=0)


if __name__ == "__main__":
    unittest.main()
