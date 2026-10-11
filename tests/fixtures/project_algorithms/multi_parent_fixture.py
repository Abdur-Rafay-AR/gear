"""Public plan policy that retains champion and one eligible local specialist."""

from gear.algorithms import EpochPolicy, ParentAllocation, ParentPlan, StagedGEPA
from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit


def choose(view, random):
    champion = view.champion
    candidates = [
        (s, p)
        for s in view.scopes
        for p in s.parents
        if p.candidate_id != champion.candidate_id and p.probability > 0
    ]
    allocations = [
        ParentAllocation(
            champion.scope_id, champion.identity, view.max_candidates, 0, "champion"
        )
    ]
    probabilities = {champion.candidate_id: 1}
    if candidates and view.max_candidates > 1:
        s, p = candidates[0]
        allocations = [
            ParentAllocation(champion.scope_id, champion.identity, 1, 0, "champion"),
            ParentAllocation(s.id, p.identity, view.max_candidates - 1, 1, "gepa"),
        ]
        probabilities = {champion.candidate_id: 0.5, p.candidate_id: 0.5}
    return ParentPlan(tuple(allocations), probabilities, ("champion-and-specialist",))


def build_algorithm():
    return StagedGEPA(
        ScopeConfig(
            local=TaskSetLimit(0.2), shared=TaskSetLimit(0), cross=TaskSetLimit(0)
        ),
        batch_size=2,
        bridge_max_candidates=0,
        epoch_policy=EpochPolicy(1),
        parent_selection_policy=choose,
    )
