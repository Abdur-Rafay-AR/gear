"""Project operations share the Node application service and durable state."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


class GearError(RuntimeError):
    def __init__(self, details: dict[str, Any]):
        super().__init__(details.get("message", "Gear operation failed"))
        self.details = details


class Project:
    def __init__(self, path: str | Path = ".", *, command: tuple[str, ...] | None = None):
        self.path = Path(path).resolve()
        self.command = command or (os.environ.get("GEAR_EXECUTABLE", "gear"),)

    def _request(self, *arguments: str) -> dict[str, Any]:
        result = subprocess.run(
            [*self.command, *arguments, "--json"],
            cwd=self.path,
            text=True,
            capture_output=True,
            check=False,
        )
        try:
            response = json.loads(result.stdout if result.returncode == 0 else result.stderr)
        except ValueError as error:
            raise GearError(
                {
                    "code": "runtime-unavailable",
                    "message": result.stderr.strip(),
                    "next_action": "Install the matching rsi-gear npm runtime.",
                }
            ) from error
        if result.returncode:
            raise GearError(response)
        if not isinstance(response, dict):
            raise GearError(
                {"code": "invalid-response", "message": "Gear returned a non-object result"}
            )
        return response

    def check(self) -> dict[str, Any]:
        return self._request("benchmark", "check")

    def evaluate(self, *, split: str = "seed", limit: int | None = None) -> dict[str, Any]:
        args = ("--limit", str(limit)) if limit is not None else ()
        return self._request("evaluate", "--split", split, *args)

    def refine(self, *, rounds: int = 1) -> dict[str, Any]:
        return self._request("refine", "--rounds", str(rounds))

    def report(self, run_id: str | None = None) -> dict[str, Any]:
        return self._request("report", *((run_id,) if run_id else ()))

    def resume(self, run_id: str) -> dict[str, Any]:
        return self._request("resume", run_id)

    def cancel(self, run_id: str) -> dict[str, Any]:
        return self._request("cancel", run_id)

    def compile(self) -> dict[str, Any]:
        return self._request("benchmark", "compile")

    def export(self, run_id: str) -> dict[str, Any]:
        return self._request("export", run_id)

    def config(self) -> dict[str, Any]:
        return self._request("config", "explain")
