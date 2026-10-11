import dataclasses
import importlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

from gear import Project
from gear.algorithms import GEPA, Decision, Operation
from gear.testing import toy_round
from gear._protocol.canonical import digest


class PublicGearTests(unittest.TestCase):
    def test_import_is_cpu_only_and_compatibility_is_one_implementation(self):
        from gear.training import TrainingLoop
        from gear_training import TrainingLoop as LegacyLoop
        self.assertIs(TrainingLoop, LegacyLoop)
        self.assertIs(importlib.import_module("gear.training.loop"), importlib.import_module("gear_training.loop"))
        subprocess.run([sys.executable, "-c", "import sys; import gear; import gear.training; assert not ({\"torch\", \"slime\"} & set(sys.modules))"], check=True)

    def test_one_function_replaces_parent_choice(self):
        chosen = []
        def parent(view):
            chosen.append(view.champion)
            return view.champion
        result = toy_round(GEPA(parent_policy=parent))
        self.assertEqual(result["nominee"], "candidate-1")
        self.assertEqual(chosen, ["initial"])

    def test_entire_algorithm_can_change_order_using_only_public_api(self):
        class BaselineOnly:
            def step(self, view, state):
                operation = Operation("stop") if state else Operation("nominate", candidate=view.champion)
                return Decision({"done": True}, (operation,), "Retain baseline")
        self.assertEqual(toy_round(BaselineOnly())["nominee"], "initial")

    def test_stop_rule_is_a_public_replaceable_function(self):
        result = toy_round(GEPA(stop_rule=lambda view, count: True))
        self.assertEqual(result["nominee"], "initial")
        self.assertFalse(any(op.kind == "generate" for d in result["decisions"] for op in d.operations))

    def test_toy_reuses_observed_zero_without_resampling_or_recharging(self):
        observed = []
        class ReuseBaseline:
            def step(self, view, state):
                if not state:
                    return Decision({'done': True}, (Operation('evaluate_seed', candidate='initial', tasks=('sum',)),), 'Reuse the observed seed')
                observed.append((dict(view.candidates[0].scores), view.remaining_evaluations))
                return Decision(state, (Operation('stop'),), 'Finished')
        toy_round(ReuseBaseline())
        self.assertEqual(observed, [({'sum': 0.0, 'case': 1.0}, 20)])

    def test_invalid_generation_consumes_candidate_attempt_and_can_nominate_baseline(self):
        from gear.algorithms import Candidate, SearchView
        view = SearchView(("seed",), (Candidate("initial", {"seed": 0}),), "initial", 1, 10, "fixed",
                          {"receipt": {"kind": "generate", "candidate": "candidate-1", "status": "invalid-candidate"}})
        result = GEPA().step(view, {"stage": "local", "index": 0, "parent": "initial"})
        self.assertEqual(result.operations[0].kind, "nominate")
        self.assertEqual(result.operations[0].candidate, "initial")

    def test_canonical_rejects_nonfinite_and_unsafe_integer(self):
        for value in [float("nan"), float("inf"), 2**53]:
            with self.assertRaises(ValueError): digest(value)
        self.assertEqual(digest(1), digest(1.0))
        self.assertEqual(digest(-0.0), digest(0))

    def test_protocol_roundtrip_and_no_raw_project_access(self):
        from gear.algorithms import Candidate, SearchView
        payload = {"view": dataclasses.asdict(SearchView(("seed",), (Candidate("initial", {"seed": 0}),), "initial", 1, 20, "fixed")), "state": {}}
        from gear._protocol.generated import PROTOCOL
        request = {"capabilities": PROTOCOL["capabilities"], "protocol_version": 1, "request_id": "request", "run_id": "run", "step_id": 0,
                   "input_digest": digest(payload), "input": payload}
        result = subprocess.run([sys.executable, "-m", "gear._protocol.worker"], input=json.dumps(request) + "\n", text=True, capture_output=True, check=True)
        response = json.loads(result.stdout)
        self.assertEqual(response["input_digest"], request["input_digest"])
        self.assertEqual(response["decision"]["operations"][0]["kind"], "diagnose_seed")


if __name__ == "__main__":
    unittest.main()
