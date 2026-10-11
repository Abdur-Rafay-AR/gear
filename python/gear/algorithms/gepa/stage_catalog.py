"""Durable GEPA catalog and seed-only planning projections."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass, replace
from typing import Any

from ..._protocol.canonical import digest
from ..contracts import SearchView
from .archive import project_seed_archive
from .history import SamplingDiagnosis, project_sampling_evidence
from .research import ArchiveScope, ResearchArchive, must_pass_guard_identity
from .scope_types import FailureFamily, SamplingScope, SamplingTask, ScopeConfig
from .stage_evidence import eligible


@dataclass(frozen=True)
class LocalPlan:
    candidate: str
    family: str
    scope_id: str
    parent: str
    task_ids: tuple[str, ...]
    weights: Mapping[str, float]
    failures: tuple[str, ...]
    batch_id: str


def plans(state: Mapping[str, Any]) -> tuple[LocalPlan, ...]:
    return tuple(
        LocalPlan(**{**p, "task_ids": tuple(p["task_ids"]), "failures": tuple(p["failures"])})
        for p in state.get("plans", [])
    )


def read_scope(value: Mapping[str, Any]) -> ArchiveScope:
    return ArchiveScope(**{**value, "task_ids": tuple(value["task_ids"])})


def archive(view: SearchView, state: Mapping[str, Any], config: ScopeConfig) -> ResearchArchive:
    catalog = state["catalog"]
    return project_seed_archive(
        view,
        tuple(read_scope(c["scope"]) for c in catalog),
        {c["scope"]["id"]: tuple(c["registrations"]) for c in catalog},
        must_pass_guards={c["scope"]["id"]: config.guard_task_ids for c in catalog},
    )


def add_scope(state: dict[str, Any], scope: ArchiveScope, members: tuple[str, ...] = ()) -> None:
    entry = next((c for c in state["catalog"] if c["scope"]["id"] == scope.id), None)
    if entry is None:
        entry = {"scope": asdict(scope), "registrations": []}
        state["catalog"].append(entry)
    entry["registrations"] = list(dict.fromkeys((*entry["registrations"], *members)))


def make_scope(sample: SamplingScope, config: ScopeConfig) -> ArchiveScope:
    guard = must_pass_guard_identity(config.guard_task_ids)
    return ArchiveScope(
        digest([asdict(sample), guard]),
        sample.family_id,
        sample.epoch,
        sample.task_ids,
        sample.weights,
        guard,
    )


def read_family(value: Mapping[str, Any]) -> FailureFamily:
    return FailureFamily(
        value["id"],
        tuple(value["task_ids"]),
        tuple(value["successful_control_task_ids"]),
        tuple(value["modification_paths"]),
    )


def diagnoses(state: Mapping[str, Any]) -> tuple[SamplingDiagnosis, ...]:
    return tuple(
        SamplingDiagnosis(
            f["id"],
            tuple(f["task_ids"]),
            tuple(f["successful_control_task_ids"]),
            tuple(f["modification_paths"]),
        )
        for f in state.get("family_history", {}).values()
    )


def sampling_tasks(state: Mapping[str, Any], view: SearchView) -> tuple[SamplingTask, ...]:
    value = state.get("sampling_evidence")
    if value is None:
        return project_sampling_evidence(view).tasks
    return tuple(
        SamplingTask(
            **{
                **t,
                "family_ids": tuple(t["family_ids"]),
                "submodes": tuple(t["submodes"]),
                "modification_paths": tuple(t["modification_paths"]),
            }
        )
        for t in value["tasks"]
    )


def planning_view(
    view: SearchView, state: Mapping[str, Any], parent: str, probe: tuple[str, ...]
) -> SearchView:
    # Freeze committed coverage, then admit only this selected parent's probe.
    # Values remain runtime-owned; no second observation journal is created.
    candidates = []
    for candidate in view.candidates:
        allowed = set(state["sampling_coverage"].get(candidate.id, ())) | (
            set(probe) if candidate.id == parent else set()
        )
        candidates.append(
            replace(
                candidate,
                scores={t: v for t, v in candidate.scores.items() if t in allowed},
                score_evidence={t: r for t, r in candidate.score_evidence.items() if t in allowed},
            )
        )
    return replace(view, candidates=tuple(candidates))


def record_local(view: SearchView, state: dict[str, Any], config: ScopeConfig) -> None:
    for plan in plans(state):
        scope = read_scope(
            next(c["scope"] for c in state["catalog"] if c["scope"]["id"] == plan.scope_id)
        )
        add_scope(
            state,
            scope,
            tuple(
                c
                for c in (plan.parent, plan.candidate)
                if eligible(view, c, scope.task_ids, config.guard_task_ids)
            ),
        )
