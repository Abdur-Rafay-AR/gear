"""Replace the complete parent allocation policy through the public Python API."""

from gear.algorithms import (
    ParentInput,
    ParentPlan,
    RandomSource,
    ScopedFrontierPolicy,
    StagedGEPA,
)


def choose_batches(view: ParentInput, random: RandomSource) -> ParentPlan:
    # Respect the final round's remaining candidate quota.
    return ScopedFrontierPolicy(batch_count=min(2, view.max_candidates))(view, random)


def build_algorithm() -> StagedGEPA:
    return StagedGEPA(batch_size=4, parent_selection_policy=choose_batches)
