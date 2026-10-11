import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gear import GearError, Project
from gear.algorithms import GEPA, AlgorithmSource, Decision, Operation, StagedGEPA
from gear.algorithms.source import freeze_algorithm
from gear.testing import check_algorithm


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "sealed"

    def module(self, text):
        path = self.root / "author_policy.py"
        path.write_text(text)
        spec = importlib.util.spec_from_file_location("author_policy", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules["author_policy"] = module
        self.addCleanup(lambda: sys.modules.pop("author_policy", None))
        spec.loader.exec_module(module)
        return module

    def run_frozen(self, frozen):
        return json.loads(
            subprocess.check_output(
                [
                    sys.executable,
                    "-m",
                    "gear",
                    "algorithm",
                    "test",
                    frozen.entrypoint,
                    "--source",
                    str(frozen.source),
                ],
                text=True,
                env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
                cwd=self.root,
            )
        )

    def test_function_override_freezes_source_and_local_dependencies_only(self):
        (self.root / "helper.py").write_text("def choose(view):\n    return view.champion\n")
        (self.root / "private.json").write_text("must-not-be-bundled")
        module = self.module(
            "def choose_parent(view):\n    from helper import choose\n    return choose(view)\n"
        )
        frozen = freeze_algorithm(GEPA(parent_policy=module.choose_parent), self.output)
        files = {
            p.relative_to(frozen.source).as_posix()
            for p in Path(frozen.source).rglob("*")
            if p.is_file()
        }
        self.assertEqual(files, {"_gear_factory.py", "author_policy.py", "helper.py"})
        self.assertTrue(self.run_frozen(frozen)["ok"])
        self.assertEqual(
            freeze_algorithm(GEPA(parent_policy=module.choose_parent), self.output), frozen
        )

    def test_source_changes_create_a_new_bundle_without_overwriting_old(self):
        module = self.module("def choose_parent(view):\n    return view.champion\n")
        first = freeze_algorithm(GEPA(parent_policy=module.choose_parent), self.output)
        (self.root / "author_policy.py").write_text(
            "def choose_parent(view):\n    return view.candidates[0].id\n"
        )
        second = freeze_algorithm(GEPA(parent_policy=module.choose_parent), self.output)
        self.assertNotEqual(first.source, second.source)
        self.assertIn("view.champion", (Path(first.source) / "author_policy.py").read_text())
        self.assertTrue(self.run_frozen(first)["ok"])
        self.assertTrue(self.run_frozen(second)["ok"])

    def test_tampered_bundle_is_rejected_instead_of_repaired_in_place(self):
        frozen = freeze_algorithm(GEPA(), self.output)
        (Path(frozen.source) / "_gear_factory.py").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "Frozen algorithm source changed"):
            freeze_algorithm(GEPA(), self.output)

    def test_nested_dataclass_recipe_is_plain_python(self):
        from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit

        frozen = freeze_algorithm(
            StagedGEPA(scope_config=ScopeConfig(bridge=TaskSetLimit(1))), self.output
        )
        result = self.run_frozen(frozen)
        self.assertTrue(result["ok"])
        self.assertEqual(result["nominee"], "candidate-1")
        self.assertNotIn("pickle", (Path(frozen.source) / "_gear_factory.py").read_text())

    def test_explicit_factory_supports_arbitrary_search_algorithm(self):
        source = self.root / "explicit"
        source.mkdir()
        (source / "policy.py").write_text(
            "from gear.algorithms import Decision,Operation\nclass Baseline:\n    def step(self,view,state):\n        return Decision({'done':True},(Operation('stop') if state else Operation('nominate',candidate=view.champion),),'Keep baseline')\ndef build():\n    return Baseline()\n"
        )
        frozen = freeze_algorithm(AlgorithmSource(source, "policy:build"), self.output)
        self.assertEqual(self.run_frozen(frozen)["nominee"], "initial")

    def test_relative_package_imports_remain_importable(self):
        source = self.root / "source"
        package = source / "author_package"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("")
        (package / "helpers.py").write_text("def choose(view):\n    return view.champion\n")
        (package / "policy.py").write_text(
            "from .helpers import choose\ndef parent(view):\n    return choose(view)\n"
        )
        sys.path.insert(0, str(source))
        self.addCleanup(lambda: sys.path.remove(str(source)))
        import importlib

        module = importlib.import_module("author_package.policy")
        self.addCleanup(
            lambda: [
                sys.modules.pop(k, None)
                for k in ["author_package", "author_package.policy", "author_package.helpers"]
            ]
        )
        frozen = freeze_algorithm(GEPA(parent_policy=module.parent), self.output)
        self.assertTrue(self.run_frozen(frozen)["ok"])

    def test_closures_shadow_namespaces_and_symlinks_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "closures and lambdas"):
            freeze_algorithm(GEPA(parent_policy=lambda view: view.champion), self.output)
        module = self.module(
            "from dataclasses import dataclass, field\n@dataclass\nclass Policy:\n"
            "    choice: str = field(init=False, default='initial')\n"
            "    def __call__(self, view): return self.choice\n"
        )
        parent = module.Policy()
        parent.choice = "modified-state-must-not-be-discarded"
        with self.assertRaisesRegex(ValueError, "non-constructor state"):
            freeze_algorithm(GEPA(parent_policy=parent), self.output)
        with self.assertRaisesRegex(ValueError, "module:factory"):
            AlgorithmSource(self.root, "unicode模块:build")
        source = self.root / "source"
        source.mkdir()
        (source / "gear.py").write_text("")
        with self.assertRaisesRegex(ValueError, "shadow Gear"):
            freeze_algorithm(AlgorithmSource(source, "gear:build"), self.output)
        (source / "gear.py").unlink()
        (source / "policy.py").symlink_to(self.root / "private.py")
        (self.root / "private.py").write_text("secret = 1")
        with self.assertRaisesRegex(ValueError, "regular Python file"):
            freeze_algorithm(AlgorithmSource(source, "policy:build"), self.output)

    def test_direct_main_script_can_freeze_a_top_level_policy(self):
        package = self.root / "local_policy"
        package.mkdir()
        (package / "__init__.py").write_text("")
        (package / "helper.py").write_text("def choose(view): return view.champion\n")
        script = self.root / "driver.py"
        script.write_text(
            "from pathlib import Path\nfrom gear.algorithms import GEPA\nfrom gear.algorithms.source import freeze_algorithm\nfrom local_policy import helper\ndef parent(view):\n    return helper.choose(view)\nif __name__=='__main__':\n    frozen=freeze_algorithm(GEPA(parent_policy=parent),Path('sealed'))\n    print(frozen.source)\n"
        )
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
        path = subprocess.check_output(
            [sys.executable, str(script)], cwd=self.root, env=env, text=True
        ).strip()
        self.assertTrue(
            self.run_frozen(AlgorithmSource(self.root / path, "_gear_factory:build_algorithm"))[
                "ok"
            ]
        )


class ConformanceTests(unittest.TestCase):
    def test_public_recipe_is_deterministic_and_offline(self):
        self.assertEqual(check_algorithm(GEPA()), check_algorithm(GEPA()))

    def test_rejects_input_mutation_nondeterminism_and_partial_nomination(self):
        class Mutates:
            def step(self, view, state):
                view.candidates[0].scores["sum"] = 1
                return Decision({}, (Operation("stop"),), "stop")

        class Stateful:
            def __init__(self):
                self.count = 0

            def step(self, view, state):
                self.count += 1
                return Decision({"count": self.count}, (Operation("stop"),), "stop")

        class Partial:
            def step(self, view, state):
                return Decision(
                    {},
                    (
                        Operation("generate", candidate="next", parent="initial"),
                        Operation("nominate", candidate="next"),
                    ),
                    "invalid partial",
                )

        for algorithm, message in [
            (Mutates(), "mutated-input"),
            (Stateful(), "not-deterministic"),
            (Partial(), "complete-seed"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                check_algorithm(algorithm)


class ProjectSDKTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.driver = self.root / "runtime.py"
        self.driver.write_text(
            "import sys,json,time\ntime.sleep(.08)\nprint(json.dumps({'arguments':sys.argv[1:]}))\n"
        )
        self.project = Project.open(self.root, command=(sys.executable, str(self.driver)))

    def test_sync_algorithm_override_does_not_change_project_configuration(self):
        path = self.root / "gear.yaml"
        path.write_text("algorithm: gepa\n")
        result = self.project.refine(rounds=2, algorithm=GEPA())
        args = result["arguments"]
        self.assertEqual(args[:3], ["refine", "--rounds", "2"])
        self.assertIn("--algorithm-source", args)
        self.assertTrue(Path(args[args.index("--algorithm-source") + 1]).is_dir())
        self.assertEqual(path.read_text(), "algorithm: gepa\n")

    async def test_async_client_does_not_block_the_event_loop_and_uses_same_contract(self):
        task = asyncio.create_task(self.project.arefine(rounds=2, algorithm=GEPA()))
        await asyncio.sleep(0.01)
        self.assertFalse(task.done())
        async_result = await task
        self.assertEqual(async_result, self.project.refine(rounds=2, algorithm=GEPA()))
        operations = [
            (self.project.acheck(), ["benchmark", "check"]),
            (self.project.aevaluate(limit=1), ["evaluate", "--split", "seed", "--limit", "1"]),
            (self.project.areport("run"), ["report", "run"]),
            (self.project.aresume("run"), ["resume", "run"]),
            (self.project.acancel("run"), ["cancel", "run"]),
            (self.project.acompile(), ["benchmark", "compile"]),
            (self.project.aexport("run"), ["export", "run"]),
            (self.project.aconfig(), ["config", "explain"]),
        ]
        results = await asyncio.gather(*(op for op, _ in operations))
        for result, (_, expected) in zip(results, operations):
            self.assertEqual(result["arguments"], expected + ["--json"])

    async def test_cancelled_client_process_is_reaped(self):
        self.driver.write_text(
            "import os,time,pathlib\npathlib.Path('pid').write_text(str(os.getpid()))\ntime.sleep(60)\n"
        )
        task = asyncio.create_task(self.project.areport())
        for _ in range(100):
            if (self.root / "pid").exists():
                break
            await asyncio.sleep(0.01)
        pid = int((self.root / "pid").read_text())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    async def test_sync_and_async_errors_are_structured(self):
        self.driver.write_text(
            "import json,sys\nprint(json.dumps({'code':'fixture-failure','message':'Failed as expected'}),file=sys.stderr)\nsys.exit(1)\n"
        )
        with self.assertRaises(GearError) as sync:
            self.project.check()
        with self.assertRaises(GearError) as asynchronous:
            await self.project.acheck()
        self.assertEqual(sync.exception.details, asynchronous.exception.details)


if __name__ == "__main__":
    unittest.main()
