"""Freeze all parent allocations before scope preparation or generation."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
from typing import Any

from ..._protocol.canonical import digest
from ..contracts import ParentPolicy, SearchView
from .epochs import EpochPolicy
from .history import project_sampling_evidence
from .parent_plan import ParentBatch, ParentSelectionPolicy, parent_batches, parent_input
from .parent_policies import ScopedFrontierPolicy
from .parent_random import RandomSource
from .research import ArchiveScope, must_pass_guard_identity
from .scope_types import ScopeConfig
from .stage_catalog import add_scope, archive, diagnoses
from .stage_evidence import eligible, profiles


def batches(state: dict[str, Any]) -> tuple[ParentBatch, ...]:
    return tuple(ParentBatch(**b) for b in state["parent_batches"])


def freeze_parents(
    view: SearchView,
    state: dict[str, Any],
    config: ScopeConfig,
    epoch_policy: EpochPolicy,
    parent_policy: ParentPolicy | None,
    selection_policy: ParentSelectionPolicy | None,
    batch_size: int,
) -> None:
    if "catalog" not in state:
        state["catalog"], state["family_history"] = [], {}
        add_scope(
            state,
            ArchiveScope(
                "bootstrap",
                "bootstrap",
                0,
                view.seed_tasks,
                dict.fromkeys(view.seed_tasks, 1 / len(view.seed_tasks)),
                must_pass_guard_identity(config.guard_task_ids),
            ),
            (view.champion,),
        )
    frozen = archive(view, state, config)
    slots = min(batch_size, view.max_candidates - state["index"])
    round_id = f"round-{state['round']}"
    if parent_policy is None:
        random_seed = digest([view.random_seed, state["round"], asdict(frozen)])
        parent_view = parent_input(frozen, slots, random_seed, include_champion=True)
        selection = (selection_policy or ScopedFrontierPolicy())(
            deepcopy(parent_view), RandomSource(random_seed)
        )
        selected = parent_batches(parent_view, selection, round_id)
        state["parent_selection"] = asdict(selection)
        state["parent_selection_context"] = {
            "input_digest": digest(asdict(parent_view)),
            "random_seed": random_seed,
        }
    else:
        parent = parent_policy(view)
        if not eligible(view, parent, view.seed_tasks, config.guard_task_ids):
            raise ValueError("Custom parent must have complete eligible seed evidence")
        selected = (ParentBatch(f"{round_id}-batch-0", parent, "bootstrap", slots, 0),)
        state["parent_selection"] = {
            "parent": parent,
            "reason_codes": ["custom-full-seed-parent"],
        }
        state["parent_selection_context"] = {"input_digest": digest(asdict(view))}
    state["parent_batches"] = [asdict(b) for b in selected]
    state["planning_family_history"] = deepcopy(state["family_history"])
    state["sampling_evidence"] = asdict(project_sampling_evidence(view, diagnoses(state)))
    state["sampling_coverage"] = {c.id: list(c.scores) for c in view.candidates}
    state["batch_sampling"] = []
    state["planning_exclusions"] = []
    state["epoch"] = epoch_policy.epoch(state["round"])
    first_parent = selected[0].parent if selected else view.champion
    shared = state.setdefault("shared_epoch_successes", {})
    state["epoch_successes"] = shared.setdefault(
        str(state["epoch"]),
        [t for t in view.seed_tasks if profiles(view)[first_parent].get(t) == 1],
    )
    state["last_epoch_preparation"] = []
    state["epoch_queue"] = [
        {"scope": asdict(s), "probabilities": dict(frozen.views[s.id].parent_probabilities)}
        for s in sorted(frozen.scopes, key=lambda s: s.family.encode("utf-16-be"))
        if selected
        and epoch_policy.due(state["round"])
        and s.family != "bootstrap"
        and s.epoch < state["epoch"]
        and s.id in frozen.scope_probabilities
    ]
    state["stage"] = "epochs"
