"""Failure families derived from runtime-verified seed diagnosis dossiers.

These functions group supported hypotheses; they neither infer a cause from a
score nor authenticate raw observations. The runtime owns evidence certification.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Literal

from ..._protocol.canonical import digest
from .history import SamplingDiagnosis, SamplingFeature
from .scope_types import ordered_ids


@dataclass(frozen=True)
class DiagnosisTask:
    id: str
    stratum: str
    estimated_cost: float = 1


@dataclass(frozen=True)
class DiagnosisFact:
    task_id: str
    evidence_refs: tuple[str, ...]
    status: Literal[
        "supported-hypothesis", "unresolved", "infrastructure-invalid", "successful-control"
    ]
    family_id: str | None = None
    hypothesis: str | None = None
    modification_paths: tuple[str, ...] = ()
    mechanism: str | None = None
    submode: str | None = None


@dataclass(frozen=True)
class DiagnosisDossier:
    identity: str
    parent_identity: str
    cohort_identity: str
    task_ids: tuple[str, ...]
    baseline_evidence: tuple[str, ...]
    facts: tuple[DiagnosisFact, ...]
    classifier_identity: str
    sanitization_identity: str


@dataclass(frozen=True)
class FailureCluster:
    family_id: str
    parent_identity: str
    dossier_identity: str
    task_ids: tuple[str, ...]
    evidence_refs: tuple[str, ...]
    hypotheses: tuple[str, ...]
    modification_paths: tuple[str, ...]
    task_features: Mapping[str, SamplingFeature]
    successful_control_task_ids: tuple[str, ...]
    protected_failure: bool
    estimated_cost: float

    @property
    def identity(self) -> str:
        return digest(asdict(self))

    def sampling_diagnosis(self) -> SamplingDiagnosis:
        return SamplingDiagnosis(
            self.family_id,
            self.task_ids,
            self.successful_control_task_ids,
            self.modification_paths,
            self.task_features,
        )


def relative_boundary(path: str) -> bool:
    return (
        bool(path)
        and not path.startswith("/")
        and "\\" not in path
        and ":" not in path
        and all(p not in ("", ".", "..") for p in path.split("/"))
    )


def failure_clusters(
    dossier: DiagnosisDossier,
    tasks: tuple[DiagnosisTask, ...],
    cohort_identity: str,
    protected_ids: tuple[str, ...] = (),
    *,
    partition: str = "seed",
    family_order: tuple[str, ...] | None = None,
) -> tuple[FailureCluster, ...]:
    indexed = {t.id: t for t in tasks}
    if (
        partition != "seed"
        or not cohort_identity
        or dossier.cohort_identity != cohort_identity
        or not dossier.identity
        or not dossier.parent_identity
        or not dossier.classifier_identity
        or not dossier.sanitization_identity
        or len(indexed) != len(tasks)
        or len(set(dossier.task_ids)) != len(dossier.task_ids)
        or not set(dossier.task_ids) <= set(indexed)
        or not set(protected_ids) <= set(indexed)
        or not dossier.baseline_evidence
        or any(not r for r in dossier.baseline_evidence)
        or any(
            not t.id
            or not t.stratum
            or not math.isfinite(t.estimated_cost)
            or t.estimated_cost <= 0
            for t in tasks
        )
    ):
        raise ValueError("Diagnosis requires the frozen parent seed cohort and provenance")
    families: dict[str, list[DiagnosisFact]] = {}
    for fact in dossier.facts:
        if (
            fact.task_id not in dossier.task_ids
            or fact.status
            not in (
                "supported-hypothesis",
                "unresolved",
                "infrastructure-invalid",
                "successful-control",
            )
            or any(not r for r in fact.evidence_refs)
        ):
            raise ValueError("Diagnosis fact outside its frozen seed range")
        if any(not relative_boundary(p) for p in fact.modification_paths):
            raise ValueError("Unsafe diagnosis modification boundary")
        if fact.status != "supported-hypothesis":
            continue
        if (
            not fact.family_id
            or not fact.hypothesis
            or not fact.mechanism
            or not fact.modification_paths
            or not fact.evidence_refs
        ):
            raise ValueError(
                "Actionable diagnosis needs evidence, mechanism, hypothesis and boundary"
            )
        families.setdefault(fact.family_id, []).append(fact)
    order = tuple(ordered_ids(list(families))) if family_order is None else family_order
    if len(order) != len(families) or set(order) != set(families):
        raise ValueError("Frozen family order must cover each supported family")
    ranks = {f: i for i, f in enumerate(order)}
    result = []
    for family, facts in families.items():
        strata = {indexed[f.task_id].stratum for f in facts}
        paths = {p for f in facts for p in f.modification_paths}
        controls = [
            f
            for f in dossier.facts
            if f.status == "successful-control"
            and (
                f.family_id == family
                or indexed[f.task_id].stratum in strata
                or bool(set(f.modification_paths) & paths)
            )
        ]
        features = [*facts, *controls]
        task_ids = tuple(ordered_ids([f.task_id for f in facts]))
        result.append(
            FailureCluster(
                family,
                dossier.parent_identity,
                dossier.identity,
                task_ids,
                tuple(ordered_ids([r for f in facts for r in f.evidence_refs])),
                tuple(ordered_ids([f.hypothesis for f in facts if f.hypothesis is not None])),
                tuple(ordered_ids(list(paths))),
                {
                    task: SamplingFeature(
                        tuple(
                            ordered_ids(
                                [
                                    f.submode
                                    for f in features
                                    if f.task_id == task and f.submode is not None
                                ]
                            )
                        ),
                        tuple(
                            ordered_ids(
                                [
                                    p
                                    for f in features
                                    if f.task_id == task
                                    for p in f.modification_paths
                                ]
                            )
                        ),
                    )
                    for task in ordered_ids([f.task_id for f in features])
                },
                tuple(ordered_ids([f.task_id for f in controls])),
                any(f.task_id in protected_ids for f in facts),
                sum(indexed[t].estimated_cost for t in task_ids),
            )
        )
    return tuple(
        sorted(result, key=lambda c: (-c.protected_failure, -len(c.task_ids), ranks[c.family_id]))
    )
