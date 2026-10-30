"""RRSI selection equations plus the Gear evidence ranking adapter."""

from __future__ import annotations

from ..contracts import Evidence, RankingInput, RankingPlan
from ..evidence import complete_scope_mean

STRUCTURAL_COMPONENTS = frozenset({"client_tool", "skill", "memory", "subagent"})


def relative_cost(candidate: str, evidence: tuple[Evidence, ...]) -> float | None:
    values: list[float] = []
    for cell in evidence:
        if cell.candidate_id != candidate or not isinstance(cell.raw_metrics, dict):
            continue
        value = cell.raw_metrics.get("policy_tokens")
        if isinstance(value, (int, float)):
            values.append(float(value))
    return sum(values) / len(values) if values else None


def novelty(components: tuple[str, ...], incumbent_counts: dict[str, int]) -> int:
    return sum(
        component in STRUCTURAL_COMPONENTS and incumbent_counts.get(component, 0) == 0
        for component in set(components)
    )


def cost_rule(
    delta_score: float,
    delta_cost: float,
    novelty_value: int,
    *,
    noise_delta: float,
    beta0: float,
    beta1: float,
    score_weight: float,
    cost_weight: float,
    novelty_weight: float,
) -> bool:
    if delta_score > noise_delta:
        return delta_cost <= beta0 + beta1 * delta_score
    return (
        score_weight * delta_score
        - cost_weight * delta_cost
        + novelty_weight * novelty_value
        > 0
    )


def admissible(
    score: float,
    incumbent_score: float,
    score_star: float,
    delta_score: float,
    delta_cost: float,
    novelty_value: int,
    *,
    noise_delta: float,
    beta0: float,
    beta1: float,
    score_weight: float,
    cost_weight: float,
    novelty_weight: float,
) -> bool:
    return score >= score_star - delta_score and cost_rule(
        score - incumbent_score,
        delta_cost,
        novelty_value,
        noise_delta=noise_delta,
        beta0=beta0,
        beta1=beta1,
        score_weight=score_weight,
        cost_weight=cost_weight,
        novelty_weight=novelty_weight,
    )


def rank_candidates(view: RankingInput) -> RankingPlan:
    """Rank complete scopes; runtime admission remains independently trusted."""

    return complete_scope_mean(view)
