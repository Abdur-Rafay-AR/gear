"""Refinement facade; TypeScript remains the only durable-state owner."""

from dataclasses import dataclass
from typing import Any

from ..algorithms import AlgorithmSource, SearchAlgorithm
from ..project import Project


@dataclass(frozen=True)
class RefineOptions:
    rounds: int = 1
    algorithm: SearchAlgorithm | AlgorithmSource | None = None


def refine(project: Project, options: RefineOptions | None = None) -> dict[str, Any]:
    selected = options or RefineOptions()
    return project.refine(rounds=selected.rounds, algorithm=selected.algorithm)


async def arefine(project: Project, options: RefineOptions | None = None) -> dict[str, Any]:
    selected = options or RefineOptions()
    return await project.arefine(rounds=selected.rounds, algorithm=selected.algorithm)
