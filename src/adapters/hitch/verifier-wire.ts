import type {
  EvaluationTrialScores,
  VerifierFeedback,
  VerifierProcessEvidence,
  VerifierStructuredArtifact,
  VerifierTrajectoryRef,
} from '../../types.js'
import { HitchEvaluationError } from './contracts.js'
import {
  digest,
  exactFields,
  finite,
  integer,
  jsonValue,
  optionalFinite,
  record,
  string,
  stringArray,
} from './wire-primitives.js'

export const VERIFIER_ARTIFACT_NAMES = new Set([
  'ctrf.json',
  'test-stdout.txt',
  'test-stderr.txt',
  'stdout.txt',
  'stderr.txt',
])

export function verifierArtifact(value: unknown, label: string): import('@deepseek-ai/dsh-session').JsonValue {
  const artifact = record(value, label)
  exactFields(artifact, ['name', 'media_type', 'bytes', 'sha256', 'truncated', 'json', 'text'], label)
  const name = string(artifact.name, `${label}.name`)
  if (!VERIFIER_ARTIFACT_NAMES.has(name)) {
    throw new HitchEvaluationError(`${label}.name is invalid`, 'invalid_hitch_result')
  }
  const mediaType = string(artifact.media_type, `${label}.media_type`)
  const expectedMediaType = name === 'ctrf.json' ? 'application/json' : 'text/plain'
  if (mediaType !== expectedMediaType) {
    throw new HitchEvaluationError(`${label}.media_type is invalid`, 'invalid_hitch_result')
  }
  const bytes = integer(artifact.bytes, `${label}.bytes`)
  const sha256 = string(artifact.sha256, `${label}.sha256`)
  if (!/^sha256:[0-9a-f]{64}$/u.test(sha256)) {
    throw new HitchEvaluationError(`${label}.sha256 is invalid`, 'invalid_hitch_result')
  }
  if (typeof artifact.truncated !== 'boolean') {
    throw new HitchEvaluationError(`${label}.truncated must be boolean`, 'invalid_hitch_result')
  }
  const hasJson = artifact.json !== undefined
  const hasText = artifact.text !== undefined
  if (hasJson === hasText) {
    throw new HitchEvaluationError(`${label} requires exactly one content representation`, 'invalid_hitch_result')
  }
  if (hasText && typeof artifact.text !== 'string') {
    throw new HitchEvaluationError(`${label}.text must be a string`, 'invalid_hitch_result')
  }
  if (hasJson && (mediaType !== 'application/json' || artifact.truncated)) {
    throw new HitchEvaluationError(`${label} may use json only for complete JSON content`, 'invalid_hitch_result')
  }
  if (mediaType === 'application/json' && !artifact.truncated && !hasJson) {
    throw new HitchEvaluationError(`${label} requires json for complete JSON content`, 'invalid_hitch_result')
  }
  return {
    name,
    media_type: mediaType,
    bytes,
    sha256,
    truncated: artifact.truncated,
    ...(hasJson ? { json: jsonValue(artifact.json, `${label}.json`) } : { text: artifact.text as string }),
  }
}

export function verifierDiagnostics(value: unknown): {
  value: import('@deepseek-ai/dsh-session').JsonValue
  hasArtifacts: boolean
} {
  const diagnostics = record(value, 'verifier evidence diagnostics')
  exactFields(
    diagnostics,
    ['ctrf', 'stdout', 'stderr', 'infrastructure_error', 'retry_history'],
    'verifier evidence diagnostics',
  )
  const ctrf =
    diagnostics.ctrf === undefined
      ? undefined
      : verifierArtifact(diagnostics.ctrf, 'verifier evidence diagnostics.ctrf')
  const artifactArray = (field: 'stdout' | 'stderr'): import('@deepseek-ai/dsh-session').JsonValue[] | undefined => {
    const source = diagnostics[field]
    if (source === undefined) return undefined
    if (!Array.isArray(source)) {
      throw new HitchEvaluationError(`verifier evidence diagnostics.${field} must be an array`, 'invalid_hitch_result')
    }
    return source.map((item, index) => verifierArtifact(item, `verifier evidence diagnostics.${field}[${index}]`))
  }
  const stdout = artifactArray('stdout')
  const stderr = artifactArray('stderr')
  const infrastructureError =
    diagnostics.infrastructure_error === undefined
      ? undefined
      : jsonValue(diagnostics.infrastructure_error, 'verifier evidence diagnostics.infrastructure_error')
  let retryHistory: import('@deepseek-ai/dsh-session').JsonValue[] | undefined
  if (diagnostics.retry_history !== undefined) {
    if (!Array.isArray(diagnostics.retry_history)) {
      throw new HitchEvaluationError(
        'verifier evidence diagnostics.retry_history must be an array',
        'invalid_hitch_result',
      )
    }
    retryHistory = diagnostics.retry_history.map((item, index) =>
      jsonValue(item, `verifier evidence diagnostics.retry_history[${index}]`),
    )
  }
  const hasArtifacts = ctrf !== undefined || (stdout?.length ?? 0) > 0 || (stderr?.length ?? 0) > 0
  if (!hasArtifacts && infrastructureError === undefined && (retryHistory?.length ?? 0) === 0) {
    throw new HitchEvaluationError('verifier evidence diagnostics must not be empty', 'invalid_hitch_result')
  }
  return {
    value: {
      ...(ctrf === undefined ? {} : { ctrf }),
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
      ...(infrastructureError === undefined ? {} : { infrastructure_error: infrastructureError }),
      ...(retryHistory === undefined ? {} : { retry_history: retryHistory }),
    },
    hasArtifacts,
  }
}

export function evaluationTrialScores(value: unknown, label: string): EvaluationTrialScores {
  const scores = record(value, label)
  exactFields(scores, ['total_score', 'process_score', 'normalization'], label)
  const totalScore = finite(scores.total_score, `${label}.total_score`)
  const processScore = optionalFinite(scores.process_score, `${label}.process_score`)
  if (scores.normalization !== 'standard' && scores.normalization !== 'legacy-reward') {
    throw new HitchEvaluationError(`${label}.normalization is invalid`, 'invalid_hitch_result')
  }
  if (scores.normalization === 'legacy-reward' && processScore !== undefined) {
    throw new HitchEvaluationError(`${label} legacy normalization cannot include process_score`, 'invalid_hitch_result')
  }
  return {
    totalScore,
    ...(processScore === undefined ? {} : { processScore }),
    normalization: scores.normalization,
  }
}

export function verifierTrajectoryRefs(value: unknown, label: string): VerifierTrajectoryRef[] {
  if (!Array.isArray(value)) throw new HitchEvaluationError(`${label} must be an array`, 'invalid_hitch_result')
  return value.map((item, index) => {
    const ref = record(item, `${label}[${index}]`)
    exactFields(ref, ['run_id', 'seq_start', 'seq_end'], `${label}[${index}]`)
    const runId = string(ref.run_id, `${label}[${index}].run_id`)
    if (!/^run_[0-9a-f]{32}$/u.test(runId))
      throw new HitchEvaluationError(`${label}[${index}].run_id is invalid`, 'invalid_hitch_result')
    const seqStart = ref.seq_start === undefined ? undefined : integer(ref.seq_start, `${label}[${index}].seq_start`)
    const seqEnd = ref.seq_end === undefined ? undefined : integer(ref.seq_end, `${label}[${index}].seq_end`)
    if (seqStart !== undefined && seqEnd !== undefined && seqEnd < seqStart) {
      throw new HitchEvaluationError(`${label}[${index}] range is invalid`, 'invalid_hitch_result')
    }
    return { runId, ...(seqStart === undefined ? {} : { seqStart }), ...(seqEnd === undefined ? {} : { seqEnd }) }
  })
}

export function verifierProcessEvidence(value: unknown): VerifierProcessEvidence {
  const process = record(value, 'verifier process evidence')
  exactFields(
    process,
    ['schema_version', 'metric', 'score', 'detail_status', 'passed', 'total', 'excluded', 'components'],
    'verifier process evidence',
  )
  if (
    process.schema_version !== '1' ||
    (process.detail_status !== 'components' && process.detail_status !== 'aggregate-only')
  ) {
    throw new HitchEvaluationError('verifier process evidence schema is invalid', 'invalid_hitch_result')
  }
  const metric = string(process.metric, 'verifier process evidence.metric')
  const score = finite(process.score, 'verifier process evidence.score')
  if (process.detail_status === 'aggregate-only') {
    if (
      process.passed !== undefined ||
      process.total !== undefined ||
      process.excluded !== undefined ||
      process.components !== undefined
    ) {
      throw new HitchEvaluationError(
        'aggregate-only verifier process evidence contains component fields',
        'invalid_hitch_result',
      )
    }
    return { schemaVersion: 1, metric, score, detailStatus: 'aggregate-only' }
  }
  const passed = integer(process.passed, 'verifier process evidence.passed')
  const total = integer(process.total, 'verifier process evidence.total')
  const excluded = integer(process.excluded, 'verifier process evidence.excluded')
  if (!Array.isArray(process.components))
    throw new HitchEvaluationError('verifier process evidence.components must be an array', 'invalid_hitch_result')
  const components = process.components.map((item, index) => {
    const component = record(item, `verifier process evidence.components[${index}]`)
    exactFields(
      component,
      ['id', 'category', 'status', 'weight', 'code', 'public_details', 'private_details_ref', 'trajectory_refs'],
      `verifier process evidence.components[${index}]`,
    )
    if (component.status !== 'passed' && component.status !== 'failed' && component.status !== 'excluded') {
      throw new HitchEvaluationError(
        `verifier process evidence.components[${index}].status is invalid`,
        'invalid_hitch_result',
      )
    }
    const publicDetails =
      component.public_details === undefined
        ? undefined
        : record(component.public_details, `verifier process evidence.components[${index}].public_details`)
    const trajectoryRefs =
      component.trajectory_refs === undefined
        ? undefined
        : verifierTrajectoryRefs(
            component.trajectory_refs,
            `verifier process evidence.components[${index}].trajectory_refs`,
          )
    return {
      id: string(component.id, `verifier process evidence.components[${index}].id`),
      category: string(component.category, `verifier process evidence.components[${index}].category`),
      status: component.status as 'passed' | 'failed' | 'excluded',
      weight: finite(component.weight, `verifier process evidence.components[${index}].weight`),
      ...(component.code === undefined
        ? {}
        : { code: string(component.code, `verifier process evidence.components[${index}].code`) }),
      ...(publicDetails === undefined
        ? {}
        : {
            publicDetails: Object.fromEntries(
              Object.entries(publicDetails).map(([key, item]) => [
                key,
                jsonValue(item, `verifier process evidence.components[${index}].public_details.${key}`),
              ]),
            ),
          }),
      ...(component.private_details_ref === undefined
        ? {}
        : {
            privateDetailsRef: string(
              component.private_details_ref,
              `verifier process evidence.components[${index}].private_details_ref`,
            ),
          }),
      ...(trajectoryRefs === undefined ? {} : { trajectoryRefs }),
    }
  })
  if (
    new Set(components.map((component) => component.id)).size !== components.length ||
    passed !== components.filter((component) => component.status === 'passed').length ||
    total !== components.filter((component) => component.status !== 'excluded').length ||
    excluded !== components.filter((component) => component.status === 'excluded').length
  ) {
    throw new HitchEvaluationError(
      'verifier process evidence component counts are inconsistent',
      'invalid_hitch_result',
    )
  }
  return { schemaVersion: 1, metric, score, detailStatus: 'components', passed, total, excluded, components }
}

export function verifierFeedback(value: unknown, process: VerifierProcessEvidence | undefined): VerifierFeedback {
  const feedback = record(value, 'verifier feedback')
  exactFields(feedback, ['schema_version', 'items'], 'verifier feedback')
  if (feedback.schema_version !== '1' || !Array.isArray(feedback.items)) {
    throw new HitchEvaluationError('verifier feedback schema is invalid', 'invalid_hitch_result')
  }
  const componentIds = new Set(process?.components?.map((component) => component.id) ?? [])
  const items = feedback.items.map((item, index) => {
    const entry = record(item, `verifier feedback.items[${index}]`)
    exactFields(
      entry,
      ['code', 'severity', 'message', 'component_ids', 'trajectory_refs'],
      `verifier feedback.items[${index}]`,
    )
    if (entry.severity !== 'info' && entry.severity !== 'warning' && entry.severity !== 'error') {
      throw new HitchEvaluationError(`verifier feedback.items[${index}].severity is invalid`, 'invalid_hitch_result')
    }
    const ids =
      entry.component_ids === undefined
        ? undefined
        : stringArray(entry.component_ids, `verifier feedback.items[${index}].component_ids`)
    if (ids?.some((id) => !componentIds.has(id)))
      throw new HitchEvaluationError(
        'verifier feedback references an unknown process component',
        'invalid_hitch_result',
      )
    const refs =
      entry.trajectory_refs === undefined
        ? undefined
        : verifierTrajectoryRefs(entry.trajectory_refs, `verifier feedback.items[${index}].trajectory_refs`)
    return {
      code: string(entry.code, `verifier feedback.items[${index}].code`),
      severity: entry.severity as 'info' | 'warning' | 'error',
      message: string(entry.message, `verifier feedback.items[${index}].message`),
      ...(ids === undefined ? {} : { componentIds: ids }),
      ...(refs === undefined ? {} : { trajectoryRefs: refs }),
    }
  })
  return { schemaVersion: 1, items }
}

export function verifierStructuredArtifact(value: unknown, name: 'process' | 'feedback'): VerifierStructuredArtifact {
  const artifact = record(value, `verifier structured artifact ${name}`)
  exactFields(artifact, ['ref', 'bytes', 'sha256'], `verifier structured artifact ${name}`)
  const expected = `verifier/${name}.json` as VerifierStructuredArtifact['ref']
  if (artifact.ref !== expected)
    throw new HitchEvaluationError(`verifier structured artifact ${name}.ref is invalid`, 'invalid_hitch_result')
  return {
    ref: expected,
    bytes: integer(artifact.bytes, `verifier structured artifact ${name}.bytes`),
    sha256: digest(artifact.sha256, `verifier structured artifact ${name}.sha256`),
  }
}
