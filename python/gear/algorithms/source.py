"""Freeze an author algorithm as ordinary Python source, never a pickle.

Only explicitly referenced local Python modules and their local imports are
copied. Runtime, credentials, project data and installed dependencies remain
outside this source bundle; the managed worker owns their admission rules.
"""

from __future__ import annotations

import ast
import errno
import hashlib
import inspect
import json
import math
import os
import re
import sys
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, fields, is_dataclass
from pathlib import Path
from typing import Any

from .contracts import SearchAlgorithm

_ENTRYPOINT = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*\Z", re.ASCII)
_QUALIFIED = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\Z", re.ASCII)
_MAX_BYTES = 1024 * 1024


@dataclass(frozen=True)
class AlgorithmSource:
    """An explicit source directory and zero-argument module:factory entrypoint."""

    source: str | Path
    entrypoint: str

    def __post_init__(self) -> None:
        if not _ENTRYPOINT.fullmatch(self.entrypoint):
            raise ValueError("Algorithm entrypoint must be module:factory")


class _Bundle:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.imports: dict[str, str] = {}

    def add(self, name: str, path: Path) -> None:
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Algorithm source must be a regular Python file: {path}")
        if path.stat().st_size > _MAX_BYTES:
            raise ValueError("Algorithm source exceeds 1 MiB")
        self.put(name, path.read_bytes())

    def put(self, name: str, content: bytes) -> None:
        content.decode("utf-8")
        if name.split("/")[0].removesuffix(".py") in {"gear", "gear_training"}:
            raise ValueError("Algorithm source cannot shadow Gear namespaces")
        previous = self.files.get(name)
        if previous is not None and previous != content:
            raise ValueError(f"Conflicting algorithm module: {name}")
        self.files[name] = content
        if len(self.files) > 256 or sum(map(len, self.files.values())) > _MAX_BYTES:
            raise ValueError("Algorithm source exceeds 256 files or 1 MiB")

    def local_module(self, root: Path, module: str, visited: set[str]) -> None:
        if module in visited or not _QUALIFIED.fullmatch(module):
            return
        visited.add(module)
        relative = module.replace(".", "/")
        file = root / f"{relative}.py"
        package = False
        if not file.is_file():
            file = root / relative / "__init__.py"
            package = True
        if not file.is_file():
            return  # An installed dependency, admitted by the worker environment.
        parents = [
            root.joinpath(*file.relative_to(root).parts[:i])
            for i in range(len(file.relative_to(root).parts))
        ]
        if any(parent.is_symlink() for parent in parents):
            raise ValueError("Algorithm source cannot traverse symlink directories")
        name = file.relative_to(root).as_posix()
        self.add(name, file)
        parts = module.split(".")
        for i in range(1, len(parts)):
            self.local_module(root, ".".join(parts[:i]), visited)
        tree = ast.parse(self.files[name], filename=str(file))
        context = module if package else module.rpartition(".")[0]
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.local_module(root, alias.name, visited)
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    segments = context.split(".") if context else []
                    if node.level > len(segments):
                        raise ValueError("Relative import escapes the algorithm package")
                    base = ".".join(
                        segments[: len(segments) - node.level + 1] + ([base] if base else [])
                    )
                if base:
                    self.local_module(root, base, visited)
                    for alias in node.names:
                        self.local_module(root, f"{base}.{alias.name}", visited)

    def reference(self, value: Any) -> str:
        module_name = getattr(value, "__module__", None)
        qualified = getattr(value, "__qualname__", None)
        if (
            not isinstance(module_name, str)
            or not isinstance(qualified, str)
            or not _QUALIFIED.fullmatch(qualified)
        ):
            raise ValueError(
                "Use an importable top-level function/class or AlgorithmSource; closures and lambdas cannot be frozen"
            )
        if (
            not module_name.startswith("gear.")
            and module_name != "gear"
            and module_name.split(".")[0] not in sys.stdlib_module_names
        ):
            module = sys.modules.get(module_name)
            filename = getattr(module, "__file__", None)
            if not filename or not str(filename).endswith(".py"):
                raise ValueError(
                    "Algorithm objects require a Python source file; use AlgorithmSource for custom factories"
                )
            file = Path(filename).absolute()
            if module_name == "__main__":
                module_name = "_gear_author_main"
                self.add(f"{module_name}.py", file)
                # Preserve local imports without copying unrelated project files.
                for node in ast.walk(ast.parse(file.read_bytes())):
                    if isinstance(node, ast.Import):
                        for alias in node.names:
                            self.local_module(file.parent, alias.name, set())
                    elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
                        self.local_module(file.parent, node.module, set())
                        for alias in node.names:
                            self.local_module(file.parent, f"{node.module}.{alias.name}", set())
            else:
                root = file.parent
                for _ in range(
                    len(module_name.split(".")) - (0 if file.name == "__init__.py" else 1)
                ):
                    root = root.parent
                self.local_module(root, module_name, set())
        import_alias = self.imports.setdefault(module_name, f"_module_{len(self.imports)}")
        return f"{import_alias}.{qualified}"

    def expression(self, value: Any) -> str:
        if value is None or type(value) in (bool, int, str):
            return repr(value)
        if type(value) is float:
            if not math.isfinite(value):
                raise ValueError("Algorithm configuration must contain finite numbers")
            return repr(value)
        if isinstance(value, Mapping):
            if any(not isinstance(key, str) for key in value):
                raise ValueError("Algorithm configuration keys must be strings")
            return (
                "{"
                + ",".join(f"{key!r}:{self.expression(value[key])}" for key in sorted(value))
                + "}"
            )
        if isinstance(value, (list, tuple)):
            content = ",".join(self.expression(item) for item in value)
            return f"[{content}]" if isinstance(value, list) else f"({content},)" if value else "()"
        if inspect.isfunction(value) or inspect.isclass(value):
            return self.reference(value)
        constructor = self.reference(type(value))
        if is_dataclass(value):
            if any(not f.init for f in fields(value)):
                raise ValueError("Use AlgorithmSource for dataclasses with non-constructor state")
            arguments = ",".join(
                f"{f.name}={self.expression(getattr(value, f.name))}"
                for f in fields(value)
                if f.init
            )
            return f"{constructor}({arguments})"
        if getattr(value, "__dict__", None) == {}:
            try:
                inspect.signature(type(value)).bind()
            except TypeError as error:
                raise ValueError(
                    "Use AlgorithmSource for algorithms with custom construction"
                ) from error
            return f"{constructor}()"
        raise ValueError(
            "Use a dataclass configuration or AlgorithmSource for custom algorithm state"
        )


def _directory_files(root: Path) -> dict[str, bytes]:
    bundle = _Bundle()
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Algorithm source must be a directory")
    for directory, names, files in os.walk(root, followlinks=False):
        names[:] = sorted(name for name in names if name != "__pycache__")
        if any((Path(directory) / name).is_symlink() for name in names):
            raise ValueError("Algorithm source cannot contain symlink directories")
        for name in sorted(files):
            if name.endswith(".py"):
                path = Path(directory) / name
                bundle.add(path.relative_to(root).as_posix(), path)
    if not bundle.files:
        raise ValueError("Algorithm source contains no Python files")
    return bundle.files


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def freeze_algorithm(
    algorithm: SearchAlgorithm | AlgorithmSource, destination: Path
) -> AlgorithmSource:
    """Publish immutable source for a new run; never mutate project configuration."""
    if isinstance(algorithm, AlgorithmSource):
        files = _directory_files(Path(algorithm.source).absolute())
        entrypoint = algorithm.entrypoint
    else:
        bundle = _Bundle()
        expression = bundle.expression(algorithm)
        imports = "\n".join(
            f"import {module} as {alias}" for module, alias in bundle.imports.items()
        )
        bundle.put(
            "_gear_factory.py",
            f"{imports}\n\ndef build_algorithm():\n    return {expression}\n".encode(),
        )
        files = bundle.files
        entrypoint = "_gear_factory:build_algorithm"
    identity = hashlib.sha256(
        json.dumps(
            [
                entrypoint,
                [(name, hashlib.sha256(data).hexdigest()) for name, data in sorted(files.items())],
            ],
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = destination / identity
    if target.exists():
        if _directory_files(target) != files:
            raise ValueError("Frozen algorithm source changed; do not overwrite an admitted source")
        return AlgorithmSource(target, entrypoint)
    with tempfile.TemporaryDirectory(prefix=".staging-", dir=destination) as directory:
        staging = Path(directory) / "source"
        staging.mkdir(mode=0o700)
        for name, data in files.items():
            path = staging / name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with path.open("xb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        for directory_path, _, _ in os.walk(staging, topdown=False):
            _sync_directory(Path(directory_path))
        try:
            staging.rename(target)
        except OSError as error:
            if (
                error.errno not in (errno.EEXIST, errno.ENOTEMPTY)
                or _directory_files(target) != files
            ):
                raise
        _sync_directory(destination)
    return AlgorithmSource(target, entrypoint)
