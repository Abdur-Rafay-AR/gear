"""Seed-only archive planning over already verified profiles, without a journal.

The runtime owns snapshot identities, cell certification and evidence revisions.
This module selects usable scopes and probability mass from their projections;
it neither imports historical state nor invents or stores raw observations.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace

from ..._protocol.canonical import digest
from .frontier import FrontierCandidate, ScopeFrontier, scope_frontier
from .scope_types import ordered_ids


def must_pass_guard_identity(task_ids: tuple[str, ...]) -> str:
    """New-run identity for seed pass-rate guards; never a legacy guard digest."""
    return digest(["must-pass", ordered_ids(task_ids)]) if task_ids else ""


@dataclass(frozen=True)
class ArchiveMember:
    id: str
    identity: str
    content_identity: str


@dataclass(frozen=True)
class ArchiveScope:
    id: str
    family: str
    epoch: int
    task_ids: tuple[str, ...]
    weights: Mapping[str, float]
    guard_identity: str = ""

    @property
    def equivalence(self) -> str:
        # Family and epoch labels must not amplify an identical search scope.
        return digest([ordered_ids(list(self.task_ids)), self.weights, self.guard_identity])


@dataclass(frozen=True)
class ScopedProfile:
    scope_id: str
    candidate: FrontierCandidate


@dataclass(frozen=True)
class ArchiveChampion:
    candidate_id: str
    identity: str
    scope_id: str


@dataclass(frozen=True)
class ResearchArchive:
    scopes: tuple[ArchiveScope, ...]
    identities: Mapping[str, str]
    views: Mapping[str, ScopeFrontier]
    scope_probabilities: Mapping[str, float]
    parent_probabilities: Mapping[str, float]
    active_parent_ids: tuple[str, ...]
    champion: ArchiveChampion | None


def _order(values: tuple[str, ...], frozen: tuple[str, ...] | None) -> dict[str, int]:
    order = tuple(ordered_ids(list(values))) if frozen is None else frozen
    if len(order) != len(values) or set(order) != set(values):
        raise ValueError("Frozen order must include each input ID exactly once")
    return {value: index for index, value in enumerate(order)}


def _profiles(
    scope: ArchiveScope,
    aliases: set[str],
    observations: tuple[ScopedProfile, ...],
    objective: bool,
) -> tuple[FrontierCandidate, ...]:
    chosen: dict[str, FrontierCandidate] = {}
    rejected: dict[str, FrontierCandidate] = {}
    pending: dict[str, FrontierCandidate] = {}
    for record in observations:
        if record.scope_id not in aliases:
            continue
        candidate = record.candidate
        complete = candidate.aggregate_key is not None and set(candidate.score_keys) == set(
            scope.task_ids
        )
        if not complete:
            pending[candidate.id] = candidate
        elif not candidate.guard_passed:
            rejected[candidate.id] = candidate
        else:
            previous = chosen.get(candidate.id)
            if previous is not None and (
                previous.score_keys != candidate.score_keys
                or previous.aggregate_key != candidate.aggregate_key
                or any(
                    previous.process_keys[k] != candidate.process_keys[k]
                    for k in previous.process_keys.keys() & candidate.process_keys.keys()
                )
            ):
                raise ValueError(
                    "Conflicting certified scope profiles; resolve evidence in the runtime"
                )
            selected = (
                candidate
                if previous is None
                or (not objective and not previous.process_complete and candidate.process_complete)
                else previous
            )
            chosen[candidate.id] = replace(
                selected,
                observed_at=min(previous.observed_at, candidate.observed_at)
                if previous
                else candidate.observed_at,
            )
    return tuple({**pending, **rejected, **chosen}.values())


def build_research_archive(
    seed_tasks: tuple[str, ...],
    members: tuple[ArchiveMember, ...],
    scopes: tuple[ArchiveScope, ...],
    observations: tuple[ScopedProfile, ...],
    champion: str,
    *,
    process_fraction: float = 0.25,
    objective: bool = False,
    partition: str = "seed",
    family_order: tuple[str, ...] | None = None,
    candidate_order: tuple[str, ...] | None = None,
    scope_order: tuple[str, ...] | None = None,
) -> ResearchArchive:
    """Project eligible epochs, de-duplicate equivalent scopes, and mix frontiers.

    Supply the latest runtime-verified profile revisions. Explicit ordering can
    freeze a historical locale; new runs default to portable UTF-16 ordering.
    A missing newer scope does not retire an older usable epoch.
    """
    if partition != "seed" or not seed_tasks or len(set(seed_tasks)) != len(seed_tasks):
        raise ValueError("Archive requires a unique nonempty seed-only task set")
    identities = {member.id: member.identity for member in members}
    contents = {member.id: member.content_identity for member in members}
    if len(identities) != len(members) or any(
        not m.id or not m.identity or not m.content_identity for m in members
    ):
        raise ValueError("Archive requires immutable candidate identities")
    by_scope = {scope.id: scope for scope in scopes}
    if len(by_scope) != len(scopes):
        raise ValueError("Duplicate archive scope ID")
    epochs: set[tuple[str, int]] = set()
    equivalents: dict[str, set[str]] = {}
    for scope in scopes:
        if not scope.id or not scope.family or type(scope.epoch) is not int or scope.epoch < 0:
            raise ValueError("Invalid archive scope identity or epoch")
        if (scope.family, scope.epoch) in epochs:
            raise ValueError("Scope epoch manifest changed")
        epochs.add((scope.family, scope.epoch))
        if not set(scope.task_ids) <= set(seed_tasks):
            raise ValueError("Archive scope contains a task outside seed")
        equivalents.setdefault(scope.equivalence, set()).add(scope.id)
    for record in observations:
        if record.scope_id not in by_scope:
            raise ValueError("Profile has no admitted scope")
        if contents.get(record.candidate.id) != record.candidate.identity:
            raise ValueError("Candidate identity changed or is not admitted")
        if not set(record.candidate.score_keys) <= set(by_scope[record.scope_id].task_ids):
            raise ValueError("Profile contains evidence outside its scope")
    candidate_ranks = _order(tuple(identities), candidate_order)
    scope_ranks = _order(tuple(by_scope), scope_order)
    family_ranks = _order(tuple(dict.fromkeys(scope.family for scope in scopes)), family_order)
    views = {}
    for scope in scopes:
        profiles = _profiles(scope, equivalents[scope.equivalence], observations, objective)
        views[scope.id] = scope_frontier(
            scope.task_ids,
            scope.weights,
            profiles,
            champion,
            process_fraction=process_fraction,
            objective=objective,
            tie_order=tuple(sorted((p.id for p in profiles), key=candidate_ranks.__getitem__)),
        )
    latest: dict[str, ArchiveScope] = {}
    used: set[str] = set()
    for scope in sorted(scopes, key=lambda s: (-s.epoch, family_ranks[s.family])):
        if (
            scope.family in latest
            or scope.equivalence in used
            or not views[scope.id].parent_probabilities
        ):
            continue
        latest[scope.family] = scope
        used.add(scope.equivalence)
    if len(latest) > 1:
        latest.pop("bootstrap", None)
    scope_probabilities = {scope.id: 1 / len(latest) for scope in latest.values()}
    parent_probabilities: dict[str, float] = {}
    for scope in latest.values():
        for candidate, probability in views[scope.id].parent_probabilities.items():
            parent_probabilities[candidate] = parent_probabilities.get(
                candidate, 0
            ) + probability / len(latest)
    eligible_champion_scopes = [s for s in scopes if champion in views[s.id].representatives]
    champion_scope = min(
        eligible_champion_scopes,
        key=lambda s: (-len(s.task_ids), -s.epoch, scope_ranks[s.id]),
        default=None,
    )
    return ResearchArchive(
        scopes,
        dict(identities),
        views,
        scope_probabilities,
        parent_probabilities,
        tuple(ordered_ids(list(parent_probabilities))),
        ArchiveChampion(champion, identities[champion], champion_scope.id)
        if champion_scope is not None
        else None,
    )
