"""CPU-only algorithm conformance and toy execution; no project data or models."""

from dataclasses import replace

from ..algorithms import Candidate, SearchAlgorithm, SearchView


def toy_round(algorithm: SearchAlgorithm, *, max_steps: int = 100) -> dict:
    view = SearchView(
        ("sum", "case"),
        (Candidate("initial", {"sum": 0.0, "case": 1.0}),),
        "initial",
        1,
        20,
        "toy-seed",
    )
    state, decisions, nominee = {}, [], None
    for _ in range(max_steps):
        decision = algorithm.step(view, state)
        if not decision.reason or not decision.operations:
            raise ValueError("Decisions need a reason and at least one operation")
        decisions.append(decision)
        state = dict(decision.state)
        for operation in decision.operations:
            if not set(operation.tasks) <= set(view.seed_tasks):
                raise ValueError("Algorithm requested tasks outside seed")
            if operation.kind == "generate":
                if operation.parent not in {c.id for c in view.candidates}:
                    raise ValueError("Unknown parent")
                view = replace(
                    view, candidates=(*view.candidates, Candidate(operation.candidate, {}))
                )
            elif operation.kind == "evaluate_seed":
                if operation.candidate not in {c.id for c in view.candidates}:
                    raise ValueError("Unknown candidate")
                view = replace(
                    view,
                    candidates=tuple(
                        Candidate(c.id, {**c.scores, **{task: 1.0 for task in operation.tasks}})
                        if c.id == operation.candidate
                        else c
                        for c in view.candidates
                    ),
                    remaining_evaluations=view.remaining_evaluations - len(operation.tasks),
                )
            elif operation.kind == "nominate":
                nominee = operation.candidate
            elif operation.kind == "stop":
                return {"nominee": nominee, "steps": len(decisions), "decisions": decisions}
    raise ValueError("Algorithm exceeded the toy step limit")
