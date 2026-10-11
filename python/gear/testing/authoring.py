"""Load a public author entrypoint for an explicit local offline check."""

from __future__ import annotations

import importlib
import inspect
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

from ..algorithms import GEPA, AlgorithmSource
from .conformance import check_algorithm


def check_entrypoint(
    entrypoint: str, *, source: str | Path = ".", kind: str = "auto"
) -> dict[str, Any]:
    AlgorithmSource(source, entrypoint)  # The same entrypoint syntax as the managed worker.
    if kind not in {"auto", "algorithm", "parent"}:
        raise ValueError("kind must be auto, algorithm or parent")
    previous = list(sys.path)
    try:
        sys.path.insert(0, str(Path(source).resolve()))
        with redirect_stdout(sys.stderr):
            module, name = entrypoint.split(":")
            value = getattr(importlib.import_module(module), name)
            if kind == "auto":
                try:
                    inspect.signature(value).bind()
                    kind = "algorithm"
                except TypeError:
                    kind = "parent"
            algorithm = GEPA(parent_policy=value) if kind == "parent" else value()
            if not callable(getattr(algorithm, "step", None)):
                raise TypeError("Factory must return a SearchAlgorithm with step(view, state)")
            result = check_algorithm(algorithm)
        return {**result, "entrypoint": entrypoint, "kind": kind}
    finally:
        sys.path[:] = previous
