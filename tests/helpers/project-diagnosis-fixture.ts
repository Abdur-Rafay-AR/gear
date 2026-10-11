import { clusters, consumptionReceipt, deliveredWorkplan, validateReceipt } from '../../src/search/diagnosis.js'
import { seal } from '../../src/search/contracts.js'
import { revise, scopeFixture, snapshot, universe } from '../../src/search/testing.js'
import type { CandidateWorkPlan, DiagnosisFact } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'

export interface DiagnosisFixture {
  name: string
  facts: DiagnosisFact[]
  protected: string[]
  scopeTasks?: string[]
}
const factProjection = (f: DiagnosisFact) => ({
  task_id: f.taskId,
  evidence_refs: f.evidenceRefs,
  status: f.status,
  family_id: f.familyId ?? null,
  hypothesis: f.hypothesis ?? null,
  modification_paths: f.modificationPaths ?? [],
  mechanism: f.mechanism ?? null,
  submode: f.submode ?? null,
})
export function legacyDiagnosis(f: DiagnosisFixture) {
  const base = universe(8)
  const u = revise(base, { tasks: base.tasks.map((t, i) => ({ ...t, estimatedCost: i + 1 })) })
  const parent = snapshot('parent')
  const dossier = seal({
    parentSnapshotDigest: parent.digest,
    universeDigest: u.digest,
    taskIds: u.tasks.map((t) => t.id),
    baselineEvidenceDigests: [digestJson('baseline')],
    facts: f.facts,
    classifierIntegrity: digestJson('classifier'),
    sanitizationPolicyDigest: digestJson('sanitization'),
  })
  const families = clusters(dossier, u, f.protected)
  const projected = families.map((c) => ({
    family_id: c.familyId,
    parent_identity: c.parentSnapshotDigest,
    dossier_identity: c.dossierDigest,
    task_ids: c.taskIds,
    evidence_refs: c.evidenceRefs,
    hypotheses: c.hypotheses,
    modification_paths: c.modificationPaths,
    task_features: Object.fromEntries(
      (c.taskFeatures ?? []).map((t) => [t.taskId, { submodes: t.submodes, modification_paths: t.modificationPaths }]),
    ),
    successful_control_task_ids: c.successfulControlTaskIds,
    protected_failure: c.protectedFailure,
    estimated_cost: c.estimatedCost,
  }))
  const deliveries = families.map((c, i) => {
    const scope = scopeFixture(u, f.scopeTasks ?? c.taskIds, c.familyId)
    const workplan: CandidateWorkPlan = seal({
      candidateId: `candidate-${i}`,
      batchId: 'batch-0',
      parentSnapshotDigest: parent.digest,
      dossierDigest: dossier.digest,
      clusterDigest: c.digest,
      familyId: c.familyId,
      hypothesis: c.hypotheses[0]!,
      targetTaskIds: c.taskIds,
      requiredDiagnosisRefs: c.evidenceRefs,
      modificationPaths: c.modificationPaths,
      scopeDigest: scope.digest,
      localStagePlanDigest: digestJson('local-plan'),
      modificationBoundaryRule: {
        requiredSeedTaskIds: u.tasks.map((t) => t.id),
        onInsufficientScope: 'retain-research-only',
      },
      generationBudget: { maxTokens: 42, maxModelRequests: 3, deadlineAt: 1767225660000 },
    })
    const findings = [{ candidate: 'previous', observation: 'fixture' }]
    const delivered = deliveredWorkplan(workplan, dossier, findings, f.scopeTasks ? scope : undefined)
    const accessed = [...c.evidenceRefs, 'extra-read', ...c.evidenceRefs]
    const receipt = consumptionReceipt(delivered, 'session', accessed)
    validateReceipt(receipt, delivered, 'session')
    return {
      scope: {
        id: scope.digest,
        family: scope.familyId,
        epoch: scope.epoch,
        task_ids: scope.taskIds,
        weights: scope.weights,
        guard_identity: '',
      },
      local_plan_id: workplan.localStagePlanDigest,
      include_scope: !!f.scopeTasks,
      expected: {
        target_task_ids: workplan.targetTaskIds,
        required_refs: workplan.requiredDiagnosisRefs,
        required_seed_tasks: workplan.modificationBoundaryRule.requiredSeedTaskIds,
        on_insufficient_scope: workplan.modificationBoundaryRule.onInsufficientScope,
        generation_budget: {
          deadline_ms: workplan.generationBudget.deadlineAt,
          max_tokens: workplan.generationBudget.maxTokens,
          max_model_requests: workplan.generationBudget.maxModelRequests,
        },
        facts: delivered.dossier.facts.map(factProjection),
        findings: delivered.findings,
        candidate_id: receipt.candidateId,
        session_id: receipt.sessionId,
        accessed_refs: receipt.accessedRefs,
      },
    }
  })
  return {
    input: {
      tasks: u.tasks.map((t) => ({ id: t.id, stratum: t.stratum, estimated_cost: t.estimatedCost })),
      cohort_identity: u.digest,
      protected_ids: f.protected,
      family_order: [...new Set(projected.map((c) => c.family_id))].sort((a, b) => a.localeCompare(b)),
      dossier: {
        identity: dossier.digest,
        parent_identity: parent.digest,
        cohort_identity: u.digest,
        task_ids: dossier.taskIds,
        baseline_evidence: dossier.baselineEvidenceDigests,
        facts: f.facts.map(factProjection),
        classifier_identity: dossier.classifierIntegrity,
        sanitization_identity: dossier.sanitizationPolicyDigest,
      },
    },
    expected: { clusters: projected, deliveries },
  }
}
