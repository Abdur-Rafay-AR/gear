"""A complete small SearchAlgorithm, independent of the GEPA recipe."""

from collections.abc import Mapping
from typing import Any

from gear.algorithms import Decision, Operation, SearchView


class OneShot:
    def step(self, view: SearchView, state: Mapping[str, Any]) -> Decision:
        stage = state.get("stage", "generate")
        if stage == "done":
            return Decision(dict(state), (Operation("stop"),), "One proposal completed")
        if (
            stage == "generate"
            and view.max_candidates > 0
            and view.remaining_evaluations >= len(view.seed_tasks)
        ):
            return Decision(
                {"stage": "evaluate"},
                (Operation("generate", candidate="one-shot", parent=view.champion),),
                "Generate a single proposal from the champion",
            )
        candidate = next((c for c in view.candidates if c.id == "one-shot"), None)
        if stage == "evaluate" and candidate is not None:
            return Decision(
                {"stage": "nominate"},
                (
                    Operation(
                        "evaluate_seed", candidate=candidate.id, tasks=view.seed_tasks
                    ),
                ),
                "Measure the proposal on the complete seed set",
            )
        complete = [
            c for c in view.candidates if all(t in c.scores for t in view.seed_tasks)
        ]
        nominee = max(complete, key=lambda c: sum(c.scores[t] for t in view.seed_tasks))
        return Decision(
            {"stage": "done"},
            (Operation("nominate", candidate=nominee.id),),
            "Nominate the strongest complete seed result; runtime owns the final gate",
        )


def build_algorithm() -> OneShot:
    return OneShot()
