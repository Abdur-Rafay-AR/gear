"""RRSI recipe built on Gear's public staged-search contract."""

from __future__ import annotations

from dataclasses import replace
from typing import cast

from gear.canonical import JSON

from ..contracts import (
    AlgorithmState,
    CandidateRanker,
    Decision,
    ParentPolicy,
    ProposalPlanner,
    SearchView,
    StopRule,
    TaskSampler,
)
from ..workflow import StagedSearch
from .config import RRSIConfig
from .history import COMPONENTS, measured_history, prune_components, stalled, tried_components
from .parents import select_parent
from .proposal import RRSIProposalPlanner
from .ranking import rank_candidates
from .sampling import sample_tasks
from .stopping import configured_stop_reason


class RRSI(StagedSearch):
    """Configurable RRSI policy recipe.

    Gear deliberately keeps candidate screening, evaluation and nomination in
    the trusted runtime. The generated operation payload carries RRSI's
    regularization directives so a compatible runtime can enforce them without
    changing the public operation vocabulary.
    """

    def __init__(
        self,
        *,
        config: RRSIConfig | None = None,
        parent_policy: ParentPolicy = select_parent,
        sampler: TaskSampler = sample_tasks,
        proposal_planner: ProposalPlanner | None = None,
        ranker: CandidateRanker = rank_candidates,
        stop_rule: StopRule | None = None,
    ) -> None:
        self.config = config or RRSIConfig()
        planner = proposal_planner or RRSIProposalPlanner(self.config)
        stopping = stop_rule or (
            lambda view, state: configured_stop_reason(view, state, self.config)
        )
        super().__init__(
            parent_policy,
            sampler,
            planner,
            ranker,
            stopping,
            ("global",),
            (),
        )

    def step(self, view: SearchView, state: AlgorithmState) -> Decision:
        decision = super().step(view, state)
        round_value = decision.state.data.get("round", 0)
        round_index = round_value if type(round_value) is int else 0
        prior_raw = decision.state.data.get("rrsi_history", [])
        prior_history: list[dict[str, JSON]] = (
            cast(list[dict[str, JSON]], [item for item in prior_raw if isinstance(item, dict)])
            if isinstance(prior_raw, list)
            else []
        )
        history = measured_history(prior_history, view.evidence)
        score_trajectory: list[float] = []
        for row in history:
            score = row.get("score")
            if isinstance(score, (int, float)):
                score_trajectory.append(float(score))
        tried = sorted(tried_components(history))
        untried = [component for component in COMPONENTS if component not in tried]
        directives: dict[str, JSON] = {
            "config": cast(JSON, self.config.to_json()),
            "edit_budget": self.config.edit_budget(round_index),
            "noise_delta": self.config.noise_delta,
            "history": cast(JSON, history),
            "stall": stalled(
                score_trajectory,
                round_index,
                self.config.stall_window,
                self.config.noise_delta,
            ),
            "tried_components": cast(JSON, tried),
            "untried_components": cast(JSON, untried),
            "prune_components": cast(JSON, prune_components(history)),
        }
        operations = tuple(
            replace(
                operation,
                payload={
                    **(operation.payload if isinstance(operation.payload, dict) else {}),
                    "rrsi": directives,
                },
            )
            if operation.kind == "generate_candidate"
            else operation
            for operation in decision.operations
        )
        data = cast(
            dict[str, JSON],
            {**decision.state.data, "rrsi": directives, "rrsi_history": history},
        )
        return replace(decision, state=type(decision.state)(data=data), operations=operations)
