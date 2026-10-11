import copy
from dataclasses import asdict, fields
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from gear.algorithms import Candidate, Decision, Operation, SearchView
from gear.algorithms.gepa.proposal import CandidateWorkPlan, GenerationBudget
from gear._protocol.canonical import digest
from gear._protocol.generated import PROTOCOL, validate_wire_type

FIXTURE = Path(__file__).resolve().parents[2] / "test-contracts/algorithm-payload-v1.json"


def request():
    view = SearchView(("seed",), (Candidate("initial", {"seed": 0}),), "initial", 1, 20, "seed")
    payload = {"view": asdict(view), "state": {}}
    return {"protocol_version": 1, "request_id": "request", "run_id": "run", "step_id": 0,
            "input_digest": digest(payload), "input": payload, "capabilities": PROTOCOL["capabilities"]}


class PayloadTests(unittest.TestCase):
    def test_fixed_cross_language_vectors(self):
        for row in json.loads(FIXTURE.read_text())["cases"]:
            with self.subTest(row=row["name"]):
                original = copy.deepcopy(row["value"])
                if row["valid"]:
                    validate_wire_type(row["type"], row["value"])
                else:
                    with self.assertRaisesRegex(ValueError, "protocol-payload-invalid"):
                        validate_wire_type(row["type"], row["value"])
                self.assertEqual(row["value"], original)

    def test_author_dataclasses_cover_generated_fields(self):
        for author, name in [(Candidate, "CandidateView"), (SearchView, "SearchView"),
                             (Operation, "AlgorithmOperation"), (Decision, "AlgorithmDecision"),
                             (CandidateWorkPlan, "CandidateWorkPlan"), (GenerationBudget, "GenerationBudget")]:
            self.assertEqual({f.name for f in fields(author)}, set(PROTOCOL["types"][name]["properties"]))
        validate_wire_type("AlgorithmRequest", request())
        validate_wire_type("AlgorithmDecision", asdict(Decision({}, (Operation("stop"),), "done")))

    def test_open_state_is_bounded_json_and_does_not_echo_private_values(self):
        cycle = {}; cycle["self"] = cycle
        deep = 0
        for _ in range(65): deep = [deep]
        for value in [float("nan"), float("inf"), 2**53, 10**1000, object(), {1: "bad"}, "\ud800", cycle, deep]:
            with self.subTest(type=type(value)), self.assertRaisesRegex(ValueError, "protocol-payload-invalid"):
                validate_wire_type("JsonObject", {"private": value})
        # The last admitted level is inclusive; paths never contain user map keys.
        valid = 0
        for _ in range(63): valid = [valid]
        validate_wire_type("JsonObject", {"nested": valid})
        try:
            validate_wire_type("JsonObject", {"PRIVATE_SECRET": object()})
        except ValueError as error:
            self.assertNotIn("PRIVATE_SECRET", str(error))

    def test_invalid_input_is_rejected_before_loading_plugin(self):
        bad = request()
        bad["input"]["view"]["remaining_evaluations"] = True
        bad["input_digest"] = digest(bad["input"])
        result = subprocess.run([sys.executable, "-m", "gear._protocol.worker", "missing_plugin:Algorithm"],
                                input=json.dumps(bad) + "\n", text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("protocol-payload-invalid", result.stderr)
        self.assertNotIn("ModuleNotFoundError", result.stderr)

    def test_invalid_plugin_output_is_not_emitted(self):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, "invalid.py").write_text(
                "from gear.algorithms import Decision, Operation\n"
                "class Algorithm:\n"
                "    def step(self, view, state):\n"
                "        assert type(view.max_candidates) is int\n"
                "        assert type(view.remaining_evaluations) is int\n"
                "        return Decision({}, (Operation('execute'),), 'invalid')\n")
            env = {**os.environ, "PYTHONPATH": os.pathsep.join([temp, str(Path(__file__).resolve().parents[1])])}
            message = request()
            message["input"]["view"]["max_candidates"] = 1.0
            message["input"]["view"]["remaining_evaluations"] = 20.0
            message["input_digest"] = digest(message["input"])
            result = subprocess.run([sys.executable, "-m", "gear._protocol.worker", "invalid:Algorithm"],
                                    input=json.dumps(message) + "\n", text=True, capture_output=True, env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("protocol-payload-invalid", result.stderr)

    def test_non_utf8_input_is_rejected(self):
        raw = json.dumps(request()).encode("utf-16-le") + b"\n"
        result = subprocess.run([sys.executable, "-m", "gear._protocol.worker"], input=raw, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main()
