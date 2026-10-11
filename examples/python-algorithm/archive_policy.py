"""Select a parent by family-scoped GEPA probabilities using public APIs only."""

from gear.algorithms import GEPA, RandomSource, ScopedFrontierPolicy, SearchView
from gear.algorithms.gepa.archive import project_seed_archive
from gear.algorithms.gepa.parent_plan import parent_input
from gear.algorithms.gepa.research import ArchiveScope


def choose_parent(view: SearchView) -> str:
    families: dict[str, list[str]] = {}
    for task in view.seed_tasks:
        families.setdefault(view.task_families.get(task, "seed"), []).append(task)
    scopes = tuple(
        ArchiveScope(
            f"family-{i}", family, 1, tuple(tasks), dict.fromkeys(tasks, 1 / len(tasks))
        )
        for i, (family, tasks) in enumerate(sorted(families.items()))
    )
    archive = project_seed_archive(view, scopes)
    selected = ScopedFrontierPolicy()(
        parent_input(archive, 1, view.random_seed), RandomSource(view.random_seed)
    )
    identity = selected.allocations[0].parent_identity
    return next(
        candidate for candidate, ref in archive.identities.items() if ref == identity
    )


def build_algorithm() -> GEPA:
    return GEPA(parent_policy=choose_parent)
