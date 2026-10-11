import { canonicalDigest } from './canonical.js'

export interface DiagnosisUsage {
  requests: number
  inputTokens: number
  outputTokens: number
}
export interface DiagnosisObservation {
  taskId: string
  family: string
  instruction: string
  output?: string
  score: number | null
  evidenceRef: string | null
}
export interface DiagnosisInput {
  operationId: string
  parentId: string
  parentDigest: string
  cohortDigest: string
  baselineDigest: string
  observations: DiagnosisObservation[]
  limits: DiagnosisUsage
}
export interface DiagnosisFact {
  task_id: string
  evidence_refs: string[]
  status: 'supported-hypothesis' | 'unresolved' | 'infrastructure-invalid' | 'successful-control'
  family_id?: string | null
  hypothesis?: string | null
  modification_paths?: string[]
  mechanism?: string | null
  submode?: string | null
}
export interface DiagnosisResult {
  facts: DiagnosisFact[]
  usage: DiagnosisUsage
}

export const diagnosisSanitization = 'seed-text-projection-v1'
export function diagnosisText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
    })
    .slice(0, 16_384)
    .join('')
}
export function validateDiagnosisUsage(value: DiagnosisUsage): void {
  if (
    !value ||
    Object.keys(value).sort().join() !== 'inputTokens,outputTokens,requests' ||
    Object.values(value).some((v) => !Number.isSafeInteger(v) || v < 0)
  )
    throw new TypeError('invalid-diagnosis-usage')
}
export function diagnosisOverBudget(actual: DiagnosisUsage, limits: DiagnosisUsage): boolean {
  return (['requests', 'inputTokens', 'outputTokens'] as const).some((key) => actual[key] > limits[key])
}
const relative = (path: string): boolean =>
  !!path &&
  !path.includes('\\') &&
  !path.includes(':') &&
  path.split('/').every((part) => !!part && part !== '.' && part !== '..')

/** Certifies provenance and observed outcome, not the truth of a research hypothesis. */
export function certifyDiagnosis(input: DiagnosisInput, result: DiagnosisResult, classifier: string) {
  if (!Array.isArray(result.facts)) throw new TypeError('invalid-diagnosis-facts')
  const facts = result.facts.map((fact) => {
    const task = input.observations.find((t) => t.taskId === fact.task_id)
    if (
      !task ||
      !Array.isArray(fact.evidence_refs) ||
      new Set(fact.evidence_refs).size !== fact.evidence_refs.length ||
      fact.evidence_refs.some((ref) => typeof ref !== 'string' || ref !== task.evidenceRef) ||
      !['supported-hypothesis', 'unresolved', 'infrastructure-invalid', 'successful-control'].includes(fact.status)
    )
      throw new TypeError('diagnosis-evidence-mismatch')
    const paths = fact.modification_paths ?? []
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || !relative(path)))
      throw new TypeError('invalid-diagnosis-boundary')
    for (const key of ['family_id', 'hypothesis', 'mechanism', 'submode'] as const)
      if (fact[key] != null && typeof fact[key] !== 'string') throw new TypeError('invalid-diagnosis-fact')
    if (
      fact.status === 'supported-hypothesis' &&
      (task.score === null ||
        task.score >= 1 ||
        !fact.evidence_refs.length ||
        !fact.family_id ||
        !fact.hypothesis ||
        !fact.mechanism ||
        !paths.length)
    )
      throw new TypeError('diagnosis-needs-business-failure-evidence')
    if (fact.status === 'successful-control' && (task.score !== 1 || !fact.evidence_refs.length))
      throw new TypeError('diagnosis-needs-complete-success-evidence')
    if (fact.status === 'infrastructure-invalid' && task.score !== null)
      throw new TypeError('diagnosis-invalidates-valid-evidence')
    return {
      task_id: fact.task_id,
      evidence_refs: [...fact.evidence_refs],
      status: fact.status,
      family_id: fact.family_id ?? null,
      hypothesis: fact.hypothesis ?? null,
      modification_paths: [...paths],
      mechanism: fact.mechanism ?? null,
      submode: fact.submode ?? null,
    }
  })
  for (const task of input.observations)
    if (!facts.some((f) => f.task_id === task.taskId))
      facts.push({
        task_id: task.taskId,
        evidence_refs: task.evidenceRef ? [task.evidenceRef] : [],
        status: task.score === null ? 'infrastructure-invalid' : task.score === 1 ? 'successful-control' : 'unresolved',
        family_id: null,
        hypothesis: null,
        modification_paths: [],
        mechanism: null,
        submode: null,
      })
  const body = {
    parent_identity: input.parentDigest,
    cohort_identity: input.cohortDigest,
    task_ids: input.observations.map((t) => t.taskId),
    baseline_evidence: [input.baselineDigest],
    facts,
    classifier_identity: classifier,
    sanitization_identity: diagnosisSanitization,
  }
  return { ...body, identity: canonicalDigest(body) }
}
