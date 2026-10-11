"""Public parent allocations and indexed randomness, detached from raw evidence."""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from .parent_random import RandomSource
from .research import ArchiveChampion, ResearchArchive
from .scope_types import ordered_ids


@dataclass(frozen=True)
class ParentOption:
    candidate_id: str
    identity: str
    probability: float


@dataclass(frozen=True)
class ParentScope:
    id: str
    family: str
    epoch: int
    probability: float
    parents: tuple[ParentOption, ...]


@dataclass(frozen=True)
class ParentInput:
    scopes: tuple[ParentScope, ...]
    max_candidates: int
    random_seed: str
    champion: ArchiveChampion | None = None


@dataclass(frozen=True)
class ParentAllocation:
    scope_id: str
    parent_identity: str
    slots: int
    draw_index: int
    branch: str | None = None


@dataclass(frozen=True)
class ParentPlan:
    allocations: tuple[ParentAllocation, ...]
    parent_probabilities: Mapping[str, float]
    reason_codes: tuple[str, ...]

    @classmethod
    def abstain(cls, *, reason: str) -> ParentPlan:
        if not reason:
            raise ValueError("Parent policy must explain abstention")
        return cls((), {}, (reason,))


ParentSelectionPolicy = Callable[[ParentInput, RandomSource], ParentPlan]


@dataclass(frozen=True)
class ParentBatch:
    batch_id: str
    parent: str
    scope_id: str
    slots: int
    draw_index: int
    branch: str | None = None


def parent_batches(view: ParentInput, plan: ParentPlan, round_id: str) -> tuple[ParentBatch, ...]:
    """Validate every allocation before freezing the entire ordered batch list."""
    validate_parent_plan(view, plan)
    return tuple(
        ParentBatch(
            f"{round_id}-batch-{i}",
            next(
                p.candidate_id
                for s in view.scopes
                if s.id == a.scope_id
                for p in s.parents
                if p.identity == a.parent_identity
            ),
            a.scope_id,
            a.slots,
            a.draw_index,
            a.branch,
        )
        for i, a in enumerate(plan.allocations)
    )


def parent_input(
    archive: ResearchArchive,
    max_candidates: int,
    random_seed: str,
    *,
    include_champion: bool = False,
) -> ParentInput:
    if type(max_candidates) is not int or not 1 <= max_candidates <= 2**53 - 1:
        raise ValueError("Invalid candidate limit")
    scopes = []
    for scope in archive.scopes:
        view = archive.views[scope.id]
        ids = set(view.eligible_ids)
        if (
            include_champion
            and archive.champion
            and archive.champion.candidate_id in view.representatives
        ):
            ids.add(archive.champion.candidate_id)
        scopes.append(
            ParentScope(
                scope.id,
                scope.family,
                scope.epoch,
                archive.scope_probabilities.get(scope.id, 0),
                tuple(
                    ParentOption(c, archive.identities[c], view.parent_probabilities.get(c, 0))
                    for c in ordered_ids(list(ids))
                ),
            )
        )
    return ParentInput(
        tuple(scopes), max_candidates, random_seed, archive.champion if include_champion else None
    )


def validate_parent_plan(view: ParentInput, plan: ParentPlan) -> None:
    if not isinstance(plan, ParentPlan) or len(plan.allocations) > view.max_candidates:
        raise ValueError("Invalid parent allocations")
    if not plan.reason_codes or any(not isinstance(r, str) or not r for r in plan.reason_codes):
        raise ValueError("Parent policy must explain its decision")
    eligible = {p.candidate_id for s in view.scopes for p in s.parents}
    if any(
        c not in eligible or not math.isfinite(p) or p < 0
        for c, p in plan.parent_probabilities.items()
    ):
        raise ValueError("Probability refers to an ineligible parent")
    total = sum(plan.parent_probabilities.values())
    if not (abs(total - 1) < 1e-9 if plan.allocations else total == 0):
        raise ValueError("Parent probabilities must sum to one, or zero when abstaining")
    allocated = 0
    for allocation in plan.allocations:
        scope = next((s for s in view.scopes if s.id == allocation.scope_id), None)
        parent = (
            next((p for p in scope.parents if p.identity == allocation.parent_identity), None)
            if scope
            else None
        )
        if parent is None or plan.parent_probabilities.get(parent.candidate_id, 0) <= 0:
            raise ValueError("Policy selected an ineligible parent/scope")
        if type(allocation.slots) is not int or not 1 <= allocation.slots <= 2**53 - 1:
            raise ValueError("Parent slots must be positive safe integers")
        if type(allocation.draw_index) is not int or not 0 <= allocation.draw_index <= 2**53 - 1:
            raise ValueError("Invalid parent draw index")
        if allocation.branch not in (None, "champion", "gepa"):
            raise ValueError("Invalid parent branch")
        allocated += allocation.slots
    if allocated > view.max_candidates:
        raise ValueError("Parent policy exceeded candidate budget")
