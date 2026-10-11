"""Offline public-contract checks over the fixed CPU toy round."""

from __future__ import annotations

import copy
import re
from collections.abc import Mapping
from dataclasses import asdict
from typing import Any

from .._protocol.canonical import digest
from .._protocol.generated import validate_algorithm_decision
from ..algorithms import Decision, SearchAlgorithm, SearchView
from .toy import toy_round


class _CheckedAlgorithm:
    def __init__(self, algorithm: SearchAlgorithm):
        self.algorithm = algorithm

    def step(self, view: SearchView, state: Mapping[str, Any]) -> Decision:
        original = digest({"view": asdict(view), "state": state})
        first = self.algorithm.step(view, state)
        if digest({"view": asdict(view), "state": state}) != original:
            raise ValueError("algorithm-mutated-input")
        if not isinstance(first, Decision):
            raise TypeError("algorithm-must-return-Decision")
        validate_algorithm_decision(asdict(first))
        first = copy.deepcopy(first)
        repeated_view, repeated_state = copy.deepcopy(view), copy.deepcopy(state)
        second = self.algorithm.step(repeated_view, repeated_state)
        if digest({"view": asdict(repeated_view), "state": repeated_state}) != original:
            raise ValueError("algorithm-mutated-input")
        if not isinstance(second, Decision):
            raise TypeError("algorithm-must-return-Decision")
        validate_algorithm_decision(asdict(second))
        if digest(asdict(first)) != digest(asdict(second)):
            raise ValueError("algorithm-decision-not-deterministic")
        candidates = {c.id for c in view.candidates}
        coverage = {c.id: set(c.scores) for c in view.candidates}
        for index, operation in enumerate(first.operations):
            if not set(operation.tasks) <= set(view.seed_tasks):
                raise ValueError("algorithm-tasks-outside-admitted-seed")
            if operation.kind == "generate":
                if (
                    not re.fullmatch(r"[a-zA-Z0-9_-]+", operation.candidate)
                    or operation.candidate in candidates
                    or operation.parent not in candidates
                    or len(candidates) - 1 >= view.max_candidates
                ):
                    raise ValueError("algorithm-invalid-candidate-allocation")
                candidates.add(operation.candidate)
                coverage[operation.candidate] = set()
            elif operation.kind != "stop" and operation.candidate not in candidates:
                raise ValueError("algorithm-unknown-candidate")
            if operation.diagnosis_id is not None:
                source = view.completed.get(operation.diagnosis_id, {})
                if (
                    operation.kind != "generate"
                    or source.get("kind") != "diagnose_seed"
                    or source.get("candidate") != operation.parent
                ):
                    raise ValueError("algorithm-invalid-diagnosis-binding")
            if operation.kind in {"nominate", "stop"} and index != len(first.operations) - 1:
                raise ValueError("algorithm-terminal-operation-must-be-last")
            if operation.kind == "evaluate_seed" and not operation.tasks:
                raise ValueError("algorithm-empty-evaluation")
            if operation.kind == "evaluate_seed":
                coverage[operation.candidate].update(operation.tasks)
            if (
                operation.kind == "nominate"
                and not set(view.seed_tasks) <= coverage[operation.candidate]
            ):
                raise ValueError("algorithm-nomination-needs-complete-seed")
        return first


def check_algorithm(algorithm: SearchAlgorithm, *, max_steps: int = 100) -> dict[str, Any]:
    """Check replay, input immutability, seed scope and allocation in a toy round.

    This does not execute real projects, call models or prove search quality.
    Production execution repeats semantic validation in the durable runtime.
    """
    result = toy_round(_CheckedAlgorithm(algorithm), max_steps=max_steps)
    return {
        "ok": True,
        "scope": "cpu-toy-contract",
        "nominee": result["nominee"],
        "steps": result["steps"],
        "decision_digest": digest([asdict(d) for d in result["decisions"]]),
        "checks": [
            "deterministic-replay",
            "immutable-input",
            "seed-scope",
            "candidate-allocation",
            "bounded-operations",
        ],
    }
