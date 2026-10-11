import type { AlgorithmOperation, CandidateWorkPlan, SearchView } from './algorithm-protocol.js'
import { canonicalDigest } from './canonical.js'
import type { DiagnosisFact } from './diagnosis.js'
import { GearError, GenerationFailed } from './errors.js'

export interface WorkplanDelivery {
  workplan: CandidateWorkPlan
  workplanIdentity: string
  identity: string
  dossier: {
    source_dossier_identity: string
    parent_identity: string
    baseline_evidence: string[]
    facts: DiagnosisFact[]
    classifier_identity: string
    sanitization_identity: string
  }
  scopeTaskIds: string[]
}
const same = (a: string[], b: string[]) => {
  const values = new Set(b)
  return a.length === values.size && a.every((id) => values.has(id))
}

/** Author scope/cluster labels are opaque. Authority comes from the committed seed dossier. */
export function prepareWorkplan(op: AlgorithmOperation, view: SearchView): WorkplanDelivery | undefined {
  const plan = op.workplan
  if (!plan) return
  if (op.kind !== 'generate' || !op.diagnosis_id) throw new TypeError('workplan-needs-committed-diagnosis')
  const receipt = view.completed[op.diagnosis_id]
  const dossier = receipt?.dossier as
    | {
        identity: string
        parent_identity: string
        task_ids: string[]
        baseline_evidence: string[]
        facts: DiagnosisFact[]
        classifier_identity: string
        sanitization_identity: string
      }
    | undefined
  const parent = view.candidates.find((c) => c.id === op.parent)
  if (
    receipt?.kind !== 'diagnose_seed' ||
    receipt.candidate !== op.parent ||
    receipt.method !== 'provider-seed-diagnosis-v1' ||
    !dossier ||
    plan.candidate_id !== op.candidate ||
    plan.parent_identity !== parent?.content_digest ||
    plan.parent_identity !== dossier.parent_identity ||
    plan.dossier_identity !== dossier.identity ||
    !same(plan.required_seed_tasks, view.seed_tasks) ||
    !plan.target_task_ids.every((id) => dossier.task_ids.includes(id)) ||
    !op.tasks.length ||
    !op.tasks.every((id) => dossier.task_ids.includes(id)) ||
    !plan.target_task_ids.every((id) => op.tasks.includes(id))
  )
    throw new TypeError('workplan-provenance-mismatch')
  const facts = dossier.facts.filter((f) => f.status === 'supported-hypothesis' && f.family_id === plan.family_id)
  const paths = facts.flatMap((f) => f.modification_paths ?? [])
  const refs = facts.flatMap((f) => f.evidence_refs)
  if (
    !facts.some((f) => f.hypothesis === plan.hypothesis) ||
    !same(
      plan.target_task_ids,
      facts.map((f) => f.task_id),
    ) ||
    !same(plan.required_diagnosis_refs, refs) ||
    !same(plan.modification_paths, paths)
  )
    throw new TypeError('workplan-unsupported-hypothesis')
  if (Object.values(plan.generation_budget).some((value) => value !== null))
    throw new GearError({
      code: 'generation-limits-unsupported',
      message: 'This generation port cannot enforce workplan deadline, token or request limits',
      retryable: false,
      next_action: 'Use a runtime with verified generation metering before enabling these limits.',
    })
  const selected = new Set(op.tasks)
  const body = {
    workplan: structuredClone(plan),
    workplanIdentity: canonicalDigest(plan),
    dossier: {
      source_dossier_identity: dossier.identity,
      parent_identity: dossier.parent_identity,
      baseline_evidence: [...dossier.baseline_evidence],
      facts: structuredClone(dossier.facts.filter((f) => selected.has(f.task_id))),
      classifier_identity: dossier.classifier_identity,
      sanitization_identity: dossier.sanitization_identity,
    },
    scopeTaskIds: [...op.tasks],
  }
  return { ...body, identity: canonicalDigest(body) }
}

/** Enforce the assigned boundary on additions, edits and deletions before sealing. */
export function validateWorkplanMutation(
  delivery: WorkplanDelivery | undefined,
  parent: Record<string, string>,
  candidate: Record<string, string>,
): void {
  if (!delivery) return
  for (const path of new Set([...Object.keys(parent), ...Object.keys(candidate)])) {
    if (parent[path] === candidate[path]) continue
    if (!delivery.workplan.modification_paths.some((boundary) => path === boundary || path.startsWith(`${boundary}/`)))
      throw new GenerationFailed('workplan-boundary')
  }
}
