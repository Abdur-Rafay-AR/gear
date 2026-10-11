"""Stop planning before consuming a generation that cannot be evaluated."""

from ..contracts import SearchView


def should_stop(view: SearchView, generated: int) -> bool:
    return generated >= view.max_candidates or view.remaining_evaluations < len(view.seed_tasks)
