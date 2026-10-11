"""Readable incremental flow using the same public contracts as user algorithms.

This is the versioned Python recipe, not a claim of byte-for-byte equivalence to
historical failure-cluster-gepa-v2. Historical runs retain their frozen runtime.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ..contracts import (
    CandidateRanker,
    Decision,
    Operation,
    ParentPolicy,
    ProposalPlanner,
    SearchView,
    StopRule,
    TaskSampler,
)
from .parents import select_parent
from .proposal import plan_proposal
from .ranking import rank_candidates
from .sampling import sample_tasks
from .stopping import should_stop


@dataclass
class GEPA:
    parent_policy: ParentPolicy = select_parent
    task_sampler: TaskSampler = sample_tasks
    proposal_planner: ProposalPlanner = plan_proposal
    candidate_ranker: CandidateRanker = rank_candidates
    stop_rule: StopRule = should_stop

    def step(self, view: SearchView, state: Mapping[str, Any]) -> Decision:
        stage = state.get("stage", "parents")
        index = int(state.get("index", 0))
        base = {"version": 1, "index": index}
        if stage == "parents":
            if self.stop_rule(view, index):
                return Decision(
                    {**base, "stage": "done"},
                    (Operation("nominate", candidate=self.candidate_ranker(view)),),
                    "Nominate on complete common seed evidence",
                )
            parent = self.parent_policy(view)
            return Decision(
                {**base, "stage": "generate", "parent": parent},
                (self.proposal_planner(view, parent),),
                "Diagnose selected seed parent",
            )
        parent = str(state.get("parent", view.champion))
        candidate = f"candidate-{index + 1}"
        if stage == "generate":
            return Decision(
                {**base, "stage": "local", "parent": parent},
                (Operation("generate", candidate=candidate, parent=parent),),
                "Generate one candidate from the tracked diagnosis",
            )
        if stage == "local" and any(
            result.get("kind") == "generate"
            and result.get("candidate") == candidate
            and result.get("status") == "invalid-candidate"
            for result in view.completed.values()
        ):
            # Invalid generation still consumes its reserved candidate attempt.
            return self.step(view, {"version": 1, "index": index + 1, "stage": "parents"})
        if stage == "local":
            return Decision(
                {**base, "stage": "global", "parent": parent},
                (
                    Operation(
                        "evaluate_seed", candidate=candidate, tasks=self.task_sampler(view, parent)
                    ),
                ),
                "Evaluate local failures",
            )
        if stage == "global":
            return Decision(
                {"version": 1, "index": index + 1, "stage": "parents"},
                (Operation("evaluate_seed", candidate=candidate, tasks=view.seed_tasks),),
                "Complete the common seed scope before ranking",
            )
        return Decision({**base, "stage": "done"}, (Operation("stop"),), "Search finished")
