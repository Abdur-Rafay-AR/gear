"""Full-seed archive adapter and compatible exports for frontier policy helpers."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction

from ..contracts import SearchView
from .frontier import (
    FrontierCandidate,
    ScopeFrontier,
    TaskFront,
    comparison_key,
    scope_frontier,
    weighted_choice,
)
from .research import (
    ArchiveMember,
    ArchiveScope,
    ResearchArchive,
    ScopedProfile,
    build_research_archive,
)

__all__ = [
    "FrontierCandidate",
    "FrontierParentPolicy",
    "ScopeFrontier",
    "TaskFront",
    "comparison_key",
    "project_seed_archive",
    "scope_frontier",
    "weighted_choice",
]


def project_seed_archive(
    view: SearchView,
    scopes: tuple[ArchiveScope, ...],
    registrations: Mapping[str, tuple[str, ...]] | None = None,
) -> ResearchArchive:
    """Project runtime-certified pass scores without copying an evidence database.

    New project views use candidate admission order to break identical-Target
    ties. Optional registrations limit which scope/candidate pairs may support
    the archive; absent registrations admit all observed pairs. Guarded and
    process/objective profiles use build_research_archive after trusted grading.
    """
    members, profiles = [], []
    candidate_ids = {c.id for c in view.candidates}
    if registrations is not None and (
        not set(registrations) <= {s.id for s in scopes}
        or any(not set(ids) <= candidate_ids for ids in registrations.values())
    ):
        raise ValueError("Unknown scope/candidate registration")
    for index, candidate in enumerate(view.candidates):
        identity = (
            f"content:{candidate.content_digest}"
            if candidate.content_digest
            else f"id:{candidate.id}"
        )
        members.append(ArchiveMember(candidate.id, f"candidate:{candidate.id}", identity))
        scores = {t: candidate.scores[t] for t in view.seed_tasks if t in candidate.scores}
        if any(not math.isfinite(v) or not 0 <= v <= 1 for v in scores.values()):
            raise ValueError("Frontier parent policy requires observed pass scores")
        for scope in scopes:
            if scope.guard_identity:
                raise ValueError("Guarded profiles require trusted guard evaluation")
            if registrations is not None and candidate.id not in registrations.get(scope.id, ()):
                continue
            observed = {t: scores[t] for t in scope.task_ids if t in scores}
            complete = bool(scope.task_ids) and len(observed) == len(scope.task_ids)
            aggregate = None
            if complete:
                total = sum((Fraction(str(scope.weights[t])) for t in scope.task_ids), Fraction())
                if total <= 0:
                    raise ValueError("Archive scope needs positive scoring mass")
                aggregate = comparison_key(
                    sum(
                        (
                            Fraction(str(observed[t])) * Fraction(str(scope.weights[t]))
                            for t in scope.task_ids
                        ),
                        Fraction(),
                    )
                    / total
                )
            profiles.append(
                ScopedProfile(
                    scope.id,
                    FrontierCandidate(
                        candidate.id,
                        identity,
                        {t: comparison_key(v) for t, v in observed.items()},
                        aggregate,
                        observed_at=index,
                    ),
                )
            )
    return build_research_archive(
        view.seed_tasks, tuple(members), scopes, tuple(profiles), view.champion
    )


@dataclass(frozen=True)
class FrontierParentPolicy:
    """Full-seed archive policy using admission order and portable UTF-16 ties."""

    def __call__(self, view: SearchView) -> str:
        if not view.seed_tasks:
            raise ValueError("Frontier requires a nonempty seed scope")
        scope = ArchiveScope(
            "bootstrap",
            "bootstrap",
            0,
            view.seed_tasks,
            dict.fromkeys(view.seed_tasks, 1 / len(view.seed_tasks)),
        )
        archive = project_seed_archive(view, (scope,))
        return weighted_choice(archive.parent_probabilities, view.random_seed)
