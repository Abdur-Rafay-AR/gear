"""Opt-in pass-rate GEPA stages using only the public incremental contract.

This is a new recipe identity. It does not restore historical GEPA archives or
implement process/objective promotion and adaptive regression proposal stages.
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import asdict, dataclass, field, replace
from typing import Any

from ..contracts import Decision, Operation, ParentPolicy, SearchView
from .bridge import BridgeNominee, select_bridge
from .epochs import EpochPolicy
from .scope_types import SamplingTask, ScopeConfig
from .stage_evidence import missing as _missing
from .stage_evidence import nominate
from .stage_evidence import profiles as _profiles
from .stage_evidence import score as _score
from .stage_planning import plan_generation, record_local
from .stage_planning import plans as _plans


@dataclass(frozen=True)
class StagedGEPA:
    scope_config: ScopeConfig = field(default_factory=ScopeConfig)
    parent_policy: ParentPolicy | None = None
    batch_size: int = 2
    bridge_max_candidates: int = 2
    epoch_policy: EpochPolicy = field(default_factory=EpochPolicy)

    def __post_init__(self) -> None:
        if type(self.batch_size) is not int or not 1 <= self.batch_size <= 16:
            raise ValueError("Batch size must be between one and sixteen")
        if type(self.bridge_max_candidates) is not int or self.bridge_max_candidates < 0:
            raise ValueError("Bridge quota must be a nonnegative integer")

    def _nominate(self, view: SearchView, state: Mapping[str, Any], reason: str) -> Decision:
        return nominate(view, state, self.scope_config.guard_task_ids, reason)

    def step(self, view: SearchView, state: Mapping[str, Any]) -> Decision:
        if state and state.get("recipe") != "staged-gepa-v2":
            raise ValueError("State belongs to another recipe; use its frozen runtime")
        current = {
            "recipe": "staged-gepa-v2",
            "stage": "parents",
            "index": 0,
            "round": 0,
            **deepcopy(dict(state)),
        }
        stage, index, round_index = current["stage"], current["index"], current["round"]
        if type(index) is not int or index < 0 or type(round_index) is not int or round_index < 0:
            raise ValueError("Invalid staged GEPA counters")
        if stage == "done":
            return Decision(current, (Operation("stop"),), "Search finished")
        config = replace(self.scope_config, seed=view.random_seed)
        tasks = tuple(SamplingTask(t, view.task_families.get(t, "seed")) for t in view.seed_tasks)
        if stage in ("parents", "epochs", "epoch-results", "generate"):
            return plan_generation(
                view, current, config, self.epoch_policy, self.parent_policy, self.batch_size
            )
        if stage == "bridge":
            record_local(view, current, config)
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
                before = _score(view, plan.parent, plan.task_ids, plan.weights)
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
