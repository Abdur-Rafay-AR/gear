"""Candidate hypotheses, delivery and receipts; no model calls or execution state."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal

from ..._protocol.canonical import digest
from ..contracts import Operation, SearchView
from .diagnosis import DiagnosisDossier, DiagnosisFact, FailureCluster, relative_boundary
from .research import ArchiveScope
from .scope_types import ordered_ids


def plan_proposal(view: SearchView, parent: str) -> Operation:
    """Compatibility planner for the original project recipe."""
    return Operation("diagnose_seed", candidate=parent, tasks=view.seed_tasks)


def diagnosis_reference(view: SearchView, parent: str) -> str | None:
    """Bind a committed diagnosis once; the runtime validates its parent again."""
    return next(
        (
            key
            for key, value in reversed(tuple(view.completed.items()))
            if value.get("kind") == "diagnose_seed" and value.get("candidate") == parent
        ),
        None,
    )


@dataclass(frozen=True)
class HypothesisPlan:
    cluster: FailureCluster
    hypothesis: str

    @property
    def identity(self) -> str:
        return digest([self.cluster.parent_identity, self.cluster.family_id, self.hypothesis])


def plan_hypotheses(
    clusters: tuple[FailureCluster, ...],
    slots: int,
    *,
    per_family: int = 1,
    used: tuple[str, ...] = (),
) -> tuple[HypothesisPlan, ...]:
    if type(slots) is not int or slots < 0 or type(per_family) is not int or per_family < 1:
        raise ValueError("Proposal quotas must be nonnegative slots and positive family limits")
    selected: list[HypothesisPlan] = []
    seen = set(used)
    for cluster in clusters:
        for hypothesis in cluster.hypotheses[:per_family]:
            if len(selected) >= slots:
                return tuple(selected)
            proposal = HypothesisPlan(cluster, hypothesis)
            if proposal.identity in seen:
                continue
            selected.append(proposal)
            seen.add(proposal.identity)
    return tuple(selected)


@dataclass(frozen=True)
class GenerationBudget:
    deadline_ms: int | None = None
    max_tokens: int | None = None
    max_model_requests: int | None = None

    def __post_init__(self) -> None:
        if (
            self.deadline_ms is not None
            and (type(self.deadline_ms) is not int or not 1 <= self.deadline_ms <= 2**53 - 1)
        ) or any(
            v is not None and (type(v) is not int or not 0 <= v <= 2**53 - 1)
            for v in (self.max_tokens, self.max_model_requests)
        ):
            raise ValueError("Invalid proposal generation budget")


@dataclass(frozen=True)
class CandidateWorkPlan:
    candidate_id: str
    batch_id: str
    parent_identity: str
    dossier_identity: str
    cluster_identity: str
    family_id: str
    hypothesis: str
    target_task_ids: tuple[str, ...]
    required_diagnosis_refs: tuple[str, ...]
    modification_paths: tuple[str, ...]
    scope_id: str
    local_plan_id: str
    required_seed_tasks: tuple[str, ...]
    generation_budget: GenerationBudget
    on_insufficient_scope: Literal["retain-research-only"] = "retain-research-only"

    @property
    def identity(self) -> str:
        return digest(asdict(self))


def candidate_workplan(
    candidate: str,
    batch: str,
    proposal: HypothesisPlan,
    scope: ArchiveScope,
    local_plan_id: str,
    seed_tasks: tuple[str, ...],
    budget: GenerationBudget,
) -> CandidateWorkPlan:
    cluster = proposal.cluster
    if (
        not candidate
        or not batch
        or not local_plan_id
        or not seed_tasks
        or len(set(seed_tasks)) != len(seed_tasks)
    ):
        raise ValueError("Workplan requires candidate, batch, local plan and frozen seed manifest")
    if proposal.hypothesis not in cluster.hypotheses or scope.family != cluster.family_id:
        raise ValueError("Workplan must use its assigned family hypothesis and scope")
    if not {*scope.task_ids, *cluster.task_ids} <= set(seed_tasks):
        raise ValueError("Workplan contains tasks outside the frozen seed cohort")
    if (
        not cluster.evidence_refs
        or not cluster.modification_paths
        or any(not relative_boundary(p) for p in cluster.modification_paths)
    ):
        raise ValueError("Workplan needs supported seed evidence and a safe modification boundary")
    return CandidateWorkPlan(
        candidate,
        batch,
        cluster.parent_identity,
        cluster.dossier_identity,
        cluster.identity,
        cluster.family_id,
        proposal.hypothesis,
        cluster.task_ids,
        cluster.evidence_refs,
        cluster.modification_paths,
        scope.id,
        local_plan_id,
        tuple(ordered_ids(seed_tasks)),
        budget,
    )


@dataclass(frozen=True)
class DossierExcerpt:
    source_dossier_identity: str
    parent_identity: str
    baseline_evidence: tuple[str, ...]
    facts: tuple[DiagnosisFact, ...]
    classifier_identity: str
    sanitization_identity: str


@dataclass(frozen=True)
class ProposalDelivery:
    workplan: CandidateWorkPlan
    dossier: DossierExcerpt
    findings: tuple[Mapping[str, Any], ...] = ()
    scope: ArchiveScope | None = None

    @property
    def identity(self) -> str:
        return digest(asdict(self))


def deliver_workplan(
    workplan: CandidateWorkPlan,
    dossier: DiagnosisDossier,
    findings: tuple[Mapping[str, Any], ...] = (),
    scope: ArchiveScope | None = None,
) -> ProposalDelivery:
    if (
        workplan.dossier_identity != dossier.identity
        or workplan.parent_identity != dossier.parent_identity
    ):
        raise ValueError("Workplan dossier or parent mismatch")
    if workplan.on_insufficient_scope != "retain-research-only":
        raise ValueError("Insufficient modification scope must remain research-only")
    if scope is not None and workplan.scope_id != scope.id:
        raise ValueError("Delivered scope does not match assigned workplan")
    task_ids = set(workplan.target_task_ids) | (set(scope.task_ids) if scope else set())
    if not task_ids <= set(workplan.required_seed_tasks):
        raise ValueError("Delivery contains tasks outside frozen seed")
    facts = tuple(f for f in dossier.facts if f.task_id in task_ids)
    available = {r for f in facts for r in f.evidence_refs}
    if not set(workplan.required_diagnosis_refs) <= available:
        raise ValueError("Assigned diagnostic evidence is missing from the excerpt")
    return ProposalDelivery(
        workplan,
        DossierExcerpt(
            dossier.identity,
            dossier.parent_identity,
            dossier.baseline_evidence,
            facts,
            dossier.classifier_identity,
            dossier.sanitization_identity,
        ),
        findings,
        scope,
    )


@dataclass(frozen=True)
class WorkplanReceipt:
    candidate_id: str
    session_id: str
    workplan_identity: str
    dossier_identity: str
    delivered_identity: str
    accessed_refs: tuple[str, ...]


def consumption_receipt(
    delivery: ProposalDelivery,
    session_id: str,
    accessed_refs: tuple[str, ...],
) -> WorkplanReceipt:
    if not session_id or not set(delivery.workplan.required_diagnosis_refs) <= set(accessed_refs):
        raise ValueError("Candidate session has not consumed its assigned diagnostic evidence")
    return WorkplanReceipt(
        delivery.workplan.candidate_id,
        session_id,
        delivery.workplan.identity,
        delivery.dossier.source_dossier_identity,
        delivery.identity,
        tuple(ordered_ids(accessed_refs)),
    )


def validate_receipt(receipt: WorkplanReceipt, delivery: ProposalDelivery, session_id: str) -> None:
    expected = consumption_receipt(delivery, session_id, receipt.accessed_refs)
    if receipt != expected:
        raise ValueError("Invalid workplan consumption receipt")
