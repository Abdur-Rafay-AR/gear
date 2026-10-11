"""Bridge planning over a caller-frozen family order; never allocates budget."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .scope_ordering import stratified
from .scope_types import SamplingTask, ScopeConfig, ordered_ids, task_index
from .scopes import resolve_sizing


@dataclass(frozen=True)
class BridgeNominee:
    candidate_id: str
    scope_id: str
    task_ids: tuple[str, ...]


@dataclass(frozen=True)
class BridgeExclusion:
    candidate_id: str
    scope_id: str
    reason: str


@dataclass(frozen=True)
class BridgePlan:
    task_ids: tuple[str, ...]
    participant_ids: tuple[str, ...]


@dataclass(frozen=True)
class BridgeSelection:
    plan: BridgePlan | None
    skipped: tuple[str, ...]
    exclusions: tuple[BridgeExclusion, ...]


def select_bridge(
    tasks: tuple[SamplingTask, ...],
    config: ScopeConfig,
    round_index: int,
    ordered_nominees: tuple[BridgeNominee, ...],
    champion: str,
    guards: tuple[str, ...],
    max_candidates: int,
    affordable: Callable[[tuple[str, ...], tuple[str, ...]], bool],
) -> BridgeSelection:
    """Rotate families, enforce union capacity, then shrink the group to fit.

    ordered_nominees must already be in the chosen stable family order. This
    makes legacy locale order an explicit input instead of a host dependency.
    The budget callback is a pure quote; the runtime still reserves all trials.
    """
    indexed = task_index(tasks)
    for value in (round_index, max_candidates):
        if type(value) is not int or not 0 <= value <= 2**53 - 1:
            raise ValueError("Bridge index and quota must be nonnegative safe integers")
    ids = [nominee.candidate_id for nominee in ordered_nominees]
    if not champion or len(set(ids)) != len(ids) or champion in ids or any(not i for i in ids):
        raise ValueError("Bridge nominees must be unique and distinct from champion")
    if not set(guards) <= set(indexed) or any(
        not n.scope_id
        or not n.task_ids
        or len(set(n.task_ids)) != len(n.task_ids)
        or not set(n.task_ids) <= set(indexed)
        for n in ordered_nominees
    ):
        raise ValueError("Bridge scopes and guards must be nonempty admitted seed subsets")
    capacity = resolve_sizing(len(tasks), config)["bridge"].resolved
    offset = round_index % len(ids) if ids else 0
    ordered = ordered_nominees[offset:] + ordered_nominees[:offset]
    selected = list(ordered[:max_candidates])
    exclusions = [
        BridgeExclusion(
            n.candidate_id, n.scope_id, "bridge-disabled" if max_candidates == 0 else "group-quota"
        )
        for n in ordered[max_candidates:]
    ]
    plan = None
    while selected and capacity > 0:
        required = ordered_ids([t for n in selected for t in n.task_ids] + list(guards))
        if len(required) <= capacity:
            chosen = (
                required
                + stratified(
                    indexed,
                    [t for t in indexed if t not in required],
                    f"{config.seed}:bridge:{round_index}",
                )
            )[:capacity]
            participants = tuple(n.candidate_id for n in selected) + (champion,)
            if affordable(participants, tuple(chosen)):
                plan = BridgePlan(
                    tuple(ordered_ids(chosen)), tuple(ordered_ids(list(participants)))
                )
                break
        excluded = selected.pop()
        exclusions.append(
            BridgeExclusion(
                excluded.candidate_id,
                excluded.scope_id,
                "bridge-capacity" if len(required) > capacity else "bridge-budget",
            )
        )
    if plan is None:
        exclusions.extend(
            BridgeExclusion(n.candidate_id, n.scope_id, "bridge-disabled") for n in selected
        )
    return BridgeSelection(
        plan, tuple(ordered_ids([e.candidate_id for e in exclusions])), tuple(exclusions)
    )
