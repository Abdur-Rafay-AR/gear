"""Scope sampling metadata from verified seed history, without storing raw evidence.

The runtime authenticates observations and supplies opaque task/condition/version
identities. This policy folds complete execution slots into difficulty and merges
committed diagnosis labels; it never grades output or repairs evidence itself.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from fractions import Fraction

from ..._protocol.canonical import digest
from ..contracts import SearchView
from .scope_types import SamplingTask, ordered_ids, task_index


@dataclass(frozen=True)
class SamplingTaskContract:
    task: SamplingTask
    identity: str
    slots: tuple[str, ...] = ("0",)
    success_utility: float = 1


@dataclass(frozen=True)
class SamplingObservation:
    task_id: str
    task_identity: str
    condition_identity: str
    version_identity: str
    slot: str
    utility: float | None
    evidence_identity: str


@dataclass(frozen=True)
class SamplingFeature:
    submodes: tuple[str, ...] = ()
    modification_paths: tuple[str, ...] = ()


@dataclass(frozen=True)
class SamplingDiagnosis:
    family_id: str
    task_ids: tuple[str, ...]
    successful_control_task_ids: tuple[str, ...] = ()
    modification_paths: tuple[str, ...] = ()
    features: Mapping[str, SamplingFeature] = field(default_factory=dict)


@dataclass(frozen=True)
class SamplingEvidence:
    cutoff_identity: str
    tasks: tuple[SamplingTask, ...]


def sampling_evidence(
    contracts: tuple[SamplingTaskContract, ...],
    condition_identity: str,
    cutoff_identity: str,
    diagnoses: tuple[SamplingDiagnosis, ...],
    observations: tuple[SamplingObservation, ...],
    *,
    partition: str = "seed",
    objective: bool = False,
) -> SamplingEvidence:
    if partition != "seed" or not condition_identity or not cutoff_identity:
        raise ValueError("Sampling requires a frozen seed-only cohort and cutoff")
    task_index(tuple(c.task for c in contracts))
    indexed = {c.task.id: c for c in contracts}
    if any(
        not c.identity
        or not c.slots
        or len(set(c.slots)) != len(c.slots)
        or any(not s for s in c.slots)
        or not math.isfinite(c.success_utility)
        for c in contracts
    ):
        raise ValueError("Invalid sampling task contract")
    families: dict[str, set[str]] = {t: set() for t in indexed}
    submodes: dict[str, set[str]] = {t: set() for t in indexed}
    paths: dict[str, set[str]] = {t: set() for t in indexed}
    for diagnosis in diagnoses:
        ids = {*diagnosis.task_ids, *diagnosis.successful_control_task_ids}
        if not diagnosis.family_id or not ids <= set(indexed) or not set(diagnosis.features) <= ids:
            raise ValueError("Sampling diagnosis outside seed cohort")
        for task_id in ids:
            feature = diagnosis.features.get(task_id)
            families[task_id].add(diagnosis.family_id)
            submodes[task_id].update(feature.submodes if feature else ())
            paths[task_id].update(
                feature.modification_paths if feature else diagnosis.modification_paths
            )
    cells: dict[tuple[str, str, str], SamplingObservation] = {}
    for cell in observations:
        contract = indexed.get(cell.task_id)
        if (
            contract is None
            or cell.task_identity != contract.identity
            or cell.condition_identity != condition_identity
            or cell.slot not in contract.slots
            or not cell.version_identity
            or not cell.evidence_identity
        ):
            raise ValueError("Sampling evidence outside frozen seed conditions")
        if cell.utility is None:
            continue
        if not math.isfinite(cell.utility):
            raise ValueError("Sampling utility must be finite or unavailable")
        key = (cell.version_identity, cell.task_id, cell.slot)
        previous = cells.get(key)
        if previous is not None and previous != cell:
            raise ValueError("Sampling evidence cannot replace a valid outcome")
        cells[key] = cell
    versions_by_task: dict[str, dict[str, dict[str, float]]] = {task_id: {} for task_id in indexed}
    for (version, task_id, slot), cell in cells.items():
        assert cell.utility is not None
        versions_by_task[task_id].setdefault(version, {})[slot] = cell.utility
    tasks = []
    for contract in contracts:
        versions = versions_by_task[contract.task.id]
        completed = [v for v in versions.values() if set(v) == set(contract.slots)]
        difficulty = None
        if completed and not objective:
            failed = sum(
                float(
                    sum((Fraction(str(v[s])) for s in contract.slots), Fraction())
                    / len(contract.slots)
                )
                < contract.success_utility
                for v in completed
            )
            difficulty = failed / len(completed)
        task_id = contract.task.id
        tasks.append(
            replace(
                contract.task,
                family_ids=tuple(ordered_ids(list(families[task_id]))),
                submodes=tuple(ordered_ids(list(submodes[task_id]))),
                modification_paths=tuple(ordered_ids(list(paths[task_id]))),
                historical_difficulty=difficulty,
            )
        )
    return SamplingEvidence(cutoff_identity, tuple(tasks))


def project_sampling_evidence(
    view: SearchView, diagnoses: tuple[SamplingDiagnosis, ...] = ()
) -> SamplingEvidence:
    """Project v1 pass-rate views (one frozen attempt per candidate/task).

    Execution identities differ from Target content identities: a cache alias
    shares its execution version; separately submitted candidates remain distinct.
    Older custom/toy views without provenance use distinct candidate IDs.
    """
    condition = view.evidence_condition or digest(["toy-seed-condition", view.random_seed])
    contracts = tuple(
        SamplingTaskContract(
            SamplingTask(t, view.task_families.get(t, "seed")), digest([condition, t])
        )
        for t in view.seed_tasks
    )
    identities = {c.task.id: c.identity for c in contracts}
    observations = []
    for candidate in view.candidates:
        if (
            (
                candidate.execution_digest is not None
                and set(candidate.score_evidence) != set(candidate.scores)
            )
            or not set(candidate.score_evidence) <= set(identities)
            or any(not isinstance(ref, str) or not ref for ref in candidate.score_evidence.values())
        ):
            raise ValueError("Project sampling requires complete seed evidence references")
        version = candidate.execution_digest or f"candidate:{candidate.id}"
        for task_id, value in candidate.scores.items():
            if task_id not in identities:
                raise ValueError("Sampling evidence contains non-seed scores")
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError("Project sampling requires certified pass scores")
            observations.append(
                SamplingObservation(
                    task_id,
                    identities[task_id],
                    condition,
                    version,
                    "0",
                    value,
                    candidate.score_evidence.get(task_id) or digest([condition, version, task_id]),
                )
            )
    rows: set[tuple[str, str, str, float | None, str]] = {
        (c.task_id, c.version_identity, c.slot, c.utility, c.evidence_identity)
        for c in observations
    }
    ordered_rows = list(rows)
    ordered_rows.sort(
        key=lambda row: (row[0].encode("utf-16-be"), row[1], row[2], row[4], row[3] or 0)
    )
    cutoff = digest([condition, ordered_rows])

    return sampling_evidence(contracts, condition, cutoff, diagnoses, tuple(observations))
