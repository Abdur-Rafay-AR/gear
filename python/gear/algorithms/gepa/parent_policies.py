"""Scoped frontier and champion/GEPA allocations through the public parent API."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .parent_plan import (
    ParentAllocation,
    ParentInput,
    ParentPlan,
    validate_parent_plan,
)
from .parent_random import RandomSource


def exploration_probabilities(view: ParentInput) -> dict[str, float]:
    result: dict[str, float] = {}
    for scope in view.scopes:
        for parent in scope.parents:
            weight = scope.probability * parent.probability
            if weight > 0:
                result[parent.candidate_id] = result.get(parent.candidate_id, 0) + weight
    return result


def _draw(
    view: ParentInput, random: RandomSource, index: int, slots: int, branch: str | None = None
) -> ParentAllocation:
    scope_id = random.choice({s.id: s.probability for s in view.scopes}, index=index).value
    scope = next(s for s in view.scopes if s.id == scope_id)
    candidate_id = random.choice(
        {p.candidate_id: p.probability for p in scope.parents}, index=index + 1
    ).value
    parent = next(p for p in scope.parents if p.candidate_id == candidate_id)
    return ParentAllocation(
        scope.id, parent.identity, slots, index if branch is None else index - 1, branch
    )


@dataclass(frozen=True)
class ScopedFrontierPolicy:
    batch_count: int = 1

    def __post_init__(self) -> None:
        if type(self.batch_count) is not int or not 1 <= self.batch_count <= 2**53 - 1:
            raise ValueError("Scoped frontier requires a positive batch count")

    def __call__(self, view: ParentInput, random: RandomSource) -> ParentPlan:
        if self.batch_count > view.max_candidates:
            raise ValueError("Parent batches exceed candidate limit")
        plan = ParentPlan(
            tuple(
                _draw(
                    view,
                    random,
                    i * 2,
                    view.max_candidates // self.batch_count
                    + (i < view.max_candidates % self.batch_count),
                )
                for i in range(self.batch_count)
            ),
            exploration_probabilities(view),
            ("scoped-frontier-membership",),
        )
        validate_parent_plan(view, plan)
        return plan


@dataclass(frozen=True)
class ChampionGepaPolicy:
    champion_probability: float = 0.5

    def __post_init__(self) -> None:
        if not math.isfinite(self.champion_probability) or not 0 <= self.champion_probability <= 1:
            raise ValueError("Champion probability must be between zero and one")

    def __call__(self, view: ParentInput, random: RandomSource) -> ParentPlan:
        champion = view.champion
        if champion is None:
            raise ValueError("Champion has no complete eligible seed scope")
        exploration = exploration_probabilities(view)
        weights = {c: p * (1 - self.champion_probability) for c, p in exploration.items()}
        weights[champion.candidate_id] = (
            weights.get(champion.candidate_id, 0) + self.champion_probability
        )
        if not exploration:
            weights[champion.candidate_id] = 1
        allocations = []
        for i in range(view.max_candidates):
            branch = random.choice(
                {"champion": self.champion_probability, "gepa": 1 - self.champion_probability},
                index=i * 3,
            ).value
            if branch == "champion" or not exploration:
                allocations.append(
                    ParentAllocation(champion.scope_id, champion.identity, 1, i * 3, "champion")
                )
            else:
                allocations.append(_draw(view, random, i * 3 + 1, 1, "gepa"))
        plan = ParentPlan(
            tuple(allocations),
            {c: p for c, p in weights.items() if p > 0},
            ("champion-gepa-mixture",),
        )
        validate_parent_plan(view, plan)
        return plan
