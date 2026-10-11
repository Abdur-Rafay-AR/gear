"""Frontier policy over complete, already verified seed profiles.

No observations, identities or archive journals are created here. Callers must
resolve evidence revisions and scope equivalence before projecting profiles.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from fractions import Fraction

from .parent_random import RandomSource
from .scope_types import ordered_ids


@dataclass(frozen=True)
class FrontierCandidate:
    id: str
    identity: str
    score_keys: Mapping[str, int]
    aggregate_key: int | None
    observed_at: int = 0
    guard_passed: bool = True
    process_keys: Mapping[str, int] = field(default_factory=dict)
    process_complete: bool = True


@dataclass(frozen=True)
class TaskFront:
    task_id: str
    channel: str
    candidate_ids: tuple[str, ...]
    informative: bool


@dataclass(frozen=True)
class ScopeFrontier:
    eligible_ids: tuple[str, ...]
    process_eligible_ids: tuple[str, ...]
    fronts: tuple[TaskFront, ...]
    representatives: Mapping[str, str]
    pruned_ids: tuple[str, ...]
    parent_probabilities: Mapping[str, float]
    pending_ids: tuple[str, ...]
    ineligible_ids: tuple[str, ...]


def scope_frontier(
    task_ids: tuple[str, ...],
    weights: Mapping[str, float],
    candidates: tuple[FrontierCandidate, ...],
    champion: str,
    *,
    process_fraction: float = 0.25,
    objective: bool = False,
    tie_order: tuple[str, ...] | None = None,
) -> ScopeFrontier:
    """Preserve informative per-task fronts while removing joint redundancy.

    Keys are quantized, direction-adjusted integers from verified profiles.
    tie_order can freeze a legacy locale collation; the portable default is
    UTF-16 ID order. No host locale is consulted by Python.
    """
    if not task_ids or len(set(task_ids)) != len(task_ids) or set(weights) != set(task_ids):
        raise ValueError("Frontier requires a unique complete scope and matching weights")
    if any(not math.isfinite(w) or w < 0 for w in weights.values()) or not math.isclose(
        sum(weights.values()), 1, rel_tol=0, abs_tol=1e-12
    ):
        raise ValueError("Frontier weights must be normalized")
    if not math.isfinite(process_fraction) or not 0 <= process_fraction <= 1:
        raise ValueError("Invalid process fraction")
    by_id = {candidate.id: candidate for candidate in candidates}
    if len(by_id) != len(candidates) or any(not c.id or not c.identity for c in candidates):
        raise ValueError("Frontier candidate IDs and identities must be nonempty and unique by ID")
    order = tuple(ordered_ids(list(by_id))) if tie_order is None else tie_order
    if len(order) != len(by_id) or set(order) != set(by_id):
        raise ValueError("Tie order must contain each candidate exactly once")
    ranks = {candidate_id: i for i, candidate_id in enumerate(order)}
    admitted: dict[str, FrontierCandidate] = {}
    pending, rejected = [], []
    for candidate in candidates:
        if any(
            type(k) is not int
            for k in (*candidate.score_keys.values(), *candidate.process_keys.values())
        ):
            raise ValueError("Frontier comparison keys must be integers")
        if candidate.aggregate_key is not None and type(candidate.aggregate_key) is not int:
            raise ValueError("Aggregate comparison key must be an integer")
        if not set(candidate.score_keys) <= set(task_ids) or not set(candidate.process_keys) <= set(
            task_ids
        ):
            raise ValueError("Profile contains evidence outside its scope")
        complete = candidate.aggregate_key is not None and set(candidate.score_keys) == set(
            task_ids
        )
        if not complete:
            pending.append(candidate.id)
        elif not candidate.guard_passed:
            rejected.append(candidate.id)
        else:
            admitted[candidate.id] = candidate
            if not objective and not candidate.process_complete:
                pending.append(candidate.id)
    representatives: dict[str, str] = {}
    identities: dict[str, str] = {}
    for candidate in sorted(admitted.values(), key=lambda c: (c.observed_at, ranks[c.id])):
        representatives[candidate.id] = identities.setdefault(candidate.identity, candidate.id)
    eligible = ordered_ids([c for c in admitted if representatives[c] == c])
    process_eligible = [] if objective else [c for c in eligible if admitted[c].process_complete]
    fronts: list[TaskFront] = []
    for channel in ("objective",) if objective else ("outcome", "process"):
        for task_id in task_ids:
            values = {}
            for candidate_id in process_eligible if channel == "process" else eligible:
                keys = (
                    admitted[candidate_id].process_keys
                    if channel == "process"
                    else admitted[candidate_id].score_keys
                )
                if task_id in keys:
                    values[candidate_id] = keys[task_id]
            if values:
                maximum = max(values.values())
                fronts.append(
                    TaskFront(
                        task_id,
                        channel,
                        tuple(c for c, key in values.items() if key == maximum),
                        any(key != maximum for key in values.values()),
                    )
                )
    informative = [front for front in fronts if front.informative and weights[front.task_id] > 0]
    live, pruned = set(eligible), []
    if informative:
        for candidate_id in sorted(eligible, key=lambda c: (admitted[c].aggregate_key, ranks[c])):
            memberships = [front for front in informative if candidate_id in front.candidate_ids]
            if all(
                any(other != candidate_id and other in live for other in front.candidate_ids)
                for front in memberships
            ):
                live.remove(candidate_id)
                pruned.append(candidate_id)
    probabilities: dict[str, float] = {}
    if not informative and eligible:
        fallback = (
            champion
            if champion in eligible
            else min(eligible, key=lambda c: (-int(admitted[c].aggregate_key or 0), ranks[c]))
        )
        probabilities[fallback] = 1
    else:
        channels: dict[str, dict[str, float]] = {}
        for channel in ("objective",) if objective else ("outcome", "process"):
            mass: dict[str, float] = {}
            for front in informative:
                if front.channel == channel:
                    for candidate_id in front.candidate_ids:
                        if candidate_id in live:
                            mass[candidate_id] = mass.get(candidate_id, 0) + weights[front.task_id]
            total = sum(mass.values())
            channels[channel] = {c: weight / total for c, weight in mass.items()}
        if objective:
            probabilities = channels["objective"]
        else:
            rho = (
                0 if not channels["process"] else 1 if not channels["outcome"] else process_fraction
            )
            for candidate_id in eligible:
                if candidate_id in live:
                    value = (1 - rho) * channels["outcome"].get(candidate_id, 0) + rho * channels[
                        "process"
                    ].get(candidate_id, 0)
                    if value > 0:
                        probabilities[candidate_id] = value
    return ScopeFrontier(
        tuple(eligible),
        tuple(process_eligible),
        tuple(fronts),
        representatives,
        tuple(pruned),
        probabilities,
        tuple(ordered_ids(pending)),
        tuple(ordered_ids(rejected)),
    )


def comparison_key(value: float | Fraction, quantum: float = 0.000001) -> int:
    if not math.isfinite(quantum) or quantum <= 0:
        raise ValueError("Comparison quantum must be finite and positive")
    return math.floor(
        (value if isinstance(value, Fraction) else Fraction(str(value))) / Fraction(str(quantum))
        + Fraction(1, 2)
    )


def weighted_choice(probabilities: Mapping[str, float], seed: str, index: int = 0) -> str:
    return RandomSource(seed).choice(probabilities, index=index).value
