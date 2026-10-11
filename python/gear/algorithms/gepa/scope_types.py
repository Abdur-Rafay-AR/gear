"""Seed-only inputs and semantic results for historical GEPA scope sampling.

These values do not carry legacy run identities. Evidence provenance, durable
reservations and promotion remain the execution runtime's responsibility.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field


def ordered_ids(ids: tuple[str, ...] | list[str]) -> list[str]:
    # Legacy JavaScript Array.sort uses UTF-16 code units, including astral IDs.
    return sorted(set(ids), key=lambda value: value.encode("utf-16-be"))


@dataclass(frozen=True)
class SamplingTask:
    id: str
    stratum: str
    estimated_cost: float = 1
    family_ids: tuple[str, ...] = ()
    submodes: tuple[str, ...] = ()
    modification_paths: tuple[str, ...] = ()
    historical_difficulty: float | None = None


@dataclass(frozen=True)
class TaskSetLimit:
    ratio: float
    min_tasks: int | None = None
    max_tasks: int | None = None


@dataclass(frozen=True)
class ScopeConfig:
    seed: str = "0"
    local: TaskSetLimit = TaskSetLimit(0.08)
    shared: TaskSetLimit = TaskSetLimit(0.04)
    cross: TaskSetLimit = TaskSetLimit(0.03)
    bridge: TaskSetLimit = TaskSetLimit(0.4)
    bucket_weights: Mapping[str, float] = field(
        default_factory=lambda: {"shared": 0.25, "local": 0.6, "cross": 0.15}
    )
    shared_core_task_ids: tuple[str, ...] = ()
    guard_task_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class FailureFamily:
    id: str
    task_ids: tuple[str, ...]
    successful_control_task_ids: tuple[str, ...] = ()
    modification_paths: tuple[str, ...] = ()


@dataclass(frozen=True)
class Quantity:
    requested: int
    resolved: int
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class BucketSampling:
    requested: int
    selected: int
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class SamplingScope:
    family_id: str
    epoch: int
    buckets: Mapping[str, tuple[str, ...]]
    task_ids: tuple[str, ...]
    weights: Mapping[str, float]
    sampling: Mapping[str, BucketSampling]


def task_index(tasks: tuple[SamplingTask, ...]) -> dict[str, SamplingTask]:
    if not tasks or len({t.id for t in tasks}) != len(tasks):
        raise ValueError("Seed tasks must be nonempty and unique")
    for task in tasks:
        if not task.id or not task.stratum:
            raise ValueError("Task ID and stratum must be nonempty")
        if not math.isfinite(task.estimated_cost) or task.estimated_cost <= 0:
            raise ValueError("Estimated cost must be positive and finite")
        difficulty = task.historical_difficulty
        if difficulty is not None and (not math.isfinite(difficulty) or not 0 <= difficulty <= 1):
            raise ValueError("Historical difficulty must be between zero and one")
        for value in (
            task.id,
            task.stratum,
            *task.family_ids,
            *task.submodes,
            *task.modification_paths,
        ):
            value.encode("utf-8")
    return {task.id: task for task in tasks}
