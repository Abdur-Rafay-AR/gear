"""Plan local work for every frozen parent batch within one shared budget."""

from __future__ import annotations

from dataclasses import asdict, replace
from typing import Any

from ..._protocol.canonical import digest
from ..contracts import Decision, Operation, SearchView
from .history import project_sampling_evidence
from .scope_types import FailureFamily, ScopeConfig, ordered_ids
from .scopes import create_scope
from .stage_catalog import (
    LocalPlan,
    add_scope,
    archive,
    diagnoses,
    make_scope,
    planning_view,
    plans,
    read_family,
    read_scope,
)
from .stage_evidence import eligible, missing, nominate, profiles
from .stage_parents import batches
from .stopping import diagnosis_capacity


def merge_family(old: dict[str, Any] | None, current: FailureFamily) -> FailureFamily:
    if old is None:
        return current
    before = read_family(old)
    return FailureFamily(
        current.id,
        tuple(ordered_ids((*before.task_ids, *current.task_ids))),
        tuple(
            ordered_ids((*before.successful_control_task_ids, *current.successful_control_task_ids))
        ),
        tuple(ordered_ids((*before.modification_paths, *current.modification_paths))),
    )


def parent_tasks(proposed: list[LocalPlan]) -> dict[str, tuple[str, ...]]:
    parents: dict[str, list[str]] = {}
    for plan in proposed:
        parents.setdefault(plan.parent, []).extend(plan.task_ids)
    return {p: tuple(ordered_ids(ids)) for p, ids in parents.items()}


def plan_locals(view: SearchView, state: dict[str, Any], config: ScopeConfig) -> Decision:
    frozen = archive(view, state, config)
    scopes = {s.family: s for s in sorted(frozen.scopes, key=lambda s: s.epoch)}
    proposed: list[LocalPlan] = []
    used: set[tuple[str, str]] = set()
    for batch in batches(state):
        source = next(s for s in frozen.scopes if s.id == batch.scope_id)
        newer = [
            s
            for s in frozen.scopes
            if s.family == source.family
            and s.epoch > source.epoch
            and batch.parent in frozen.views[s.id].representatives
        ]
        if newer:
            source = max(newer, key=lambda s: s.epoch)
        if not eligible(view, batch.parent, source.task_ids, config.guard_task_ids):
            state["planning_exclusions"].append(
                {"batch_id": batch.batch_id, "reason": "parent-ineligible"}
            )
            continue
        baseline = planning_view(view, state, batch.parent, source.task_ids)
        observed = profiles(baseline)[batch.parent]
        grouped: dict[str, list[str]] = {}
        for task in view.seed_tasks:
            if task in source.task_ids and observed[task] < 1:
                grouped.setdefault(view.task_families.get(task, "seed"), []).append(task)
        family_ids = ordered_ids(list(grouped))
        if not family_ids:
            state["planning_exclusions"].append(
                {"batch_id": batch.batch_id, "reason": "no-observed-failures"}
            )
            continue
        offset = state["round"] % len(family_ids)
        family_ids = family_ids[offset:] + family_ids[:offset]
        current = {
            f: FailureFamily(
                f,
                tuple(grouped[f]),
                tuple(
                    t
                    for t in view.seed_tasks
                    if view.task_families.get(t, "seed") == f and observed.get(t) == 1
                ),
            )
            for f in family_ids
        }
        # Each batch sees committed history plus its own diagnosis, never an
        # earlier batch's new labels or unrelated preparation observations.
        history = {
            **state["planning_family_history"],
            **{
                f: asdict(merge_family(state["planning_family_history"].get(f), d))
                for f, d in current.items()
            },
        }
        sampling = project_sampling_evidence(baseline, diagnoses({"family_history": history}))
        state["batch_sampling"].append(
            {
                "batch_id": batch.batch_id,
                "cutoff_identity": sampling.cutoff_identity,
                "metadata_digest": digest(asdict(sampling)),
            }
        )
        for f, diagnosis in current.items():
            state["family_history"][f] = asdict(
                merge_family(state["family_history"].get(f), diagnosis)
            )
        allocated = 0
        for family_id in family_ids:
            if allocated >= batch.slots:
                break
            key = (batch.parent, family_id)
            if key in used:
                state["planning_exclusions"].append(
                    {
                        "batch_id": batch.batch_id,
                        "family": family_id,
                        "reason": "duplicate-parent-family",
                    }
                )
                continue
            scope = scopes.get(family_id)
            if scope is None:
                sample = create_scope(
                    sampling.tasks,
                    config,
                    read_family(history[family_id]),
                    tuple(state["epoch_successes"]),
                    epoch=state["epoch"],
                )
                if sample is None:
                    continue
                scope = make_scope(sample, config)
                scopes[family_id] = scope
            add_scope(state, scope)
            proposed.append(
                LocalPlan(
                    "",
                    family_id,
                    scope.id,
                    batch.parent,
                    scope.task_ids,
                    scope.weights,
                    tuple(grouped[family_id]),
                    batch.batch_id,
                )
            )
            allocated += 1
            used.add(key)
    # A shared parent baseline slot is paid once, including overlapping scopes.
    while proposed and (
        len(proposed) > diagnosis_capacity(view)
        or sum(missing(view, (p,), ts) for p, ts in parent_tasks(proposed).items())
        + sum(len(p.task_ids) for p in proposed)
        + len(view.seed_tasks)
        > view.remaining_evaluations
    ):
        reason = (
            "diagnosis-budget" if len(proposed) > diagnosis_capacity(view) else "local-group-budget"
        )
        removed = proposed.pop()
        state["planning_exclusions"].append(
            {"batch_id": removed.batch_id, "family": removed.family, "reason": reason}
        )
    if not proposed:
        return nominate(
            view, state, config.guard_task_ids, "No admitted parent batch has affordable local work"
        )
    state["plans"] = [asdict(p) for p in proposed]
    state["stage"] = "generate"
    needed = parent_tasks(proposed)
    operations = tuple(
        Operation("evaluate_seed", candidate=p, tasks=ts)
        for p, ts in needed.items()
        if missing(view, (p,), ts)
    )
    if operations:
        return Decision(
            state, operations, "Complete all frozen local parent baselines before generation"
        )
    return generate(view, state, config)


def generate(view: SearchView, state: dict[str, Any], config: ScopeConfig) -> Decision:
    confirmed: list[LocalPlan] = []
    for plan in plans(state):
        if eligible(view, plan.parent, plan.task_ids, config.guard_task_ids):
            scope = read_scope(
                next(c["scope"] for c in state["catalog"] if c["scope"]["id"] == plan.scope_id)
            )
            add_scope(state, scope, (plan.parent,))
            if any(
                profiles(view)[plan.parent].get(t, 1) < 1
                for t in plan.failures
                if t in plan.task_ids
            ):
                confirmed.append(
                    replace(plan, candidate=f"candidate-{state['index'] + len(confirmed) + 1}")
                )
    if not confirmed:
        return nominate(
            view, state, config.guard_task_ids, "No confirmed eligible local hypothesis"
        )
    state.pop("sampling_coverage", None)
    state.pop("planning_family_history", None)
    state["index"] += len(confirmed)
    state["plans"] = [asdict(p) for p in confirmed]
    if view.diagnosis_budget is not None:
        state["stage"] = "propose"
        state["diagnosis_before"] = list(view.completed)
        return Decision(
            state,
            tuple(
                Operation("diagnose_seed", candidate=p.parent, tasks=p.task_ids) for p in confirmed
            ),
            "Commit certified parent diagnoses before assigning hypothesis workplans",
        )
    state["stage"] = "local"
    return Decision(
        state,
        tuple(
            op
            for p in confirmed
            for op in (
                Operation("diagnose_seed", candidate=p.parent, tasks=p.task_ids),
                Operation("generate", candidate=p.candidate, parent=p.parent),
            )
        ),
        "Generate candidates within every admitted parent batch allocation",
    )
