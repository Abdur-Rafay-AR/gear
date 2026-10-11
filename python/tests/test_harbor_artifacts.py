"""Offline metadata and public-hook contract; real Harbor is tested separately."""

import asyncio
import importlib.util
import os
import socket
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ASSET = Path(__file__).resolve().parents[2] / "assets/harbor-runtime/gear_harbor_artifacts.py"
SPEC = importlib.util.spec_from_file_location("gear_harbor_artifacts", ASSET)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class HarborArtifactTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()

    def rejected(self, reason):
        with self.assertRaisesRegex(guard.UnsafeHarborArtifactError, reason):
            guard.validate_artifacts(self.artifacts)

    def test_regular_binary_files_and_empty_directories_remain_unchanged(self):
        (self.artifacts / "nested").mkdir()
        (self.artifacts / "empty").mkdir()
        output = self.artifacts / "nested/output"
        output.write_bytes(bytes(range(256)))
        output.chmod(0o751)
        before = output.stat()
        guard.validate_artifacts(self.artifacts)
        self.assertEqual(output.stat(), before)
        self.assertEqual(output.read_bytes(), bytes(range(256)))

    def test_relative_absolute_directory_and_dangling_symlinks(self):
        answer = self.root / "PRIVATE-ANSWER"
        answer.write_text("owned private fixture")
        for target in ("../PRIVATE-ANSWER", str(answer), "/tests/private-answer", "."):
            with self.subTest(target=target):
                link = self.artifacts / "link"
                link.symlink_to(target)
                self.rejected("artifact-symlink")
                link.unlink()
        self.assertEqual(answer.read_text(), "owned private fixture")

    def test_symlink_as_artifact_root(self):
        self.artifacts.rmdir()
        self.artifacts.symlink_to(self.root, target_is_directory=True)
        self.rejected("artifact-unreadable-or-changed")

    def test_hardlinks_to_outside_or_inside_the_tree(self):
        source = self.root / "source"
        source.write_text("owned fixture")
        os.link(source, self.artifacts / "output")
        self.rejected("artifact-hardlink")

    def test_fifo_and_socket_never_open_or_block(self):
        pipe = self.artifacts / "pipe"
        os.mkfifo(pipe)
        self.rejected("artifact-special-file")
        pipe.unlink()
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(self.artifacts / "sock"))
            self.rejected("artifact-special-file")

    def test_privileged_modes(self):
        output = self.artifacts / "output"
        output.touch()
        for mode in (0o4755, 0o2755, 0o1755):
            with self.subTest(mode=mode):
                output.chmod(mode)
                self.rejected("artifact-special-permissions")

    def test_bounded_entries_bytes_and_depth(self):
        (self.artifacts / "file").write_bytes(b"ab")
        (self.artifacts / "sub").mkdir()
        (self.artifacts / "sub/deep").mkdir()
        for constant, value, reason in (
            ("MAX_ENTRIES", 1, "artifact-entry-limit"),
            ("MAX_BYTES", 1, "artifact-size-limit"),
            ("MAX_DEPTH", 1, "artifact-depth-limit"),
        ):
            with self.subTest(constant=constant), patch.object(guard, constant, value):
                self.rejected(reason)

    def test_metadata_errors_do_not_expose_names_or_contents(self):
        with patch.object(guard.os, "stat", side_effect=PermissionError("PRIVATE-CONTENT")):
            (self.artifacts / "PRIVATE-FILENAME").touch()
            self.rejected("^artifact-unreadable-or-changed$")

    def test_replaced_directory_cannot_redirect_scan(self):
        directory = self.artifacts / "sub"
        directory.mkdir()
        open_original = os.open

        def replace(path, flags, **kwargs):
            if path == "sub":
                directory.rmdir()
                directory.symlink_to(self.root, target_is_directory=True)
            return open_original(path, flags, **kwargs)

        with patch.object(guard.os, "open", side_effect=replace):
            self.rejected("artifact-unreadable-or-changed")

    def test_hook_registers_on_pinned_version_and_fails_before_grading(self):
        hooks = {}
        job = SimpleNamespace(
            on_trial_started=lambda hook: hooks.update(start=hook),
            on_verification_started=lambda hook: hooks.update(verify=hook),
        )
        plugin = guard.ArtifactSafetyPlugin()
        with patch.object(guard, "version", return_value="0.21.0"):
            asyncio.run(plugin.on_job_start(job))
        event = SimpleNamespace(
            config=SimpleNamespace(
                trials_dir=self.root.parent, trial_name=self.root.name, is_regrade=False
            ),
            lock=SimpleNamespace(verifier=SimpleNamespace(environment_mode="separate")),
        )
        asyncio.run(hooks["start"](event))
        asyncio.run(hooks["verify"](event))
        (self.artifacts / "private").symlink_to("/tests/private-answer")
        with self.assertRaisesRegex(guard.UnsafeHarborArtifactError, "artifact-symlink"):
            asyncio.run(hooks["verify"](event))
        for mode in (None, "shared"):
            event.lock.verifier.environment_mode = mode
            with self.assertRaisesRegex(ValueError, "single-step separate"):
                asyncio.run(hooks["start"](event))
        event.lock.verifier.environment_mode = "separate"
        event.config.is_regrade = True
        with self.assertRaisesRegex(ValueError, "regrade"):
            asyncio.run(hooks["start"](event))
        with (
            patch.object(guard, "version", return_value="0.22.0"),
            self.assertRaisesRegex(ValueError, "Harbor 0.21.0"),
        ):
            asyncio.run(plugin.on_job_start(job))


if __name__ == "__main__":
    unittest.main()
