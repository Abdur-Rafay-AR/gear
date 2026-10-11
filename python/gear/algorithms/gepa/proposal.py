"""Proposal planning declares a tracked operation; it never calls a model."""

from ..contracts import Operation, SearchView


def plan_proposal(view: SearchView, parent: str) -> Operation:
    return Operation("diagnose_seed", candidate=parent, tasks=view.seed_tasks)
