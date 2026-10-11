"""Ranking only nominates. The durable runtime owns the final validation gate."""

from ..contracts import SearchView
from .parents import select_parent


def rank_candidates(view: SearchView) -> str:
    return select_parent(view)
