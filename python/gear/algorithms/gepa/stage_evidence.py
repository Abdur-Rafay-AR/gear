"""Read-only pass-rate projections shared by GEPA planning and ranking."""

from __future__ import annotations

import math
from collections.abc import Mapping
from fractions import Fraction
from typing import Any

from ..contracts import Decision, Operation, SearchView
from .frontier import comparison_key


def profiles(view: SearchView) -> dict[str, Mapping[str, float]]:
    return {candidate.id: candidate.scores for candidate in view.candidates}


def score(
    view: SearchView,
    candidate: str,
    tasks: tuple[str, ...],
    weights: Mapping[str, float] | None = None,
) -> int | None:
    observed = profiles(view).get(candidate, {})
    if not tasks or any(t not in observed for t in tasks):
        return None
    if any(not math.isfinite(observed[t]) or not 0 <= observed[t] <= 1 for t in tasks):
        raise ValueError("Staged GEPA requires pass scores in [0, 1]")
    values = [Fraction(str(observed[t])) for t in tasks]
    value = (
        sum((v * Fraction(str(weights[t])) for t, v in zip(tasks, values)), Fraction())
        if weights is not None
        else sum(values, Fraction()) / len(tasks)
    )
    return comparison_key(value)


def missing(view: SearchView, candidates: tuple[str, ...], tasks: tuple[str, ...]) -> int:
    observed = profiles(view)
    return sum(task not in observed.get(c, {}) for c in candidates for task in tasks)


def eligible(
    view: SearchView, candidate: str, tasks: tuple[str, ...], guards: tuple[str, ...]
) -> bool:
    return score(view, candidate, tasks) is not None and all(
        profiles(view).get(candidate, {}).get(t) == 1 for t in guards
    )


def nominate(
    view: SearchView, state: Mapping[str, Any], guards: tuple[str, ...], reason: str
) -> Decision:
    candidates = [
        (c.id, score(view, c.id, view.seed_tasks))
        for c in view.candidates
        if eligible(view, c.id, view.seed_tasks, guards)
    ]
    nominee = (
        min(candidates, key=lambda item: (-int(item[1] or 0), item[0].encode("utf-16-be")))[0]
        if candidates
        else view.champion
    )
    return Decision({**state, "stage": "done"}, (Operation("nominate", candidate=nominee),), reason)
