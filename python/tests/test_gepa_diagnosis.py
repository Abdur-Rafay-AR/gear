import copy
from dataclasses import asdict, replace
import json
from pathlib import Path
import unittest

from gear.algorithms.gepa.diagnosis import (
    DiagnosisDossier,
    DiagnosisFact,
    DiagnosisTask,
    failure_clusters,
)
from gear.algorithms.gepa.proposal import (
    GenerationBudget,
    HypothesisPlan,
    candidate_workplan,
    consumption_receipt,
    deliver_workplan,
    plan_hypotheses,
    validate_receipt,
)
from gear.algorithms.gepa.research import ArchiveScope

FIXTURE = Path(__file__).resolve().parents[2] / "test-contracts/gepa-diagnosis-v1.json"


def read_case(case):
    spec = case["input"]
    d = spec["dossier"]
    dossier = DiagnosisDossier(
        **{
            **d,
            "task_ids": tuple(d["task_ids"]),
            "baseline_evidence": tuple(d["baseline_evidence"]),
            "facts": tuple(
                DiagnosisFact(
                    **{
                        **f,
                        "evidence_refs": tuple(f["evidence_refs"]),
                        "modification_paths": tuple(f["modification_paths"]),
                    }
                )
                for f in d["facts"]
            ),
        }
    )
    tasks = tuple(DiagnosisTask(**t) for t in spec["tasks"])
    return dossier, tasks


def families(case):
    dossier, tasks = read_case(case)
    return failure_clusters(
        dossier,
        tasks,
        case["input"]["cohort_identity"],
        tuple(case["input"]["protected_ids"]),
        family_order=tuple(case["input"]["family_order"]),
    )


def delivery(case, index=0):
    dossier, tasks = read_case(case)
    cluster = families(case)[index]
    spec = case["expected"]["deliveries"][index]
    scope = ArchiveScope(**{**spec["scope"], "task_ids": tuple(spec["scope"]["task_ids"])})
    work = candidate_workplan(
        f"candidate-{index}",
        "batch-0",
        HypothesisPlan(cluster, cluster.hypotheses[0]),
        scope,
        spec["local_plan_id"],
        tuple(t.id for t in tasks),
        GenerationBudget(1767225660000, 42, 3),
    )
    value = deliver_workplan(
        work, dossier, tuple(spec["expected"]["findings"]), scope if spec["include_scope"] else None
    )
    return value


class DiagnosisTests(unittest.TestCase):
    def test_frozen_legacy_clusters_excerpts_and_receipts(self):
        for case in json.loads(FIXTURE.read_text())["cases"]:
            with self.subTest(case=case["name"]):
                before = copy.deepcopy(case)
                result = families(case)
                self.assertEqual(
                    json.loads(json.dumps([asdict(c) for c in result])),
                    case["expected"]["clusters"],
                )
                self.assertEqual(result, families(case))
                for i, spec in enumerate(case["expected"]["deliveries"]):
                    value = delivery(case, i)
                    receipt = consumption_receipt(
                        value, "session", tuple(spec["expected"]["accessed_refs"])
                    )
                    validate_receipt(receipt, value, "session")
                    projected = {
                        "target_task_ids": value.workplan.target_task_ids,
                        "required_refs": value.workplan.required_diagnosis_refs,
                        "required_seed_tasks": value.workplan.required_seed_tasks,
                        "on_insufficient_scope": value.workplan.on_insufficient_scope,
                        "generation_budget": asdict(value.workplan.generation_budget),
                        "facts": [asdict(f) for f in value.dossier.facts],
                        "findings": value.findings,
                        "candidate_id": receipt.candidate_id,
                        "session_id": receipt.session_id,
                        "accessed_refs": receipt.accessed_refs,
                    }
                    self.assertEqual(json.loads(json.dumps(projected)), spec["expected"])
                    self.assertEqual(value.workplan.cluster_identity, result[i].identity)
                    self.assertEqual(
                        result[i].sampling_diagnosis().features, result[i].task_features
                    )
                self.assertEqual(case, before)

    def test_rejects_foreign_cohort_task_provenance_and_unsupported_claims(self):
        case = json.loads(FIXTURE.read_text())["cases"][1]
        dossier, tasks = read_case(case)
        for change in (
            {"cohort_identity": "other"},
            {"parent_identity": ""},
            {"baseline_evidence": ()},
            {"classifier_identity": ""},
            {"sanitization_identity": ""},
        ):
            with self.assertRaises(ValueError):
                failure_clusters(replace(dossier, **change), tasks, dossier.cohort_identity)
        for change in (
            {"task_id": "HELD-OUT"},
            {"evidence_refs": ()},
            {"hypothesis": None},
            {"mechanism": None},
            {"family_id": None},
            {"modification_paths": ()},
        ):
            with self.assertRaises(ValueError):
                failure_clusters(
                    replace(dossier, facts=(replace(dossier.facts[0], **change),)),
                    tasks,
                    dossier.cohort_identity,
                )
        for path in (
            "../secret",
            "/private",
            "harness/../secret",
            "C:\\secret",
            "harness//main",
            "./harness",
        ):
            with self.assertRaisesRegex(ValueError, "boundary"):
                failure_clusters(
                    replace(
                        dossier, facts=(replace(dossier.facts[0], modification_paths=(path,)),)
                    ),
                    tasks,
                    dossier.cohort_identity,
                )
        for status in ("unresolved", "infrastructure-invalid", "successful-control"):
            self.assertEqual(
                failure_clusters(
                    replace(dossier, facts=(replace(dossier.facts[0], status=status),)),
                    tasks,
                    dossier.cohort_identity,
                ),
                (),
            )
        with self.assertRaisesRegex(ValueError, "seed"):
            failure_clusters(dossier, tasks, dossier.cohort_identity, partition="held-out")

    def test_hypothesis_quota_deduplicates_exact_parent_family_hypothesis(self):
        case = json.loads(FIXTURE.read_text())["cases"][4]
        cluster = families(case)[0]
        planned = plan_hypotheses((cluster, cluster), 4, per_family=2)
        self.assertEqual([p.hypothesis for p in planned], ["A", "B"])
        self.assertEqual(
            plan_hypotheses((cluster,), 1, per_family=2, used=(planned[0].identity,)), (planned[1],)
        )
        other_parent = replace(cluster, parent_identity="other-parent")
        self.assertEqual(len(plan_hypotheses((cluster, other_parent), 4, per_family=2)), 4)
        self.assertEqual(plan_hypotheses((cluster,), 0), ())
        for slots, per_family in ((-1, 1), (True, 1), (1, 0), (1, True)):
            with self.assertRaises(ValueError):
                plan_hypotheses((cluster,), slots, per_family=per_family)

    def test_delivery_and_receipts_reject_changed_parent_scope_content_and_missing_reads(self):
        case = json.loads(FIXTURE.read_text())["cases"][6]
        value = delivery(case)
        dossier, _ = read_case(case)
        for changed in (
            replace(dossier, identity="other"),
            replace(dossier, parent_identity="other"),
        ):
            with self.assertRaisesRegex(ValueError, "mismatch"):
                deliver_workplan(value.workplan, changed, scope=value.scope)
        with self.assertRaisesRegex(ValueError, "scope"):
            deliver_workplan(value.workplan, dossier, scope=replace(value.scope, id="other"))
        with self.assertRaisesRegex(ValueError, "missing"):
            deliver_workplan(value.workplan, replace(dossier, facts=()), scope=value.scope)
        with self.assertRaisesRegex(ValueError, "consumed"):
            consumption_receipt(value, "session", ())
        receipt = consumption_receipt(value, "session", value.workplan.required_diagnosis_refs)
        for change in (
            {"candidate_id": "other"},
            {"session_id": "other"},
            {"workplan_identity": "other"},
            {"dossier_identity": "other"},
            {"delivered_identity": "other"},
            {"accessed_refs": ()},
        ):
            with self.assertRaises(ValueError):
                validate_receipt(replace(receipt, **change), value, "session")
        with self.assertRaises(ValueError):
            validate_receipt(receipt, replace(value, findings=({"changed": True},)), "session")

    def test_workplan_requires_frozen_seed_family_hypothesis_and_declared_budget(self):
        case = json.loads(FIXTURE.read_text())["cases"][1]
        cluster = families(case)[0]
        value = delivery(case)
        scope = ArchiveScope(
            **{**case["expected"]["deliveries"][0]["scope"], "task_ids": tuple(cluster.task_ids)}
        )
        for proposal, changed_scope, seeds in (
            (HypothesisPlan(cluster, "invented"), scope, value.workplan.required_seed_tasks),
            (
                HypothesisPlan(cluster, cluster.hypotheses[0]),
                replace(scope, family="other"),
                value.workplan.required_seed_tasks,
            ),
            (
                HypothesisPlan(cluster, cluster.hypotheses[0]),
                replace(scope, task_ids=("HELD-OUT",)),
                value.workplan.required_seed_tasks,
            ),
        ):
            with self.assertRaises(ValueError):
                candidate_workplan(
                    "c",
                    "b",
                    proposal,
                    changed_scope,
                    "local",
                    seeds,
                    GenerationBudget(1767225660000),
                )
        for budget in (
            {"deadline_ms": 0},
            {"deadline_ms": 1767225660000, "max_tokens": -1},
            {"deadline_ms": 1767225660000, "max_model_requests": True},
        ):
            with self.assertRaises(ValueError):
                GenerationBudget(**budget)


if __name__ == "__main__":
    unittest.main()
