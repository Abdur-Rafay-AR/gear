"""Mandatory artifact plugin entry for a sealed Gear Harbor runtime.

Use the Harbor CLI and its public plugin interface; do not replace its executor,
resolver, scheduler or grading implementation. PYTHONPATH remains available for
Hitch's versioned agent bridge. The Gear plugin is loaded from this exact bundle.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import platform
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path


def installation() -> dict[str, str]:
    if sys.version_info < (3, 12):
        raise ValueError("Guarded Harbor requires Python >=3.12")
    if version("harbor") != "0.21.0":
        raise ValueError("Guarded Harbor requires harbor==0.21.0")
    import harbor

    root = Path(harbor.__file__).parent
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if "__pycache__" in relative.parts or path.suffix in (".pyc", ".pyo"):
            continue
        if path.is_symlink():
            raise ValueError("Guarded Harbor requires ordinary installed package files")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError("Guarded Harbor package contains a special file")
        name = relative.as_posix().encode()
        data = path.read_bytes()
        digest.update(len(name).to_bytes(8, "big") + name)
        digest.update(len(data).to_bytes(8, "big") + data)
    return {
        "harborVersion": version("harbor"),
        "harborSource": "sha256:" + digest.hexdigest(),
        "pythonVersion": platform.python_version(),
        "pythonBinary": "sha256:" + hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
        "platform": sys.platform,
        "architecture": platform.machine(),
    }


def guarded_arguments(args: list[str]) -> list[str]:
    if args == ["--version"]:
        return args
    if not args or args[0] != "run":
        raise ValueError("Guarded Harbor supports only run and --version")
    if "--" in args or any(arg.split("=", 1)[0].startswith("--plugin") for arg in args):
        raise ValueError("Guarded Harbor owns the job plugin configuration")
    return [*args, "--plugin", "gear_harbor_artifacts:ArtifactSafetyPlugin"]


def _main() -> None:
    args = sys.argv[1:]
    if args == ["--gear-runtime-inspect"]:
        print(json.dumps(installation(), sort_keys=True))
        return
    if len(args) < 4 or args[0] != "--gear-runtime" or args[2] != "--":
        raise ValueError("Guarded Harbor requires a sealed runtime binding")
    expected = json.loads(args[1])
    if expected != installation():
        raise ValueError("guarded-harbor-installation-mismatch")
    forwarded = guarded_arguments(args[3:])
    path = Path(__file__).with_name("gear_harbor_artifacts.py")
    spec = importlib.util.spec_from_file_location("gear_harbor_artifacts", path)
    if spec is None or spec.loader is None:
        raise ValueError("guarded-harbor-plugin-unavailable")
    plugin = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = plugin
    spec.loader.exec_module(plugin)
    from harbor.cli.main import app

    # No extra process or CLI reimplementation: Harbor owns its original signals.
    sys.argv = ["harbor", *forwarded]
    app()


def main() -> None:
    # Execute the source bytes whose hash is checked below, not a pre-existing
    # bytecode cache. Keep the fresh cache empty and private for this invocation.
    previous_write = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix="gear-harbor-bytecode-") as cache:
        previous = sys.pycache_prefix
        sys.pycache_prefix = cache
        try:
            _main()
        finally:
            sys.pycache_prefix = previous
            sys.dont_write_bytecode = previous_write


if __name__ == "__main__":
    main()
