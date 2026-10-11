"""Durable GEPA planning over seed views; state contains plans, not evidence copies."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any

from ..._protocol.canonical import digest
from ..contracts import Decision, Operation, ParentPolicy, SearchView
from .archive import project_seed_archive
from .epochs import EpochPolicy, PreparationCost, admit_scope_epoch
from .parent_plan import parent_input
from .parent_policies import ScopedFrontierPolicy
from .parent_random import RandomSource
from .research import ArchiveScope, ResearchArchive, must_pass_guard_identity
from .scope_types import FailureFamily, SamplingScope, SamplingTask, ScopeConfig, ordered_ids
from .scopes import create_scope
from .stage_evidence import eligible, missing, nominate, profiles


@dataclass(frozen=True)
class LocalPlan:
    candidate: str
    family: str
    scope_id: str
    parent: str
    task_ids: tuple[str, ...]
    weights: Mapping[str, float]
    failures: tuple[str, ...]


def plans(state: Mapping[str, Any]) -> tuple[LocalPlan, ...]:
    return tuple(
        LocalPlan(**{**p, "task_ids": tuple(p["task_ids"]), "failures": tuple(p["failures"])})
        for p in state.get("plans", [])
    )


def read_scope(value: Mapping[str, Any]) -> ArchiveScope:
    return ArchiveScope(**{**value, "task_ids": tuple(value["task_ids"])})


def _archive(view: SearchView, state: Mapping[str, Any], config: ScopeConfig) -> ResearchArchive:
    catalog = state["catalog"]
    return project_seed_archive(
        view,
        tuple(read_scope(c["scope"]) for c in catalog),
        {c["scope"]["id"]: tuple(c["registrations"]) for c in catalog},
        must_pass_guards={c["scope"]["id"]: config.guard_task_ids for c in catalog},
    )


def _add_scope(state: dict[str, Any], scope: ArchiveScope, members: tuple[str, ...] = ()) -> None:
    entry = next((c for c in state["catalog"] if c["scope"]["id"] == scope.id), None)
    if entry is None:
        entry = {"scope": asdict(scope), "registrations": []}
        state["catalog"].append(entry)
    entry["registrations"] = list(dict.fromkeys((*entry["registrations"], *members)))


def _scope(sample: SamplingScope, config: ScopeConfig) -> ArchiveScope:
    guard = must_pass_guard_identity(config.guard_task_ids)
    return ArchiveScope(
        digest([asdict(sample), guard]),
        sample.family_id,
        sample.epoch,
        sample.task_ids,
        sample.weights,
        guard,
    )


def _family(value: Mapping[str, Any]) -> FailureFamily:
    return FailureFamily(
        value["id"],
        tuple(value["task_ids"]),
        tuple(value["successful_control_task_ids"]),
        tuple(value["modification_paths"]),
    )


def record_local(view: SearchView, state: dict[str, Any], config: ScopeConfig) -> None:
    for plan in plans(state):
        scope = read_scope(
            next(c["scope"] for c in state["catalog"] if c["scope"]["id"] == plan.scope_id)
        )
        _add_scope(
            state,
            scope,
            tuple(
                c
                for c in (plan.parent, plan.candidate)
                if eligible(view, c, scope.task_ids, config.guard_task_ids)
            ),
        )


def plan_generation(
    view: SearchView,
    state: dict[str, Any],
    config: ScopeConfig,
    policy: EpochPolicy,
    parent_policy: ParentPolicy | None,
    batch_size: int,
) -> Decision:
    """Freeze parent selection, admit epochs, probe scopes, then generate candidates."""
    stage = state["stage"]
    tasks = tuple(SamplingTask(t, view.task_families.get(t, "seed")) for t in view.seed_tasks)
    if stage == "parents":
        if state["index"] >= view.max_candidates or view.remaining_evaluations < len(
            view.seed_tasks
        ):
            return nominate(
                view, state, config.guard_task_ids, "Nominate from complete common seed evidence"
            )
        if "catalog" not in state:
            guard = must_pass_guard_identity(config.guard_task_ids)
            bootstrap = ArchiveScope(
                "bootstrap",
                "bootstrap",
                0,
                view.seed_tasks,
                dict.fromkeys(view.seed_tasks, 1 / len(view.seed_tasks)),
                guard,
            )
            state["catalog"] = []
            state["family_history"] = {}
            _add_scope(state, bootstrap, (view.champion,))
        archive = _archive(view, state, config)
        if parent_policy is None:
            random_seed = digest([view.random_seed, state["round"], asdict(archive)])
            selection = ScopedFrontierPolicy()(
                parent_input(
                    archive, min(batch_size, view.max_candidates - state["index"]), random_seed
                ),
                RandomSource(random_seed),
            )
            allocation = selection.allocations[0]
            parent = next(
                c
                for c, identity in archive.identities.items()
                if identity == allocation.parent_identity
            )
            source = next(s for s in archive.scopes if s.id == allocation.scope_id)
            state["parent_selection"] = asdict(selection)
        else:
            parent = parent_policy(view)
            if not eligible(view, parent, view.seed_tasks, config.guard_task_ids):
                raise ValueError("Custom parent must have complete eligible seed evidence")
            source = next(s for s in archive.scopes if s.family == "bootstrap")
            state["parent_selection"] = {
                "parent": parent,
                "reason_codes": ["custom-full-seed-parent"],
            }
        state["parent"], state["parent_scope"] = parent, asdict(source)
        state["epoch"] = policy.epoch(state["round"])
        shared = state.setdefault("shared_epoch_successes", {})
        state["epoch_successes"] = shared.setdefault(
            str(state["epoch"]), [t for t in view.seed_tasks if profiles(view)[parent].get(t) == 1]
        )
        state["last_epoch_preparation"] = []
        # Freeze the old selection archive before preparing any newer scope.
        state["epoch_queue"] = [
            {"scope": asdict(s), "probabilities": dict(archive.views[s.id].parent_probabilities)}
            for s in sorted(archive.scopes, key=lambda s: s.family.encode("utf-16-be"))
            if policy.due(state["round"])
            and s.family != "bootstrap"
            and s.epoch < state["epoch"]
            and s.id in archive.scope_probabilities
        ]
        state["stage"] = "epochs"
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
            _add_scope(state, scope, tuple(admission["participant_ids"]))
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
                _family(history),
                tuple(state["epoch_successes"]),
                epoch=state["epoch"],
            )
            if history
            else None
        )
        proposed = _scope(sample, config) if sample else None
        if history and proposed is None:
            raise ValueError("Historical family has no representative in proposed epoch")
        admission = admit_scope_epoch(
            old,
            proposed,
            view.champion,
            (state["parent"],) if state["parent_scope"]["id"] == old.id else (),
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
        return _plan_locals(view, state, config, tasks, batch_size)
    if state["stage"] == "generate":
        return _generate(view, state, config)
    raise ValueError("Unknown GEPA planning stage")


def _plan_locals(
    view: SearchView,
    state: dict[str, Any],
    config: ScopeConfig,
    tasks: tuple[SamplingTask, ...],
    batch_size: int,
) -> Decision:
    source = read_scope(state["parent_scope"])
    archive = _archive(view, state, config)
    newer = [
        s
        for s in archive.scopes
        if s.family == source.family
        and s.epoch > source.epoch
        and state["parent"] in archive.views[s.id].representatives
    ]
    if newer:
        source = max(newer, key=lambda s: s.epoch)
    parent = state["parent"]
    if not eligible(view, parent, source.task_ids, config.guard_task_ids):
        return nominate(
            view, state, config.guard_task_ids, "Selected parent scope is incomplete or ineligible"
        )
    observed = profiles(view)[parent]
    families: dict[str, list[str]] = {}
    for task in tasks:
        if task.id in source.task_ids and observed[task.id] < 1:
            families.setdefault(task.stratum, []).append(task.id)
    if not families:
        return nominate(
            view, state, config.guard_task_ids, "Selected parent has no observed seed failures"
        )
    family_ids = ordered_ids(list(families))
    offset = state["round"] % len(family_ids)
    family_ids = family_ids[offset:] + family_ids[:offset]
    proposed: list[LocalPlan] = []
    for family_id in family_ids[: min(batch_size, view.max_candidates - state["index"])]:
        controls = tuple(t.id for t in tasks if t.stratum == family_id and observed.get(t.id) == 1)
        history = state["family_history"].get(family_id)
        family = FailureFamily(
            family_id,
            tuple(ordered_ids([*families[family_id], *(history["task_ids"] if history else [])])),
            tuple(
                ordered_ids(
                    [*controls, *(history["successful_control_task_ids"] if history else [])]
                )
            ),
        )
        state["family_history"][family_id] = asdict(family)
        existing = [s for s in archive.scopes if s.family == family_id]
        if existing:
            scope = max(existing, key=lambda s: s.epoch)
        else:
            sample = create_scope(
                tasks, config, family, tuple(state["epoch_successes"]), epoch=state["epoch"]
            )
            if sample is None:
                continue
            scope = _scope(sample, config)
        _add_scope(state, scope)
        proposed.append(
            LocalPlan(
                "",
                family_id,
                scope.id,
                parent,
                scope.task_ids,
                scope.weights,
                tuple(families[family_id]),
            )
        )
    # Admit the complete baseline/local group and a conservative seed expansion.
    while (
        proposed
        and sum(missing(view, (parent,), p.task_ids) + len(p.task_ids) for p in proposed)
        + len(view.seed_tasks)
        > view.remaining_evaluations
    ):
        proposed.pop()
    if not proposed:
        return nominate(
            view,
            state,
            config.guard_task_ids,
            "Budget cannot cover local baselines, candidates and seed expansion",
        )
    state["plans"] = [asdict(p) for p in proposed]
    state["stage"] = "generate"
    if any(missing(view, (parent,), p.task_ids) for p in proposed):
        return Decision(
            state,
            tuple(Operation("evaluate_seed", candidate=parent, tasks=p.task_ids) for p in proposed),
            "Complete frozen local parent baselines before generation",
        )
    return _generate(view, state, config)


def _generate(view: SearchView, state: dict[str, Any], config: ScopeConfig) -> Decision:
    confirmed: list[LocalPlan] = []
    for plan in plans(state):
        if eligible(view, plan.parent, plan.task_ids, config.guard_task_ids):
            scope = read_scope(
                next(c["scope"] for c in state["catalog"] if c["scope"]["id"] == plan.scope_id)
            )
            _add_scope(state, scope, (plan.parent,))
            if any(
                profiles(view)[plan.parent].get(t, 1) < 1
                for t in plan.failures
                if t in plan.task_ids
            ):
                confirmed.append(
                    LocalPlan(
                        f"candidate-{state['index'] + len(confirmed) + 1}",
                        plan.family,
                        plan.scope_id,
                        plan.parent,
                        plan.task_ids,
                        plan.weights,
                        plan.failures,
                    )
                )
    if not confirmed:
        return nominate(
            view, state, config.guard_task_ids, "No confirmed eligible local hypothesis"
        )
    state["index"] += len(confirmed)
    state["plans"] = [asdict(p) for p in confirmed]
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
        "Generate one candidate per admitted failure family",
    )
