"""Opt-in pass-rate GEPA stages using only the public incremental contract.

This is a new recipe identity. It does not restore historical GEPA archives or
implement process/objective promotion and adaptive regression proposal stages.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field, replace
from fractions import Fraction
from typing import Any

from ..contracts import Decision, Operation, ParentPolicy, SearchView
from .archive import FrontierParentPolicy, comparison_key
from .bridge import BridgeNominee, select_bridge
from .scope_types import FailureFamily, SamplingTask, ScopeConfig, ordered_ids
from .scopes import create_scope


@dataclass(frozen=True)
class LocalPlan:
    candidate: str
    family: str
    task_ids: tuple[str, ...]
    weights: Mapping[str, float]


def _profiles(view: SearchView) -> dict[str, Mapping[str, float]]:
    return {candidate.id: candidate.scores for candidate in view.candidates}


def _score(
    view: SearchView,
    candidate: str,
    tasks: tuple[str, ...],
    weights: Mapping[str, float] | None = None,
) -> int | None:
    scores = _profiles(view).get(candidate, {})
    if not tasks or any(t not in scores for t in tasks):
        return None
    if any(not math.isfinite(scores[t]) or not 0 <= scores[t] <= 1 for t in tasks):
        raise ValueError("Staged GEPA requires pass scores in [0, 1]")
    values = [Fraction(str(scores[t])) for t in tasks]
    score = (
        sum((value * Fraction(str(weights[t])) for t, value in zip(tasks, values)), Fraction())
        if weights is not None
        else sum(values, Fraction()) / len(tasks)
    )
    return comparison_key(score)


def _missing(view: SearchView, candidates: tuple[str, ...], tasks: tuple[str, ...]) -> int:
    profiles = _profiles(view)
    return sum(
        task not in profiles.get(candidate, {}) for candidate in candidates for task in tasks
    )


def _plans(state: Mapping[str, Any]) -> tuple[LocalPlan, ...]:
    return tuple(
        LocalPlan(p["candidate"], p["family"], tuple(p["task_ids"]), dict(p["weights"]))
        for p in state.get("plans", [])
    )


@dataclass(frozen=True)
class StagedGEPA:
    scope_config: ScopeConfig = field(default_factory=ScopeConfig)
    parent_policy: ParentPolicy = field(default_factory=FrontierParentPolicy)
    batch_size: int = 2
    bridge_max_candidates: int = 2

    def __post_init__(self) -> None:
        if type(self.batch_size) is not int or not 1 <= self.batch_size <= 16:
            raise ValueError("Batch size must be between one and sixteen")
        if type(self.bridge_max_candidates) is not int or self.bridge_max_candidates < 0:
            raise ValueError("Bridge quota must be a nonnegative integer")

    def _nominate(self, view: SearchView, state: Mapping[str, Any], reason: str) -> Decision:
        eligible = []
        for candidate in view.candidates:
            score = _score(view, candidate.id, view.seed_tasks)
            if score is not None and all(
                candidate.scores.get(t) == 1 for t in self.scope_config.guard_task_ids
            ):
                eligible.append((candidate.id, score))
        nominee = (
            min(eligible, key=lambda item: (-item[1], item[0].encode("utf-16-be")))[0]
            if eligible
            else view.champion
        )
        return Decision(
            {**state, "stage": "done"}, (Operation("nominate", candidate=nominee),), reason
        )

    def step(self, view: SearchView, state: Mapping[str, Any]) -> Decision:
        if state and state.get("recipe") != "staged-gepa-v1":
            raise ValueError("State belongs to another recipe; use its frozen runtime")
        current = {"recipe": "staged-gepa-v1", "stage": "parents", "index": 0, "round": 0, **state}
        stage, index, round_index = current["stage"], current["index"], current["round"]
        if type(index) is not int or index < 0 or type(round_index) is not int or round_index < 0:
            raise ValueError("Invalid staged GEPA counters")
        if stage == "done":
            return Decision(current, (Operation("stop"),), "Search finished")
        config = replace(self.scope_config, seed=view.random_seed)
        tasks = tuple(SamplingTask(t, view.task_families.get(t, "seed")) for t in view.seed_tasks)
        if stage == "parents":
            if index >= view.max_candidates or view.remaining_evaluations < len(view.seed_tasks):
                return self._nominate(view, current, "Nominate from complete common seed evidence")
            parent = self.parent_policy(view)
            if _score(view, parent, view.seed_tasks) is None:
                raise ValueError("Parent must have complete seed evidence")
            scores = _profiles(view)[parent]
            families: dict[str, list[str]] = {}
            for task in tasks:
                if scores[task.id] < 1:
                    families.setdefault(task.stratum, []).append(task.id)
            if not families:
                return self._nominate(
                    view, current, "Selected parent has no observed seed failures"
                )
            family_ids = ordered_ids(list(families))
            offset = round_index % len(family_ids)
            family_ids = family_ids[offset:] + family_ids[:offset]
            successes = tuple(t for t in view.seed_tasks if scores[t] == 1)
            proposals: list[LocalPlan] = []
            for family_id in family_ids[: min(self.batch_size, view.max_candidates - index)]:
                controls = tuple(
                    t.id for t in tasks if t.stratum == family_id and t.id in successes
                )
                scope = create_scope(
                    tasks,
                    config,
                    FailureFamily(family_id, tuple(families[family_id]), controls),
                    successes,
                )
                if scope is not None:
                    proposals.append(
                        LocalPlan(
                            f"candidate-{index + len(proposals) + 1}",
                            family_id,
                            scope.task_ids,
                            scope.weights,
                        )
                    )
            # Reserve a conservative full-seed expansion before any generation.
            while (
                proposals
                and sum(len(p.task_ids) for p in proposals) + len(view.seed_tasks)
                > view.remaining_evaluations
            ):
                proposals.pop()
            if not proposals:
                return self._nominate(
                    view, current, "Budget cannot cover a local scope and seed expansion"
                )
            operations = tuple(
                op
                for p in proposals
                for op in (
                    Operation("diagnose_seed", candidate=parent, tasks=p.task_ids),
                    Operation("generate", candidate=p.candidate, parent=parent),
                )
            )
            return Decision(
                {
                    **current,
                    "stage": "local",
                    "parent": parent,
                    "index": index + len(proposals),
                    "plans": [asdict(p) for p in proposals],
                },
                operations,
                "Generate one candidate per admitted failure family",
            )
        plans = _plans(current)
        next_round = {**current, "stage": "parents", "round": round_index + 1, "plans": []}
        if stage == "local":
            invalid = {
                r.get("candidate")
                for r in view.completed.values()
                if r.get("kind") == "generate" and r.get("status") == "invalid-candidate"
            }
            live = tuple(p for p in plans if p.candidate not in invalid)
            if not live:
                return self.step(view, next_round)
            if any(p.candidate not in _profiles(view) for p in live):
                raise ValueError("Generation has no terminal receipt or candidate")
            if (
                sum(_missing(view, (p.candidate,), p.task_ids) for p in live)
                > view.remaining_evaluations
            ):
                return self._nominate(view, current, "Budget cannot cover the complete local group")
            return Decision(
                {**current, "stage": "bridge", "plans": [asdict(p) for p in live]},
                tuple(
                    Operation("evaluate_seed", candidate=p.candidate, tasks=p.task_ids)
                    for p in live
                ),
                "Evaluate admitted local scopes before nominating bridge participants",
            )
        if stage == "bridge":
            nominees = []
            for plan in sorted(plans, key=lambda p: p.family.encode("utf-16-be")):
                score = _score(view, plan.candidate, plan.task_ids, plan.weights)
                before = _score(view, str(current["parent"]), plan.task_ids, plan.weights)
                if (
                    score is not None
                    and before is not None
                    and score > before
                    and all(
                        _profiles(view)[plan.candidate].get(t) == 1 for t in config.guard_task_ids
                    )
                ):
                    nominees.append(BridgeNominee(plan.candidate, plan.family, plan.task_ids))

            def affordable(ids: tuple[str, ...], selected: tuple[str, ...]) -> bool:
                remaining = tuple(t for t in view.seed_tasks if t not in selected)
                expansion = max((_missing(view, (c,), remaining) for c in ids), default=0)
                return _missing(view, ids, selected) + expansion <= view.remaining_evaluations

            selection = select_bridge(
                tasks,
                config,
                round_index,
                tuple(nominees),
                view.champion,
                config.guard_task_ids,
                self.bridge_max_candidates,
                affordable,
            )
            if selection.plan is None:
                return self.step(view, {**next_round, "last_bridge": asdict(selection)})
            bridge = selection.plan
            return Decision(
                {**current, "stage": "global", "last_bridge": asdict(selection)},
                tuple(
                    Operation("evaluate_seed", candidate=c, tasks=bridge.task_ids)
                    for c in bridge.participant_ids
                ),
                "Compare bridge participants on one complete shared scope",
            )
        if stage == "global":
            bridge = current["last_bridge"]["plan"]
            members = tuple(bridge["participant_ids"])
            selected = tuple(bridge["task_ids"])
            bridge_scores = {c: _score(view, c, selected) for c in members}
            if any(value is None for value in bridge_scores.values()):
                return self._nominate(
                    view, current, "Bridge evidence is incomplete; do not rank partial results"
                )
            winner = min(
                members, key=lambda c: (-int(bridge_scores[c] or 0), c.encode("utf-16-be"))
            )
            if _missing(view, (winner,), view.seed_tasks) > view.remaining_evaluations:
                return self._nominate(
                    view, current, "Budget cannot complete the nominated seed scope"
                )
            if _score(view, winner, view.seed_tasks) is not None:
                return self.step(view, next_round)
            return Decision(
                next_round,
                (Operation("evaluate_seed", candidate=winner, tasks=view.seed_tasks),),
                "Complete global seed evidence for the bridge nominee",
            )
        raise ValueError(f"Unknown staged GEPA stage: {stage}")
