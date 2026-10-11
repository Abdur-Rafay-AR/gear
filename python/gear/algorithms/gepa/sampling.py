"""Local task selection; the runtime enforces the admitted seed universe."""

from ..contracts import SearchView


def sample_tasks(view: SearchView, parent: str) -> tuple[str, ...]:
    candidate = next(c for c in view.candidates if c.id == parent)
    failures = tuple(t for t in view.seed_tasks if candidate.scores.get(t, 0) < 1)
    return failures or view.seed_tasks
