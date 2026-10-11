"""Epoch admission policy; execution, reservations and receipts stay in the runtime."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from math import isfinite

from .research import ArchiveScope
from .scope_types import ordered_ids


@dataclass(frozen=True)
class EpochPolicy:
    update_every_rounds: int | None = None
    max_historical_specialists: int = 1

    def __post_init__(self) -> None:
        if self.update_every_rounds is not None and (
            type(self.update_every_rounds) is not int
            or not 1 <= self.update_every_rounds <= 2**53 - 1
        ):
            raise ValueError("Epoch update period must be a positive safe integer")
        if (
            type(self.max_historical_specialists) is not int
            or not 0 <= self.max_historical_specialists <= 30
        ):
            raise ValueError("Historical specialist limit must be between zero and thirty")

    def epoch(self, round_index: int) -> int:
        if type(round_index) is not int or not 0 <= round_index < 2**53 - 1:
            raise ValueError("Invalid scope round index")
        return (
            1 if self.update_every_rounds is None else 1 + round_index // self.update_every_rounds
        )

    def due(self, round_index: int) -> bool:
        self.epoch(round_index)
        return (
            self.update_every_rounds is not None
            and round_index > 0
            and round_index % self.update_every_rounds == 0
        )


@dataclass(frozen=True)
class PreparationCost:
    cells: int
    repair_cells: int = 0

    def __post_init__(self) -> None:
        if any(
            type(v) is not int or not 0 <= v <= 2**53 - 1 for v in (self.cells, self.repair_cells)
        ):
            raise ValueError("Preparation costs must be nonnegative safe integers")


@dataclass(frozen=True)
class EpochAdmission:
    family_id: str
    previous_scope_id: str
    proposed_scope_id: str | None
    participant_ids: tuple[str, ...]
    excluded_historical_ids: tuple[str, ...]
    status: str
    reason_codes: tuple[str, ...]
    cost: PreparationCost


def admit_scope_epoch(
    previous: ArchiveScope,
    proposed: ArchiveScope | None,
    anchor: str,
    selected_parents: tuple[str, ...],
    historical_probabilities: Mapping[str, float],
    policy: EpochPolicy,
    remaining: PreparationCost,
    quote: Callable[[tuple[str, ...], tuple[str, ...]], PreparationCost],
    *,
    historical_order: tuple[str, ...] | None = None,
) -> EpochAdmission:
    """Keep mandatory parents; drop only optional specialists before evaluation.

    selected_parents contains parents drawn from this previous scope. The caller
    freezes the returned admission with its evaluate operations in one decision.
    """
    base = (previous.family, previous.id, proposed.id if proposed else None)
    if proposed is None:
        return EpochAdmission(
            *base, (), (), "no-history", ("no-committed-family-diagnosis",), PreparationCost(0)
        )
    if proposed.family != previous.family or proposed.epoch <= previous.epoch:
        raise ValueError("Proposed epoch must advance the same family")
    if proposed.equivalence == previous.equivalence:
        return EpochAdmission(
            *base, (), (), "unchanged", ("equivalent-task-scope",), PreparationCost(0)
        )
    mandatory = tuple(dict.fromkeys((anchor, *selected_parents)))
    order = (
        tuple(ordered_ids(list(historical_probabilities)))
        if historical_order is None
        else historical_order
    )
    if len(set(order)) != len(order) or set(order) != set(historical_probabilities):
        raise ValueError("Historical order must cover each specialist")
    ranks = {candidate: i for i, candidate in enumerate(order)}
    # Probabilities have already been certified by the archive projection.
    if any(not candidate for candidate in (*mandatory, *order)) or any(
        not isfinite(p) or p < 0 for p in historical_probabilities.values()
    ):
        raise ValueError("Invalid epoch participants or probabilities")
    historical = [
        c
        for c in sorted(order, key=lambda c: (-historical_probabilities[c], ranks[c]))
        if c not in mandatory
    ][: policy.max_historical_specialists]
    excluded: list[str] = []
    while True:
        participants = (*mandatory, *historical)
        cost = quote(participants, proposed.task_ids)
        affordable = cost.cells <= remaining.cells and cost.repair_cells <= remaining.repair_cells
        if affordable or not historical:
            break
        excluded.append(historical.pop())
    return EpochAdmission(
        *base,
        participants,
        tuple(excluded),
        "admitted" if affordable else "budget-insufficient",
        () if affordable else ("scope-preparation-budget",),
        cost,
    )
