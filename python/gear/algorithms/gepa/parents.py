"""Change parent choice here, or supply GEPA(parent_policy=your_function)."""

from ..contracts import SearchView


def select_parent(view: SearchView) -> str:
    # A complete common seed scope is required before comparing candidates.
    eligible = [c for c in view.candidates if all(t in c.scores for t in view.seed_tasks)]
    if not eligible:
        return view.champion
    return min(eligible, key=lambda c: (-sum(c.scores[t] for t in view.seed_tasks), c.id)).id
