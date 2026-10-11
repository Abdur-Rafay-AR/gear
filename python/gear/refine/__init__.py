"""Refinement facade; TypeScript remains the only durable-state owner."""

from dataclasses import dataclass
from typing import Any

from ..project import Project


@dataclass(frozen=True)
class RefineOptions:
    rounds: int = 1


def refine(project: Project, options: RefineOptions | None = None) -> dict[str, Any]:
    return project.refine(rounds=(options or RefineOptions()).rounds)
