import type { HitchVerifierEvidence } from '../../types.js'
import { HitchEvaluationError, type ProcessResult } from './contracts.js'
import {
  evaluationTrialScores,
  verifierDiagnostics,
  verifierFeedback,
  verifierProcessEvidence,
  verifierStructuredArtifact,
} from './verifier-wire.js'
import {
  exactFields,
  excerpt,
  integer,
  jsonValue,
  optionalFinite,
  optionalString,
  record,
  string,
  stringArray,
  structuredCliError,
} from './wire-primitives.js'

interface VerifierReaderOptions {
  root: string
  maxTrajectoryOutputBytes: number
}
type ReadCommand = (args: string[], cwd: string, signal: AbortSignal, maxOutputBytes: number) => Promise<ProcessResult>

/** Read-only verifier evidence, independent of search state, submission and trajectory caches. */
export class HitchVerifierEvidenceReader {
  constructor(
    private readonly options: VerifierReaderOptions,
    private readonly repositoryPath: string,
    private readonly run: ReadCommand,
  ) {}

  async inspectVerifierEvidence(runId: string, signal: AbortSignal): Promise<HitchVerifierEvidence> {
    if (!/^run_[0-9a-f]{32}$/u.test(runId)) throw new TypeError('Hitch verifier evidence requires a valid run ID')
    signal.throwIfAborted()
    const args = [
      ...(this.options.root.length === 0 ? [] : ['--root', this.options.root]),
      'verifier',
      'inspect',
      runId,
      '--json',
    ]
    const processResult = await this.run(args, this.repositoryPath, signal, this.options.maxTrajectoryOutputBytes)
    if (processResult.exitCode !== 0) {
      const output = `${processResult.stderr}\n${processResult.stdout}`.trim()
      const structured = structuredCliError(output)
      if (structured?.code === 'verifier_evidence_corrupt') {
        return {
          runId,
          verifier: {
            status: 'corrupt',
            issues: [`Hitch could not validate verifier evidence: ${excerpt(structured.message, 512)}`],
          },
        }
      }
      if (output !== 'hitch: unknown command: verifier') {
        throw new HitchEvaluationError(
          `Hitch verifier inspect failed with exit ${processResult.exitCode}: ${excerpt(output, 1_000)}`,
          'hitch_verifier_inspect_failed',
        )
      }
      return {
        runId,
        verifier: {
          status: 'unavailable',
          issues: [`Hitch verifier evidence API is unsupported: ${output}`],
        },
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(processResult.stdout)
    } catch (error) {
      throw new HitchEvaluationError(
        `Hitch emitted invalid verifier evidence JSON (${String(error)})`,
        'invalid_hitch_json',
      )
    }
    const result = record(parsed, 'Hitch verifier evidence')
    if (result.schema_version !== '1' || result.kind !== 'verifier-evidence' || result.run_id !== runId) {
      throw new HitchEvaluationError(
        'Hitch verifier evidence identity does not match the requested run',
        'invalid_hitch_result',
      )
    }
    const parentRecord = result.parent === undefined ? undefined : record(result.parent, 'verifier evidence parent')
    const parentAttempt =
      parentRecord === undefined ? undefined : integer(parentRecord.attempt, 'verifier evidence parent.attempt')
    if (parentAttempt !== undefined && parentAttempt <= 0) {
      throw new HitchEvaluationError('verifier evidence parent.attempt must be positive', 'invalid_hitch_result')
    }
    const parentEvalId =
      parentRecord === undefined ? undefined : string(parentRecord.eval_id, 'verifier evidence parent.eval_id')
    if (parentEvalId !== undefined && !/^eval_[0-9a-f]{32}$/u.test(parentEvalId)) {
      throw new HitchEvaluationError('verifier evidence parent.eval_id is invalid', 'invalid_hitch_result')
    }
    const parentTrialId =
      parentRecord === undefined ? undefined : string(parentRecord.trial_id, 'verifier evidence parent.trial_id')
    const observationRecord =
      result.observation === undefined ? undefined : record(result.observation, 'verifier evidence observation')
    const observationStatus = observationRecord?.status
    if (observationRecord !== undefined && observationStatus !== 'valid' && observationStatus !== 'invalid') {
      throw new HitchEvaluationError('verifier evidence observation.status is invalid', 'invalid_hitch_result')
    }
    const observationReward =
      observationRecord === undefined
        ? undefined
        : optionalFinite(observationRecord.reward, 'verifier evidence observation.reward')
    const observationInvalidReason =
      observationRecord === undefined
        ? undefined
        : optionalString(observationRecord.invalid_reason, 'verifier evidence observation.invalid_reason')
    const observationResultRef =
      observationRecord === undefined
        ? undefined
        : optionalString(observationRecord.verifier_result_ref, 'verifier evidence observation.verifier_result_ref')
    const verifierRecord = record(result.verifier, 'verifier evidence verifier')
    exactFields(
      verifierRecord,
      [
        'status',
        'result',
        'result_sha256',
        'scores',
        'process',
        'feedback',
        'structured_artifacts',
        'diagnostics',
        'issues',
      ],
      'verifier evidence verifier',
    )
    const verifierStatus = verifierRecord.status
    if (
      verifierStatus !== 'complete' &&
      verifierStatus !== 'result_only' &&
      verifierStatus !== 'missing' &&
      verifierStatus !== 'corrupt'
    ) {
      throw new HitchEvaluationError('verifier evidence status is invalid', 'invalid_hitch_result')
    }
    const resultSha256 = optionalString(verifierRecord.result_sha256, 'verifier evidence result_sha256')
    if (resultSha256 !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(resultSha256)) {
      throw new HitchEvaluationError('verifier evidence result digest is invalid', 'invalid_hitch_result')
    }
    if (
      (verifierStatus === 'complete' || verifierStatus === 'result_only') &&
      (verifierRecord.result === undefined || resultSha256 === undefined)
    ) {
      throw new HitchEvaluationError(
        `${verifierStatus} verifier evidence requires a result and digest`,
        'invalid_hitch_result',
      )
    }
    const scores =
      verifierRecord.scores === undefined
        ? undefined
        : evaluationTrialScores(verifierRecord.scores, 'verifier evidence scores')
    const process = verifierRecord.process === undefined ? undefined : verifierProcessEvidence(verifierRecord.process)
    const feedback =
      verifierRecord.feedback === undefined ? undefined : verifierFeedback(verifierRecord.feedback, process)
    const structuredArtifactsRecord =
      verifierRecord.structured_artifacts === undefined
        ? undefined
        : record(verifierRecord.structured_artifacts, 'verifier evidence structured_artifacts')
    if (structuredArtifactsRecord !== undefined) {
      exactFields(structuredArtifactsRecord, ['process', 'feedback'], 'verifier evidence structured_artifacts')
      if (structuredArtifactsRecord.process === undefined && structuredArtifactsRecord.feedback === undefined) {
        throw new HitchEvaluationError(
          'verifier evidence structured_artifacts must not be empty',
          'invalid_hitch_result',
        )
      }
    }
    const structuredArtifacts =
      structuredArtifactsRecord === undefined
        ? undefined
        : {
            ...(structuredArtifactsRecord.process === undefined
              ? {}
              : {
                  process: verifierStructuredArtifact(structuredArtifactsRecord.process, 'process'),
                }),
            ...(structuredArtifactsRecord.feedback === undefined
              ? {}
              : {
                  feedback: verifierStructuredArtifact(structuredArtifactsRecord.feedback, 'feedback'),
                }),
          }
    if (verifierStatus !== 'corrupt') {
      if ((process !== undefined) !== (scores?.processScore !== undefined)) {
        throw new HitchEvaluationError(
          'verifier process availability does not match process_score',
          'invalid_hitch_result',
        )
      }
      if (process !== undefined && Math.abs(process.score - scores!.processScore!) > 1e-12) {
        throw new HitchEvaluationError('verifier process score is inconsistent', 'invalid_hitch_result')
      }
      if (
        (process !== undefined) !== (structuredArtifacts?.process !== undefined) ||
        (feedback !== undefined) !== (structuredArtifacts?.feedback !== undefined)
      ) {
        throw new HitchEvaluationError('verifier structured artifact metadata is incomplete', 'invalid_hitch_result')
      }
    }
    const parsedDiagnostics =
      verifierRecord.diagnostics === undefined ? undefined : verifierDiagnostics(verifierRecord.diagnostics)
    const hasArtifactDiagnostics = parsedDiagnostics?.hasArtifacts === true
    if (verifierStatus === 'complete' && !hasArtifactDiagnostics) {
      throw new HitchEvaluationError('complete verifier evidence requires artifact diagnostics', 'invalid_hitch_result')
    }
    if (verifierStatus === 'result_only' && hasArtifactDiagnostics) {
      throw new HitchEvaluationError(
        'result_only verifier evidence must not include artifact diagnostics',
        'invalid_hitch_result',
      )
    }
    if (verifierStatus === 'missing' && (verifierRecord.result !== undefined || resultSha256 !== undefined)) {
      throw new HitchEvaluationError(
        'missing verifier evidence must not include a result or digest',
        'invalid_hitch_result',
      )
    }
    const issues =
      verifierRecord.issues === undefined ? undefined : stringArray(verifierRecord.issues, 'verifier evidence issues')
    const redactions =
      result.redactions === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(result.redactions)) {
              throw new HitchEvaluationError('verifier evidence redactions must be an array', 'invalid_hitch_result')
            }
            const values = result.redactions.map((item, index) => {
              const redaction = record(item, `verifier evidence redactions[${index}]`)
              exactFields(redaction, ['rule_id', 'count'], `verifier evidence redactions[${index}]`)
              const ruleId = string(redaction.rule_id, `verifier evidence redactions[${index}].rule_id`)
              const count = integer(redaction.count, `verifier evidence redactions[${index}].count`)
              if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(ruleId) || count < 1) {
                throw new HitchEvaluationError(
                  `verifier evidence redactions[${index}] is invalid`,
                  'invalid_hitch_result',
                )
              }
              return { ruleId, count }
            })
            const canonical = [...values].sort((left, right) => left.ruleId.localeCompare(right.ruleId))
            if (
              new Set(values.map((item) => item.ruleId)).size !== values.length ||
              JSON.stringify(canonical) !== JSON.stringify(values)
            ) {
              throw new HitchEvaluationError(
                'verifier evidence redactions must be unique and canonical',
                'invalid_hitch_result',
              )
            }
            return values
          })()
    return {
      runId,
      ...(parentRecord === undefined
        ? {}
        : {
            parent: {
              evalId: parentEvalId!,
              trialId: parentTrialId!,
              attempt: parentAttempt!,
            },
          }),
      ...(observationRecord === undefined
        ? {}
        : {
            observation: {
              status: observationStatus as 'valid' | 'invalid',
              ...(observationReward === undefined ? {} : { reward: observationReward }),
              ...(observationInvalidReason === undefined ? {} : { invalidReason: observationInvalidReason }),
              ...(observationResultRef === undefined ? {} : { verifierResultRef: observationResultRef }),
            },
          }),
      verifier: {
        status: verifierStatus,
        ...(verifierRecord.result === undefined
          ? {}
          : { result: jsonValue(verifierRecord.result, 'verifier evidence result') }),
        ...(resultSha256 === undefined ? {} : { resultSha256 }),
        ...(scores === undefined ? {} : { scores }),
        ...(process === undefined ? {} : { process }),
        ...(feedback === undefined ? {} : { feedback }),
        ...(structuredArtifacts === undefined ? {} : { structuredArtifacts }),
        ...(parsedDiagnostics === undefined
          ? {}
          : {
              diagnostics: parsedDiagnostics.value,
            }),
        ...(issues === undefined ? {} : { issues }),
      },
      ...(redactions === undefined ? {} : { redactions }),
    }
  }
}
