"""Gear's artifact check for Harbor's public, pre-verification job hook.

The pinned single-step separate-verifier lifecycle stops the agent and sidecars
before this hook. Checking a live agent's output would have a write/check race;
shared and multi-step lifecycles therefore cannot use this contract yet.
This is an artifact transfer check, not a general verifier isolation certificate.
"""

from __future__ import annotations

import os
import stat
from importlib.metadata import version
from pathlib import Path
from typing import Any

HARBOR_VERSION = "0.21.0"
MAX_ENTRIES = 100_000
MAX_BYTES = 512 * 1024 * 1024
MAX_DEPTH = 64


class UnsafeHarborArtifactError(ValueError):
    """Candidate output cannot safely cross into the private verifier."""


def validate_artifacts(root: Path) -> None:
    """Inspect metadata without opening file contents or following any links.

    Walk by directory descriptor so even an unexpected replacement of a child
    with a symlink cannot redirect the inspection outside the artifact tree.
    Errors contain neither candidate-controlled names nor private file contents.
    """
    entries = 0
    size = 0
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    def visit(fd: int, depth: int) -> None:
        nonlocal entries, size
        if depth > MAX_DEPTH:
            raise UnsafeHarborArtifactError("artifact-depth-limit")
        with os.scandir(fd) as children:
            for child in children:
                entries += 1
                if entries > MAX_ENTRIES:
                    raise UnsafeHarborArtifactError("artifact-entry-limit")
                info = os.stat(child.name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    raise UnsafeHarborArtifactError("artifact-symlink")
                if info.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
                    raise UnsafeHarborArtifactError("artifact-special-permissions")
                if stat.S_ISDIR(info.st_mode):
                    nested = os.open(child.name, flags, dir_fd=fd)
                    try:
                        actual = os.fstat(nested)
                        if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                            raise UnsafeHarborArtifactError("artifact-changed")
                        visit(nested, depth + 1)
                    finally:
                        os.close(nested)
                elif stat.S_ISREG(info.st_mode):
                    if info.st_nlink != 1:
                        raise UnsafeHarborArtifactError("artifact-hardlink")
                    size += info.st_size
                    if size > MAX_BYTES:
                        raise UnsafeHarborArtifactError("artifact-size-limit")
                else:
                    raise UnsafeHarborArtifactError("artifact-special-file")

    try:
        fd = os.open(root, flags)
        try:
            visit(fd, 0)
        finally:
            os.close(fd)
    except OSError:
        raise UnsafeHarborArtifactError("artifact-unreadable-or-changed") from None


class ArtifactSafetyPlugin:
    """Structural Harbor JobPlugin; importing the checker needs only stdlib."""

    async def on_job_start(self, job: Any) -> None:
        if version("harbor") != HARBOR_VERSION:
            raise ValueError("Gear artifact checking requires Harbor " + HARBOR_VERSION)
        job.on_trial_started(self.check_lifecycle)
        job.on_verification_started(self.check_artifacts)

    async def on_job_end(self, job_result: Any) -> None:
        pass

    async def check_lifecycle(self, event: Any) -> None:
        # Harbor's lock records None for multi-step tasks. The agent can still be
        # alive during intermediate verification, so a one-time scan is unsound.
        if event.lock.verifier.environment_mode != "separate":
            raise ValueError("Gear artifact checking requires single-step separate verification")
        if event.config.is_regrade:
            raise ValueError("Gear artifact checking has not certified regrade lifecycle")

    async def check_artifacts(self, event: Any) -> None:
        await self.check_lifecycle(event)
        trial = Path(event.config.trials_dir) / event.config.trial_name
        validate_artifacts(trial / "artifacts")
