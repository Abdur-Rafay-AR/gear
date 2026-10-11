"""Assign certified hypotheses only after the durable diagnosis stage settles."""

from __future__ import annotations

from dataclasses import asdict, replace
from typing import Any

from ..._protocol.canonical import digest
from ..contracts import Decision, Operation, SearchView
from .diagnosis import DiagnosisDossier, DiagnosisFact, DiagnosisTask, failure_clusters
from .proposal import GenerationBudget, candidate_workplan, plan_hypotheses
from .scope_types import FailureFamily, ScopeConfig
from .stage_catalog import add_scope, plans, read_scope
from .stage_evidence import nominate
from .stage_locals import merge_family


def propose(view: SearchView, state: dict[str, Any], config: ScopeConfig) -> Decision:
    before = set(state["diagnosis_before"])
    available = [
        (key, result)
        for key, result in view.completed.items()
        if key not in before and result.get("kind") == "diagnose_seed"
    ]
    used = list(state.get("used_hypotheses", []))
    accepted, operations = [], []
    tasks = tuple(DiagnosisTask(t, view.task_families.get(t, "seed")) for t in view.seed_tasks)
    for plan in plans(state):
        match = next(
            (
                (key, result)
                for key, result in available
                if result.get("candidate") == plan.parent
                and {t["id"] for t in result.get("tasks", [])} == set(plan.task_ids)
            ),
            None,
        )
        if match is None:
            raise ValueError("Assigned parent diagnosis has no committed receipt")
        key, result = match
        available.remove(match)
        if result.get("method") != "provider-seed-diagnosis-v1":
            raise ValueError("Model workplans require a certified provider dossier")
        value = result["dossier"]
        dossier = DiagnosisDossier(
            **{
                **value,
                "task_ids": tuple(value["task_ids"]),
                "baseline_evidence": tuple(value["baseline_evidence"]),
                "facts": tuple(
                    DiagnosisFact(
                        **{
                            **f,
                            "evidence_refs": tuple(f["evidence_refs"]),
                            "modification_paths": tuple(f.get("modification_paths", ())),
                        }
                    )
                    for f in value["facts"]
                ),
            }
        )
        parent = next(c for c in view.candidates if c.id == plan.parent)
        if dossier.parent_identity != parent.content_digest:
            raise ValueError("Certified diagnosis belongs to another parent")
        clusters = failure_clusters(dossier, tasks, dossier.cohort_identity, config.guard_task_ids)
        selected = plan_hypotheses(clusters, 1, used=tuple(used))
        if not selected:
            state["planning_exclusions"].append(
                {
                    "batch_id": plan.batch_id,
                    "family": plan.family,
                    "reason": "no-new-supported-hypothesis",
                }
            )
            continue
        hypothesis = selected[0]
        cluster = hypothesis.cluster
        scope = read_scope(
            next(c["scope"] for c in state["catalog"] if c["scope"]["id"] == plan.scope_id)
        )
        # The classifier may name a causal family different from the dataset stratum.
        # Keep the frozen task/weight manifest, but register its new family identity.
        scope = replace(scope, id=digest([scope.id, cluster.family_id]), family=cluster.family_id)
        local = replace(
            plan, family=cluster.family_id, scope_id=scope.id, failures=cluster.task_ids
        )
        add_scope(state, scope, (plan.parent,))
        family = FailureFamily(
            cluster.family_id,
            cluster.task_ids,
            cluster.successful_control_task_ids,
            cluster.modification_paths,
        )
        state["family_history"][cluster.family_id] = asdict(
            merge_family(state["family_history"].get(cluster.family_id), family)
        )
        workplan = candidate_workplan(
            plan.candidate,
            plan.batch_id,
            hypothesis,
            scope,
            digest(asdict(local)),
            view.seed_tasks,
            GenerationBudget(),
        )
        operations.append(
            Operation(
                "generate",
                candidate=plan.candidate,
                parent=plan.parent,
                tasks=plan.task_ids,
                diagnosis_id=key,
                workplan=asdict(workplan),
            )
        )
        accepted.append(asdict(local))
        used.append(hypothesis.identity)
    state.pop("diagnosis_before")
    state["used_hypotheses"] = used
    state["plans"] = accepted
    state["stage"] = "local"
    if not operations:
        return nominate(
            view,
            state,
            config.guard_task_ids,
            "No supported hypothesis can authorize candidate generation",
        )
    return Decision(
        state,
        tuple(operations),
        "Generate within certified hypothesis boundaries and frozen local scopes",
    )
