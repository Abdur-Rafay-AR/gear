"""Durable parent selection and epoch preparation through the public contract."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from ..contracts import Decision, Operation, ParentPolicy, SearchView
from .epochs import EpochPolicy, PreparationCost, admit_scope_epoch
from .parent_plan import ParentSelectionPolicy
from .scope_types import ScopeConfig
from .scopes import create_scope
from .stage_catalog import add_scope, make_scope, read_family, read_scope, sampling_tasks
from .stage_evidence import eligible, missing, nominate
from .stage_locals import generate, plan_locals
from .stage_parents import batches, freeze_parents


def plan_generation(
    view: SearchView,
    state: dict[str, Any],
    config: ScopeConfig,
    policy: EpochPolicy,
    parent_policy: ParentPolicy | None,
    batch_size: int,
    selection_policy: ParentSelectionPolicy | None,
) -> Decision:
    if state["stage"] == "parents":
        if state["index"] >= view.max_candidates or view.remaining_evaluations < len(
            view.seed_tasks
        ):
            return nominate(
                view, state, config.guard_task_ids, "Nominate from complete common seed evidence"
            )
        freeze_parents(view, state, config, policy, parent_policy, selection_policy, batch_size)
        if not batches(state):
            return nominate(view, state, config.guard_task_ids, "Parent policy abstained")
    tasks = sampling_tasks(state, view)
    if state["stage"] == "epoch-results":
        pending = state.pop("pending_epoch")
        scope = read_scope(pending["scope"])
        admission = pending["admission"]
        failed = [
            c
            for c in admission["participant_ids"]
            if not eligible(view, c, scope.task_ids, config.guard_task_ids)
        ]
        if not failed:
            add_scope(state, scope, tuple(admission["participant_ids"]))
        admission["status"] = "baseline-ineligible" if failed else "prepared"
        admission["reason_codes"] = [f"incomplete-or-ineligible:{c}" for c in failed]
        state["last_epoch_preparation"].append(admission)
        state["stage"] = "epochs"
    while state["stage"] == "epochs" and state["epoch_queue"]:
        previous = state["epoch_queue"].pop(0)
        old = read_scope(previous["scope"])
        history = state["family_history"].get(old.family)
        sample = (
            create_scope(
                tasks,
                config,
                read_family(history),
                tuple(state["epoch_successes"]),
                epoch=state["epoch"],
            )
            if history
            else None
        )
        proposed = make_scope(sample, config) if sample else None
        if history and proposed is None:
            raise ValueError("Historical family has no representative in proposed epoch")
        admission = admit_scope_epoch(
            old,
            proposed,
            view.champion,
            tuple(b.parent for b in batches(state) if b.scope_id == old.id),
            previous["probabilities"],
            policy,
            PreparationCost(view.remaining_evaluations),
            lambda ids, ids_tasks: PreparationCost(missing(view, ids, ids_tasks)),
        )
        if admission.status != "admitted":
            state["last_epoch_preparation"].append(asdict(admission))
            continue
        assert proposed is not None
        state["stage"] = "epoch-results"
        state["pending_epoch"] = {"scope": asdict(proposed), "admission": asdict(admission)}
        return Decision(
            state,
            tuple(
                Operation("evaluate_seed", candidate=c, tasks=proposed.task_ids)
                for c in admission.participant_ids
            ),
            "Prepare frozen scope epoch participants before generation",
        )
    if state["stage"] == "epochs":
        return plan_locals(view, state, config)
    if state["stage"] == "generate":
        return generate(view, state, config)
    raise ValueError("Unknown GEPA planning stage")
