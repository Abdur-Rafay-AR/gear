"""Pure historical GEPA shared/local/cross scope construction.

Callers supply admitted seed metadata. This module cannot verify observation
provenance and never creates a legacy digest or writes historical state.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from fractions import Fraction

from ..contracts import SearchView
from .scope_ordering import cross_order, representative_order, stratified
from .scope_types import (
    BucketSampling,
    FailureFamily,
    Quantity,
    SamplingScope,
    SamplingTask,
    ScopeConfig,
    TaskSetLimit,
    ordered_ids,
    task_index,
)

__all__ = [
    "FailureFamily",
    "SamplingScope",
    "SamplingTask",
    "ScopeConfig",
    "ScopeSampler",
    "TaskSetLimit",
    "create_scope",
    "resolve_sizing",
]


def resolve_sizing(size: int, config: ScopeConfig) -> dict[str, Quantity]:
    if type(size) is not int or size <= 0 or size > 2**53 - 1:
        raise ValueError("Seed universe size must be a positive safe integer")
    quantities: dict[str, Quantity] = {}
    ratios = Fraction(0)
    for name in ("local", "shared", "cross", "bridge"):
        limit: TaskSetLimit = getattr(config, name)
        if not math.isfinite(limit.ratio) or not 0 <= limit.ratio <= 1:
            raise ValueError(f"Invalid {name} ratio")
        for bound in (limit.min_tasks, limit.max_tasks):
            if bound is not None and (type(bound) is not int or not 0 <= bound <= 2**53 - 1):
                raise ValueError(f"Invalid {name} capacity")
        if (
            limit.min_tasks is not None
            and limit.max_tasks is not None
            and limit.min_tasks > limit.max_tasks
        ):
            raise ValueError(f"{name} minimum exceeds maximum")
        if limit.ratio == 0 and limit.min_tasks:
            raise ValueError(f"{name} is disabled but has a positive minimum")
        if limit.ratio > 0 and limit.max_tasks == 0:
            raise ValueError(f"{name} positive ratio conflicts with zero capacity")
        ratio = Fraction(str(limit.ratio))
        if name != "bridge":
            ratios += ratio
        requested = math.ceil(size * ratio)
        resolved = min(
            size,
            size if limit.max_tasks is None else limit.max_tasks,
            max(min(size, limit.min_tasks or 0), requested),
        )
        reasons = []
        if (limit.min_tasks or 0) > size:
            reasons.append("minimum-clipped-to-universe")
        if resolved < requested:
            reasons.append("capacity-clipped")
        quantities[name] = Quantity(requested, resolved, tuple(reasons))
    if config.local.ratio <= 0 or ratios > 1:
        raise ValueError("Local ratio must be positive and local/shared/cross sum at most one")
    return quantities


def create_scope(
    tasks: tuple[SamplingTask, ...],
    config: ScopeConfig,
    family: FailureFamily,
    successful_ids: tuple[str, ...] = (),
    *,
    epoch: int = 1,
) -> SamplingScope | None:
    """Build shared scope then one local/cross scope; guard-only tasks have zero weight."""
    indexed = task_index(tasks)
    quantities = resolve_sizing(len(tasks), config)
    if type(epoch) is not int or epoch < 1:
        raise ValueError("Epoch must be a positive integer")
    known = set(indexed)
    for ids in (
        family.task_ids,
        family.successful_control_task_ids,
        successful_ids,
        config.shared_core_task_ids,
        config.guard_task_ids,
    ):
        if not set(ids) <= known:
            raise ValueError("Sampling tasks outside seed universe")
    names = ("shared", "local", "cross")
    if set(config.bucket_weights) != set(names) or any(
        not math.isfinite(w) or w < 0 for w in config.bucket_weights.values()
    ):
        raise ValueError("Scope bucket weights must be finite and nonnegative")
    suffix = "" if epoch == 1 else f":epoch-{epoch}"
    core = ordered_ids(config.shared_core_task_ids)
    if len(core) > quantities["shared"].resolved:
        raise ValueError("Shared core exceeds capacity")
    shared = (
        core
        + stratified(
            indexed, [t for t in successful_ids if t not in core], f"{config.seed}:shared{suffix}"
        )
    )[: quantities["shared"].resolved]
    used = set(shared)
    local_seed = f"{config.seed}:{family.id}:local{suffix}"
    controls = representative_order(
        indexed,
        [
            t
            for t in family.successful_control_task_ids
            if t not in used and t not in family.task_ids
        ],
        f"{local_seed}:controls",
    )
    count = quantities["local"].resolved
    control_slots = 1 if count >= 2 and controls else 0
    failures = representative_order(
        indexed, [t for t in family.task_ids if t not in used], local_seed
    )
    local = failures[: count - control_slots] + controls[:control_slots]
    for task_id in failures + controls:
        if len(local) < count and task_id not in local:
            local.append(task_id)
    used.update(local)
    if not used.intersection(family.task_ids):
        return None
    cross, general = cross_order(
        indexed,
        used | set(family.task_ids),
        family.id,
        family.modification_paths,
        f"{config.seed}:{family.id}:cross{suffix}",
    )
    buckets = {
        "shared": tuple(shared),
        "local": tuple(local),
        "cross": tuple(cross[: quantities["cross"].resolved]),
    }
    task_ids = tuple(
        ordered_ids([t for ids in buckets.values() for t in ids] + list(config.guard_task_ids))
    )
    denominator = sum(config.bucket_weights[name] for name in names if buckets[name])
    if not math.isfinite(denominator) or denominator <= 0:
        raise ValueError("Nonempty scope requires finite positive scoring weight")
    weights = dict.fromkeys(task_ids, 0.0)
    sampling = {}
    rounded_excess = sum(quantities[name].resolved for name in names) > len(tasks)
    for name in names:
        for task_id in buckets[name]:
            weights[task_id] = config.bucket_weights[name] / denominator / len(buckets[name])
        reasons = []
        if len(buckets[name]) < quantities[name].resolved:
            reasons.append("eligible-pool-exhausted-after-deduplication")
            if rounded_excess:
                reasons.append("rounded-targets-exceed-universe:shared-local-cross-priority")
        if name == "local" and controls:
            reasons.append(
                "successful-control-included"
                if set(local).intersection(controls)
                else "successful-control-quota-unavailable"
            )
        if name == "cross" and set(buckets[name]).intersection(general):
            reasons.append("general-seed-sampling-fallback")
        sampling[name] = BucketSampling(
            quantities[name].resolved, len(buckets[name]), tuple(reasons)
        )
    return SamplingScope(family.id, epoch, buckets, task_ids, weights, sampling)


@dataclass(frozen=True)
class ScopeSampler:
    """Opt-in recipe adapter using observed pass scores and declared seed families.

    The largest failing family is selected (UTF-16 ID tie break). Costs default
    to one; no historical difficulty or module features are invented. Advanced
    policies can call create_scope with their admitted metadata directly.
    """

    config: ScopeConfig = field(default_factory=ScopeConfig)

    def __call__(self, view: SearchView, parent: str) -> tuple[str, ...]:
        candidate = next((c for c in view.candidates if c.id == parent), None)
        if candidate is None or any(t not in candidate.scores for t in view.seed_tasks):
            raise ValueError("Scope sampling requires complete observed parent seed scores")
        if any(
            not math.isfinite(candidate.scores[t]) or not 0 <= candidate.scores[t] <= 1
            for t in view.seed_tasks
        ):
            raise ValueError("ScopeSampler requires pass scores between zero and one")
        groups: dict[str, list[str]] = {}
        tasks = tuple(SamplingTask(t, view.task_families.get(t, "seed")) for t in view.seed_tasks)
        for task in tasks:
            if candidate.scores[task.id] < 1:
                groups.setdefault(task.stratum, []).append(task.id)
        if not groups:
            return view.seed_tasks
        family_id = min(ordered_ids(list(groups)), key=lambda key: -len(groups[key]))
        successes = tuple(t for t in view.seed_tasks if candidate.scores[t] == 1)
        controls = tuple(t.id for t in tasks if t.stratum == family_id and t.id in successes)
        scope = create_scope(
            tasks,
            replace(self.config, seed=view.random_seed),
            FailureFamily(family_id, tuple(groups[family_id]), controls),
            successes,
        )
        if scope is None:
            raise ValueError("Scope contains no task from the selected failure family")
        return scope.task_ids
