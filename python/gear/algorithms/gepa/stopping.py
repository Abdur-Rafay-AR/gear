"""Stop planning before consuming a generation that cannot be evaluated."""

from ..contracts import SearchView


def diagnosis_capacity(view: SearchView) -> int:
    if view.diagnosis_budget is None:
        return view.max_candidates
    return min(view.diagnosis_budget.values())


def should_stop(view: SearchView, generated: int) -> bool:
    return (
        generated >= view.max_candidates
        or view.remaining_evaluations < len(view.seed_tasks)
        or diagnosis_capacity(view) == 0
    )
