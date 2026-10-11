"""Indexed randomness with explicit distributions and no mutable cursor."""

from __future__ import annotations

import builtins
import hashlib
import json
import math
from collections.abc import Mapping
from dataclasses import dataclass

from ..._protocol.canonical import digest
from .scope_types import ordered_ids


@dataclass(frozen=True)
class Selection:
    value: str
    probabilities: Mapping[str, builtins.float]
    index: int
    input_digest: str


@dataclass(frozen=True)
class RandomSource:
    seed: str
    tie_order: tuple[str, ...] | None = None

    def float(self, index: int) -> builtins.float:
        if type(index) is not int or not 0 <= index <= 2**53 - 1:
            raise ValueError("Random index must be a nonnegative safe integer")
        payload = json.dumps([self.seed, index], ensure_ascii=False, separators=(",", ":"))
        return int(hashlib.sha256(payload.encode()).hexdigest()[:13], 16) / 0x10000000000000

    def choice(self, probabilities: Mapping[str, builtins.float], *, index: int) -> Selection:
        if any(not math.isfinite(p) or p < 0 for p in probabilities.values()):
            raise ValueError("Invalid sampling probability")
        if not probabilities or not math.isclose(
            sum(probabilities.values()), 1, rel_tol=0, abs_tol=1e-9
        ):
            raise ValueError("Sampling probabilities must sum to one")
        order = ordered_ids(list(probabilities))
        if self.tie_order is not None:
            if len(set(self.tie_order)) != len(self.tie_order) or not set(probabilities) <= set(
                self.tie_order
            ):
                raise ValueError("Frozen sampling order must cover the distribution")
            ranks = {key: i for i, key in enumerate(self.tie_order)}
            order.sort(key=ranks.__getitem__)
        sample, total, selected = self.float(index), 0.0, ""
        for key in order:
            probability = probabilities[key]
            if probability > 0:
                selected = key
                total += probability
                if sample < total:
                    break
        distribution = {key: probabilities[key] for key in order}
        return Selection(selected, distribution, index, digest([self.seed, index, distribution]))
