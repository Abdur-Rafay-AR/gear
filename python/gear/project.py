"""Project operations share the Node application service and durable state."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from contextlib import suppress
from pathlib import Path
from typing import Any

from .algorithms.contracts import SearchAlgorithm
from .algorithms.source import AlgorithmSource, freeze_algorithm


class GearError(RuntimeError):
    def __init__(self, details: dict[str, Any]):
        super().__init__(details.get("message", "Gear operation failed"))
        self.details = details


class Project:
    def __init__(self, path: str | Path = ".", *, command: tuple[str, ...] | None = None):
        self.path = Path(path).resolve()
        self.command = command or (os.environ.get("GEAR_EXECUTABLE", "gear"),)

    @classmethod
    def open(cls, path: str | Path = ".", *, command: tuple[str, ...] | None = None) -> Project:
        return cls(path, command=command)

    @staticmethod
    def _response(returncode: int, stdout: str, stderr: str) -> dict[str, Any]:
        try:
            response = json.loads(stdout if returncode == 0 else stderr)
        except ValueError as error:
            raise GearError(
                {
                    "code": "runtime-unavailable",
                    "message": stderr.strip(),
                    "next_action": "Install the matching rsi-gear npm runtime.",
                }
            ) from error
        if not isinstance(response, dict):
            raise GearError(
                {"code": "invalid-response", "message": "Gear returned a non-object result"}
            )
        if returncode:
            raise GearError(response)
        return response

    def _request(self, *arguments: str) -> dict[str, Any]:
        try:
            result = subprocess.run(
                [*self.command, *arguments, "--json"],
                cwd=self.path,
                text=True,
                capture_output=True,
                check=False,
            )
        except OSError as error:
            raise GearError(
                {
                    "code": "runtime-unavailable",
                    "message": str(error),
                    "next_action": "Install the matching rsi-gear npm runtime.",
                }
            ) from error
        return self._response(result.returncode, result.stdout, result.stderr)

    async def _arequest(self, *arguments: str) -> dict[str, Any]:
        try:
            process = await asyncio.create_subprocess_exec(
                *self.command,
                *arguments,
                "--json",
                cwd=self.path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            raise GearError({"code": "runtime-unavailable", "message": str(error)}) from error
        try:
            stdout, stderr = await process.communicate()
        except asyncio.CancelledError:
            # Stop waiting locally. Durable provider reservations remain for
            # explicit resume/cancel; never treat a lost client as a trial retry.
            if process.returncode is None:
                with suppress(ProcessLookupError):
                    process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    with suppress(ProcessLookupError):
                        process.kill()
                    await process.wait()
            raise
        return self._response(process.returncode or 0, stdout.decode(), stderr.decode())

    def _refine_args(
        self, rounds: int, algorithm: SearchAlgorithm | AlgorithmSource | None
    ) -> tuple[str, ...]:
        if type(rounds) is not int or rounds < 1:
            raise ValueError("rounds must be a positive integer")
        arguments: tuple[str, ...] = ("refine", "--rounds", str(rounds))
        if algorithm is not None:
            frozen = freeze_algorithm(algorithm, self.path / ".gear" / "algorithm-sources")
            arguments += (
                "--algorithm-source",
                str(frozen.source),
                "--algorithm-entrypoint",
                frozen.entrypoint,
            )
        return arguments

    def check(self) -> dict[str, Any]:
        return self._request("benchmark", "check")

    def evaluate(self, *, split: str = "seed", limit: int | None = None) -> dict[str, Any]:
        args = ("--limit", str(limit)) if limit is not None else ()
        return self._request("evaluate", "--split", split, *args)

    def refine(
        self, *, rounds: int = 1, algorithm: SearchAlgorithm | AlgorithmSource | None = None
    ) -> dict[str, Any]:
        return self._request(*self._refine_args(rounds, algorithm))

    async def arefine(
        self, *, rounds: int = 1, algorithm: SearchAlgorithm | AlgorithmSource | None = None
    ) -> dict[str, Any]:
        arguments = await asyncio.to_thread(self._refine_args, rounds, algorithm)
        return await self._arequest(*arguments)

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

    async def acheck(self) -> dict[str, Any]:
        return await self._arequest("benchmark", "check")

    async def aevaluate(self, *, split: str = "seed", limit: int | None = None) -> dict[str, Any]:
        args = ("--limit", str(limit)) if limit is not None else ()
        return await self._arequest("evaluate", "--split", split, *args)

    async def areport(self, run_id: str | None = None) -> dict[str, Any]:
        return await self._arequest("report", *((run_id,) if run_id else ()))

    async def aresume(self, run_id: str) -> dict[str, Any]:
        return await self._arequest("resume", run_id)

    async def acancel(self, run_id: str) -> dict[str, Any]:
        return await self._arequest("cancel", run_id)

    async def acompile(self) -> dict[str, Any]:
        return await self._arequest("benchmark", "compile")

    async def aexport(self, run_id: str) -> dict[str, Any]:
        return await self._arequest("export", run_id)

    async def aconfig(self) -> dict[str, Any]:
        return await self._arequest("config", "explain")
