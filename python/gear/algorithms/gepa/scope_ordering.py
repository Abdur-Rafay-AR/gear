"""Deterministic legacy selection order; no RNG or runtime state is accessed."""

from __future__ import annotations

import hashlib
import json

from .scope_types import SamplingTask, ordered_ids


def shuffled(seed: str, ids: list[str]) -> list[str]:
    def key(task_id: str) -> str:
        # Only the legacy [string, string] hash used for ordering is reproduced.
        # This is deliberately not the new canonical digest or a run identity.
        payload = json.dumps([seed, task_id], ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    return sorted(ordered_ids(ids), key=key)


def alternate(groups: dict[str, list[str]], keys: list[str]) -> list[str]:
    result: list[str] = []
    expensive = False
    while any(groups.values()):
        for key in keys:
            if groups[key]:
                result.append(groups[key].pop(-1 if expensive else 0))
        expensive = not expensive
    return result


def stratified(tasks: dict[str, SamplingTask], ids: list[str], seed: str) -> list[str]:
    groups: dict[str, list[str]] = {}
    for task_id in ordered_ids(ids):
        groups.setdefault(tasks[task_id].stratum, []).append(task_id)
    for key, values in groups.items():
        groups[key] = sorted(shuffled(seed, values), key=lambda t: tasks[t].estimated_cost)
    return alternate(groups, shuffled(seed, list(groups)))


def representative_order(tasks: dict[str, SamplingTask], ids: list[str], seed: str) -> list[str]:
    groups: dict[str, list[str]] = {}
    for task_id in shuffled(seed, ids):
        task = tasks[task_id]
        difficulty = task.historical_difficulty
        level = (
            "unknown"
            if difficulty is None
            else "easy"
            if difficulty <= 0.25
            else "mixed"
            if difficulty <= 0.75
            else "hard"
        )
        groups.setdefault(f"{task.stratum}:{level}", []).append(task_id)
    for values in groups.values():
        values.sort(key=lambda t: tasks[t].estimated_cost)
    pending = alternate(groups, shuffled(seed, list(groups)))
    selected: list[str] = []
    covered: set[str] = set()

    def labels(task_id: str) -> list[str]:
        task = tasks[task_id]
        return [f"submode:{s}" for s in task.submodes] + [
            f"module:{p}" for p in task.modification_paths
        ]

    while pending:
        best = max(pending, key=lambda t: sum(label not in covered for label in labels(t)))
        selected.append(best)
        covered.update(labels(best))
        pending.remove(best)
    return selected


def cross_order(
    tasks: dict[str, SamplingTask],
    excluded: set[str],
    family_id: str,
    paths: tuple[str, ...],
    seed: str,
) -> tuple[list[str], list[str]]:
    groups: dict[str, list[str]] = {}
    known: set[str] = set()
    for task in tasks.values():
        if task.id in excluded:
            continue
        for family in task.family_ids or (task.stratum,):
            if family != family_id:
                groups.setdefault(family, []).append(task.id)
                known.add(task.id)

    def overlaps(task_id: str) -> bool:
        return any(
            path == root or path.startswith(root + "/") or root.startswith(path + "/")
            for path in tasks[task_id].modification_paths
            for root in paths
        )

    for family, ids in groups.items():
        groups[family] = sorted(
            representative_order(tasks, ids, f"{seed}:{family}"), key=lambda t: not overlaps(t)
        )
    keys = shuffled(seed, list(groups))
    result: list[str] = []
    seen: set[str] = set()
    while any(groups.values()):
        for key in keys:
            bucket = groups[key]
            while bucket and bucket[0] in seen:
                bucket.pop(0)
            if bucket:
                task_id = bucket.pop(0)
                result.append(task_id)
                seen.add(task_id)
    general = representative_order(
        tasks, [t for t in tasks if t not in excluded and t not in known], f"{seed}:general"
    )
    return result + general, general
