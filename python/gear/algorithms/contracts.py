"""Public immutable author contracts. Only seed evidence crosses this boundary."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from .._protocol.generated import OperationKind


@dataclass(frozen=True)
class Candidate:
    id: str
    scores: Mapping[str, float]
    content_digest: str | None = None
    execution_digest: str | None = None
    score_evidence: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SearchView:
    seed_tasks: tuple[str, ...]
    candidates: tuple[Candidate, ...]
    champion: str
    max_candidates: int
    remaining_evaluations: int
    random_seed: str
    completed: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    task_families: Mapping[str, str] = field(default_factory=dict)
    evidence_condition: str | None = None
    diagnosis_budget: Mapping[str, int] | None = None


@dataclass(frozen=True)
class Operation:
    kind: OperationKind
    candidate: str = ""
    tasks: tuple[str, ...] = ()
    parent: str = ""
    diagnosis_id: str | None = None
    workplan: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class Decision:
    state: Mapping[str, Any]
    operations: tuple[Operation, ...]
    reason: str


class SearchAlgorithm(Protocol):
    def step(self, view: SearchView, state: Mapping[str, Any]) -> Decision: ...


class ParentPolicy(Protocol):
    def __call__(self, view: SearchView) -> str: ...


class TaskSampler(Protocol):
    def __call__(self, view: SearchView, parent: str) -> tuple[str, ...]: ...


class CandidateRanker(Protocol):
    def __call__(self, view: SearchView) -> str: ...


class ProposalPlanner(Protocol):
    def __call__(self, view: SearchView, parent: str) -> Operation: ...


class StopRule(Protocol):
    def __call__(self, view: SearchView, generated: int) -> bool: ...
