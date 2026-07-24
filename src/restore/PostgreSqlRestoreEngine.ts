import type { PostgresConnection } from '../connection/PostgresConnection.js';
import { quoteIdentifier } from '../renderer/SqlPrimitives.js';
import {
  acquirePostgresConnection,
  type AcquiredPostgresConnection,
} from '../connection/PostgresConnection.js';
import { redactSensitiveText } from '../security/SensitiveValuePolicy.js';
import type { RestoreArchiveEntry, RestoreArchiveMetadata } from './RestoreArchive.js';
import { loadCopyText } from './CopyTextLoader.js';
import {
  PostgresRestoreError,
  RestoreArchiveValidationError,
  RestoreCancellationError,
  RestorePlanningError,
  RestoreSequenceStateError,
  RestoreSqlExecutionError,
  RestoreTransactionError,
  safeSqlPreview,
  toRestoreCancellationError,
  type RestoreSqlErrorFields,
} from './RestoreErrors.js';
import type { RestorePlan, RestorePlanStep } from './RestorePlan.js';
import { RestorePlanner } from './RestorePlanner.js';
import { RestorePreflightAnalyzer, type RestorePreflightReport } from './RestorePreflight.js';
import {
  QueryRestoreTargetInspector,
  type RestoreTargetInspector,
  type RestoreTargetSnapshot,
} from './RestoreTarget.js';
import {
  normalizeRestoreOptions,
  type RestoreDiagnostic,
  type RestoreFinalizationProgress,
  type RestoreOptions,
  type RestorePhase,
  type RestoreProgressEvent,
  type RestoreRequest,
  type RestoreResult,
  type RestoreStatus,
  type RestoreValidationSummary,
} from './RestoreTypes.js';
import { buildSequenceSetvalQuery, sequenceIdentity } from './SequenceStateRestore.js';

export interface PostgreSqlRestoreEngineConfig {
  readonly targetInspector?: RestoreTargetInspector;
  readonly preflightAnalyzer?: RestorePreflightService;
  readonly planner?: RestorePlanBuilder;
  readonly clock?: () => Date;
}

export interface RestorePreflightService {
  analyze(
    metadata: RestoreArchiveMetadata,
    entries: readonly RestoreArchiveEntry[],
    target: RestoreTargetSnapshot,
    options: RestoreOptions,
  ): RestorePreflightReport;
}

export interface RestorePlanBuilder {
  createPlan(
    metadata: RestoreArchiveMetadata,
    entries: readonly RestoreArchiveEntry[],
    preflight: RestorePreflightReport,
    options: RestoreOptions,
  ): RestorePlan;
}

interface LoadedArchive {
  readonly metadata: RestoreArchiveMetadata;
  readonly entries: readonly RestoreArchiveEntry[];
}

interface ExecutionCounts {
  executed: number;
  skipped: number;
  failed: number;
  objects: number;
  tableData: number;
  rows?: number;
  bytes?: number;
  tableDataAttempted: number;
  tableDataCompleted: number;
  tableDataFailed: number;
  copyDurationMilliseconds: number;
  archiveReadDurationMilliseconds: number;
  sequencesAttempted: number;
  sequencesRestored: number;
  sequencesFailed: number;
  indexesCreated: number;
  constraintsCreated: number;
  triggersCreated: number;
  policiesCreated: number;
  ownershipApplied: number;
  ownershipAttempted: number;
  ownershipFailed: number;
  commentsApplied: number;
  commentsAttempted: number;
  commentsFailed: number;
  aclApplied: number;
  aclGrantsApplied: number;
  aclGrantsAttempted: number;
  aclGrantsFailed: number;
  aclRevokesApplied: number;
  aclRevokesAttempted: number;
  aclRevokesFailed: number;
  aclSkipped: number;
  defaultPrivilegesApplied: number;
  defaultPrivilegesAttempted: number;
  defaultPrivilegesFailed: number;
  unresolvedRoles: number;
}

interface FinalizationCounts {
  indexesCreated: number;
  constraintsCreated: number;
  triggersCreated: number;
  policiesCreated: number;
  ownershipApplied: number;
  commentsApplied: number;
  aclApplied: number;
  aclGrantsApplied: number;
  aclRevokesApplied: number;
  defaultPrivilegesApplied: number;
}

function emptyFinalizationCounts(): FinalizationCounts {
  return {
    indexesCreated: 0,
    constraintsCreated: 0,
    triggersCreated: 0,
    policiesCreated: 0,
    ownershipApplied: 0,
    commentsApplied: 0,
    aclApplied: 0,
    aclGrantsApplied: 0,
    aclRevokesApplied: 0,
    defaultPrivilegesApplied: 0,
  };
}

function recordFinalizedObject(
  counts: FinalizationCounts,
  objectType: RestorePlanStep['archiveObjectType'],
): void {
  if (objectType === 'index') counts.indexesCreated += 1;
  else if (objectType === 'constraint' || objectType === 'foreign-key') {
    counts.constraintsCreated += 1;
  } else if (objectType === 'trigger') counts.triggersCreated += 1;
  else if (objectType === 'policy') counts.policiesCreated += 1;
  else if (objectType === 'ownership' || objectType === 'sequence-ownership') {
    counts.ownershipApplied += 1;
  } else if (objectType === 'comment') counts.commentsApplied += 1;
  else if (objectType === 'acl' || objectType === 'default-privilege') {
    counts.aclApplied += 1;
  }
}

function mergeFinalizationCounts(target: FinalizationCounts, source: FinalizationCounts): void {
  target.indexesCreated += source.indexesCreated;
  target.constraintsCreated += source.constraintsCreated;
  target.triggersCreated += source.triggersCreated;
  target.policiesCreated += source.policiesCreated;
  target.ownershipApplied += source.ownershipApplied;
  target.commentsApplied += source.commentsApplied;
  target.aclApplied += source.aclApplied;
  target.aclGrantsApplied += source.aclGrantsApplied;
  target.aclRevokesApplied += source.aclRevokesApplied;
  target.defaultPrivilegesApplied += source.defaultPrivilegesApplied;
}

function recordDedicatedFinalization(
  counts: FinalizationCounts,
  step: Extract<
    RestorePlanStep,
    {
      kind: 'restore-ownership' | 'apply-comment' | 'apply-acl' | 'apply-default-privilege';
    }
  >,
): void {
  recordFinalizedObject(counts, step.archiveObjectType);
  if (step.kind === 'apply-default-privilege') counts.defaultPrivilegesApplied += 1;
  if (step.kind === 'apply-acl' || step.kind === 'apply-default-privilege') {
    if (step.aclAction === 'grant') counts.aclGrantsApplied += 1;
    else counts.aclRevokesApplied += 1;
  }
}

interface ExecutionOutcome {
  readonly status: 'success' | 'partial' | 'failed' | 'cancelled';
  readonly counts: ExecutionCounts;
  readonly partialStateMayRemain: boolean;
}

function isCancellation(cause: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || cause instanceof RestoreCancellationError;
}

function driverErrorFields(cause: unknown): RestoreSqlErrorFields {
  let value = cause;
  let fallbackMessage: string | undefined;
  let fallbackFields: RestoreSqlErrorFields = {};
  for (let depth = 0; depth < 4; depth += 1) {
    if (value === null || typeof value !== 'object') break;
    const record = value as Record<string, unknown>;
    if (fallbackMessage === undefined && typeof record.message === 'string') {
      fallbackMessage = redactSensitiveText(record.message);
    }
    const fields: RestoreSqlErrorFields = {
      ...(typeof record.code === 'string' ? { sqlState: record.code } : {}),
      ...(typeof record.message === 'string'
        ? { serverMessage: redactSensitiveText(record.message) }
        : {}),
      ...(typeof record.detail === 'string' ? { detail: redactSensitiveText(record.detail) } : {}),
      ...(typeof record.hint === 'string' ? { hint: redactSensitiveText(record.hint) } : {}),
      ...(typeof record.position === 'string' ? { position: record.position } : {}),
      ...(typeof record.schema === 'string' ? { schema: record.schema } : {}),
      ...(typeof record.table === 'string' ? { table: record.table } : {}),
      ...(typeof record.column === 'string' ? { column: record.column } : {}),
      ...(typeof record.constraint === 'string' ? { constraint: record.constraint } : {}),
      ...(typeof record.context === 'string'
        ? { context: redactSensitiveText(record.context) }
        : {}),
    };
    const postgresSqlState = fields.sqlState !== undefined && /^[\dA-Z]{5}$/u.test(fields.sqlState);
    if (
      postgresSqlState ||
      fields.detail !== undefined ||
      fields.hint !== undefined ||
      fields.position !== undefined
    ) {
      return fields;
    }
    if (Object.keys(fields).length > 0) fallbackFields = fields;
    value = record.cause;
  }
  if (Object.keys(fallbackFields).length > 0) return fallbackFields;
  return fallbackMessage === undefined ? {} : { serverMessage: fallbackMessage };
}

export class PostgreSqlRestoreEngine {
  readonly #targetInspector: RestoreTargetInspector;
  readonly #preflightAnalyzer: RestorePreflightService;
  readonly #planner: RestorePlanBuilder;
  readonly #clock: () => Date;

  constructor(config: PostgreSqlRestoreEngineConfig = {}) {
    this.#targetInspector = config.targetInspector ?? new QueryRestoreTargetInspector();
    this.#preflightAnalyzer = config.preflightAnalyzer ?? new RestorePreflightAnalyzer();
    this.#planner = config.planner ?? new RestorePlanner();
    this.#clock = config.clock ?? (() => new Date());
  }

  async preflight(request: RestoreRequest): Promise<RestorePreflightReport> {
    let acquired: AcquiredPostgresConnection | undefined;
    try {
      request.signal?.throwIfAborted();
      const archive = await this.loadArchive(request);
      acquired = await acquirePostgresConnection(request.target, request.signal);
      const target = await this.#targetInspector.inspect(acquired.connection, request.signal);
      return this.#preflightAnalyzer.analyze(
        archive.metadata,
        archive.entries,
        target,
        normalizeRestoreOptions(request.options),
      );
    } finally {
      await Promise.allSettled([acquired?.release(), request.archive.close()]);
    }
  }

  async createPlan(request: RestoreRequest): Promise<RestorePlan> {
    let acquired: AcquiredPostgresConnection | undefined;
    try {
      request.signal?.throwIfAborted();
      const archive = await this.loadArchive(request);
      acquired = await acquirePostgresConnection(request.target, request.signal);
      const target = await this.#targetInspector.inspect(acquired.connection, request.signal);
      const options = normalizeRestoreOptions(request.options);
      const preflight = this.#preflightAnalyzer.analyze(
        archive.metadata,
        archive.entries,
        target,
        options,
      );
      return this.#planner.createPlan(archive.metadata, archive.entries, preflight, options);
    } finally {
      await Promise.allSettled([acquired?.release(), request.archive.close()]);
    }
  }

  async restore(request: RestoreRequest): Promise<RestoreResult> {
    const started = this.#clock();
    const diagnostics: RestoreDiagnostic[] = [];
    const counts: ExecutionCounts = {
      executed: 0,
      skipped: 0,
      failed: 0,
      objects: 0,
      tableData: 0,
      tableDataAttempted: 0,
      tableDataCompleted: 0,
      tableDataFailed: 0,
      copyDurationMilliseconds: 0,
      archiveReadDurationMilliseconds: 0,
      sequencesAttempted: 0,
      sequencesRestored: 0,
      sequencesFailed: 0,
      ownershipAttempted: 0,
      ownershipFailed: 0,
      commentsFailed: 0,
      commentsAttempted: 0,
      aclGrantsAttempted: 0,
      aclGrantsFailed: 0,
      aclRevokesAttempted: 0,
      aclRevokesFailed: 0,
      aclSkipped: 0,
      defaultPrivilegesAttempted: 0,
      defaultPrivilegesFailed: 0,
      unresolvedRoles: 0,
      ...emptyFinalizationCounts(),
    };
    let acquired: AcquiredPostgresConnection | undefined;
    let archive: LoadedArchive | undefined;
    let target: RestoreTargetSnapshot | undefined;
    let status: RestoreStatus = 'failed';
    let partialStateMayRemain = false;
    let validation: RestoreValidationSummary = {
      level: normalizeRestoreOptions(request.options).validationLevel,
      checksPerformed: 0,
      checksFailed: 0,
      complete: false,
    };

    try {
      this.emitProgress(request, {
        event: 'restore-started',
        phase: 'initialization',
        timestamp: started.toISOString(),
        message: 'PostgreSQL native restore started.',
      });
      request.signal?.throwIfAborted();
      archive = await this.loadArchive(request);
      this.emitProgress(request, {
        event: 'archive-validated',
        phase: 'archive-validation',
        timestamp: this.timestamp(),
        message: 'Structured restore archive loaded.',
      });

      acquired = await acquirePostgresConnection(request.target, request.signal);
      target = await this.#targetInspector.inspect(acquired.connection, request.signal);
      const options = normalizeRestoreOptions(request.options);
      this.emitProgress(request, {
        event: 'preflight-started',
        phase: 'preflight',
        timestamp: this.timestamp(),
        message: 'Restore preflight started.',
      });
      const preflight = this.#preflightAnalyzer.analyze(
        archive.metadata,
        archive.entries,
        target,
        options,
      );
      counts.unresolvedRoles = preflight.summary.unresolvedRoleCount;
      diagnostics.push(...preflight.diagnostics);
      for (const item of preflight.diagnostics) this.emitDiagnostic(request, item);
      this.emitProgress(request, {
        event: 'preflight-completed',
        phase: 'preflight',
        timestamp: this.timestamp(),
        message: preflight.canProceed
          ? 'Restore preflight completed.'
          : 'Restore preflight found blocking diagnostics.',
      });

      if (!preflight.canProceed) {
        status = 'preflight-failed';
      } else if (options.preflightOnly) {
        status = 'success';
        validation = {
          level: options.validationLevel,
          checksPerformed: 0,
          checksFailed: 0,
          complete: true,
        };
      } else {
        const plan = this.#planner.createPlan(
          archive.metadata,
          archive.entries,
          preflight,
          options,
        );
        this.emitProgress(request, {
          event: 'plan-created',
          phase: 'planning',
          timestamp: this.timestamp(),
          message: 'Restore plan created.',
          totalSteps: plan.steps.length,
        });
        const outcome = await this.executePlan(
          acquired.connection,
          plan,
          options,
          request,
          diagnostics,
        );
        Object.assign(counts, outcome.counts);
        counts.unresolvedRoles = preflight.summary.unresolvedRoleCount;
        status = outcome.status;
        partialStateMayRemain = outcome.partialStateMayRemain;
        validation = {
          level: options.validationLevel,
          checksPerformed:
            options.validationLevel === 'none'
              ? 0
              : Math.max(status === 'success' ? 1 : 0, outcome.counts.sequencesAttempted),
          checksFailed: options.validationLevel === 'none' ? 0 : outcome.counts.sequencesFailed,
          complete: status === 'success',
        };
      }
    } catch (cause) {
      if (isCancellation(cause, request.signal)) {
        status = 'cancelled';
      } else {
        status = cause instanceof RestorePlanningError ? 'preflight-failed' : 'failed';
        diagnostics.push({
          code: 'step-failed',
          severity: 'fatal',
          phase: 'completion',
          message:
            cause instanceof PostgresRestoreError
              ? cause.message
              : 'PostgreSQL native restore failed unexpectedly.',
        });
      }
    } finally {
      const cleanup = await Promise.allSettled([acquired?.release(), request.archive.close()]);
      if (cleanup.some((item) => item.status === 'rejected')) {
        const item: RestoreDiagnostic = {
          code: 'cleanup-failed',
          severity: 'warning',
          phase: 'completion',
          message: 'Restore cleanup could not release every resource cleanly.',
        };
        diagnostics.push(item);
        this.emitDiagnostic(request, item);
      }
    }

    const completed = this.#clock();
    if (status === 'success' || status === 'partial') {
      this.emitProgress(request, {
        event: 'restore-completed',
        phase: 'completion',
        timestamp: completed.toISOString(),
        message:
          status === 'success'
            ? 'PostgreSQL native restore completed.'
            : 'PostgreSQL native restore completed with partial state.',
      });
    } else if (status === 'cancelled') {
      this.emitProgress(request, {
        event: 'restore-cancelled',
        phase: 'completion',
        timestamp: completed.toISOString(),
        message: 'PostgreSQL native restore was cancelled.',
      });
    } else {
      this.emitProgress(request, {
        event: 'restore-failed',
        phase: 'completion',
        timestamp: completed.toISOString(),
        message:
          status === 'preflight-failed'
            ? 'PostgreSQL native restore failed preflight.'
            : 'PostgreSQL native restore failed.',
      });
    }
    return {
      status,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMilliseconds: Math.max(0, completed.getTime() - started.getTime()),
      ...(archive === undefined ? {} : { archiveMetadata: archive.metadata }),
      ...(target === undefined ? {} : { targetVersion: target.version }),
      executedStepCount: counts.executed,
      skippedStepCount: counts.skipped,
      failedStepCount: counts.failed,
      restoredObjectCount: counts.objects,
      restoredTableDataCount: counts.tableData,
      ...(counts.rows === undefined ? {} : { restoredRowCount: counts.rows }),
      ...(counts.bytes === undefined ? {} : { restoredByteCount: counts.bytes }),
      tableDataAttemptedCount: counts.tableDataAttempted,
      tableDataCompletedCount: counts.tableDataCompleted,
      tableDataFailedCount: counts.tableDataFailed,
      copyDurationMilliseconds: counts.copyDurationMilliseconds,
      archiveReadDurationMilliseconds: counts.archiveReadDurationMilliseconds,
      sequencesAttemptedCount: counts.sequencesAttempted,
      sequencesRestoredCount: counts.sequencesRestored,
      sequencesFailedCount: counts.sequencesFailed,
      indexesCreatedCount: counts.indexesCreated,
      constraintsCreatedCount: counts.constraintsCreated,
      triggersCreatedCount: counts.triggersCreated,
      policiesCreatedCount: counts.policiesCreated,
      ownershipStatementsAppliedCount: counts.ownershipApplied,
      ownershipStatementsAttemptedCount: counts.ownershipAttempted,
      ownershipStatementsFailedCount: counts.ownershipFailed,
      commentsAppliedCount: counts.commentsApplied,
      commentsAttemptedCount: counts.commentsAttempted,
      commentsFailedCount: counts.commentsFailed,
      aclOperationsAppliedCount: counts.aclApplied,
      aclGrantOperationsAppliedCount: counts.aclGrantsApplied,
      aclGrantOperationsAttemptedCount: counts.aclGrantsAttempted,
      aclGrantOperationsFailedCount: counts.aclGrantsFailed,
      aclRevokeOperationsAppliedCount: counts.aclRevokesApplied,
      aclRevokeOperationsAttemptedCount: counts.aclRevokesAttempted,
      aclRevokeOperationsFailedCount: counts.aclRevokesFailed,
      aclOperationsSkippedCount: counts.aclSkipped,
      defaultPrivilegeOperationsAppliedCount: counts.defaultPrivilegesApplied,
      defaultPrivilegeOperationsAttemptedCount: counts.defaultPrivilegesAttempted,
      defaultPrivilegeOperationsFailedCount: counts.defaultPrivilegesFailed,
      unresolvedRoleReferenceCount: counts.unresolvedRoles,
      diagnostics,
      validation,
      partialStateMayRemain,
    };
  }

  private async loadArchive(request: RestoreRequest): Promise<LoadedArchive> {
    request.signal?.throwIfAborted();
    const metadata = await request.archive.readMetadata(request.signal);
    const entries: RestoreArchiveEntry[] = [];
    for await (const entry of request.archive.listEntries(request.signal)) {
      entries.push(entry);
    }
    if (metadata.archiveId.length === 0) {
      throw new RestoreArchiveValidationError('Structured restore archive ID must not be empty.');
    }
    return { metadata, entries };
  }

  private async executePlan(
    connection: PostgresConnection,
    plan: RestorePlan,
    options: RestoreOptions,
    request: RestoreRequest,
    diagnostics: RestoreDiagnostic[],
  ): Promise<ExecutionOutcome> {
    const counts: ExecutionCounts = {
      executed: 0,
      skipped: 0,
      failed: 0,
      objects: 0,
      tableData: 0,
      tableDataAttempted: 0,
      tableDataCompleted: 0,
      tableDataFailed: 0,
      copyDurationMilliseconds: 0,
      archiveReadDurationMilliseconds: 0,
      sequencesAttempted: 0,
      sequencesRestored: 0,
      sequencesFailed: 0,
      ownershipAttempted: 0,
      ownershipFailed: 0,
      commentsFailed: 0,
      commentsAttempted: 0,
      aclGrantsAttempted: 0,
      aclGrantsFailed: 0,
      aclRevokesAttempted: 0,
      aclRevokesFailed: 0,
      aclSkipped: 0,
      defaultPrivilegesAttempted: 0,
      defaultPrivilegesFailed: 0,
      unresolvedRoles: 0,
      ...emptyFinalizationCounts(),
    };
    const failedOrSkipped = new Set<string>();
    let transactionActive = false;
    let partialStateMayRemain = false;
    let pendingObjects = 0;
    let pendingTableData = 0;
    let pendingRows = 0;
    let pendingBytes = 0;
    let pendingSequences = 0;
    let pendingFinalization = emptyFinalizationCounts();
    let currentPhase: RestorePhase | undefined;

    try {
      for (const step of plan.steps) {
        request.signal?.throwIfAborted();
        if (currentPhase !== step.phase) {
          if (currentPhase !== undefined) this.emitPhase(request, currentPhase, false);
          currentPhase = step.phase;
          this.emitPhase(request, currentPhase, true);
        }
        if (step.dependencyStepIds.some((id) => failedOrSkipped.has(id))) {
          failedOrSkipped.add(step.stepId);
          counts.skipped += 1;
          const item = this.stepDiagnostic(
            step,
            'step-skipped',
            'warning',
            'A restore step was skipped because one of its dependencies did not complete.',
          );
          diagnostics.push(item);
          this.emitDiagnostic(request, item);
          this.emitStep(request, step, 'step-skipped');
          continue;
        }
        if (step.kind === 'skip-entry') {
          failedOrSkipped.add(step.stepId);
          counts.skipped += 1;
          if (step.archiveObjectType === 'acl' || step.archiveObjectType === 'default-privilege') {
            counts.aclSkipped += 1;
          }
          this.emitStep(request, step, 'step-skipped');
          continue;
        }

        this.emitStep(request, step, 'step-started');
        try {
          if (step.kind === 'begin-transaction') {
            await connection.query({ text: 'BEGIN' }, request.signal);
            transactionActive = true;
          } else if (step.kind === 'commit-transaction') {
            if (transactionActive) {
              await connection.query({ text: 'COMMIT' }, request.signal);
              transactionActive = false;
              counts.objects += pendingObjects;
              counts.tableData += pendingTableData;
              counts.rows = (counts.rows ?? 0) + pendingRows;
              counts.bytes = (counts.bytes ?? 0) + pendingBytes;
              counts.sequencesRestored += pendingSequences;
              mergeFinalizationCounts(counts, pendingFinalization);
              pendingObjects = 0;
              pendingTableData = 0;
              pendingRows = 0;
              pendingBytes = 0;
              pendingSequences = 0;
              pendingFinalization = emptyFinalizationCounts();
            }
          } else if (step.kind === 'rollback-transaction') {
            if (transactionActive) {
              await connection.query({ text: 'ROLLBACK' }, request.signal);
              transactionActive = false;
              pendingObjects = 0;
              pendingTableData = 0;
              pendingRows = 0;
              pendingBytes = 0;
              pendingSequences = 0;
              pendingFinalization = emptyFinalizationCounts();
            }
          } else if (step.kind === 'execute-sql') {
            this.emitPostDataObject(request, step, true);
            await connection.query(
              {
                text: step.operation.sql,
                ...(step.operation.parameters === undefined
                  ? {}
                  : { values: step.operation.parameters }),
              },
              request.signal,
            );
            if (transactionActive) {
              pendingObjects += 1;
              recordFinalizedObject(pendingFinalization, step.archiveObjectType);
            } else {
              counts.objects += 1;
              recordFinalizedObject(counts, step.archiveObjectType);
            }
            this.emitPostDataObject(request, step, false);
          } else if (
            step.kind === 'restore-ownership' ||
            step.kind === 'apply-comment' ||
            step.kind === 'apply-acl' ||
            step.kind === 'apply-default-privilege'
          ) {
            if (step.kind === 'restore-ownership') counts.ownershipAttempted += 1;
            if (step.kind === 'apply-comment') counts.commentsAttempted += 1;
            if (step.kind === 'apply-acl' || step.kind === 'apply-default-privilege') {
              if (step.aclAction === 'grant') counts.aclGrantsAttempted += 1;
              else counts.aclRevokesAttempted += 1;
            }
            if (step.kind === 'apply-default-privilege') {
              counts.defaultPrivilegesAttempted += 1;
            }
            this.emitFinalization(request, step, false);
            let roleWasSet = false;
            try {
              if (step.executeAsRole !== undefined) {
                this.emitFinalization(request, step, false, 'role-switch-started');
                await connection.query(
                  {
                    text: `SET ROLE ${quoteIdentifier(step.executeAsRole, {
                      quoteAllIdentifiers: true,
                    })}`,
                  },
                  request.signal,
                );
                roleWasSet = true;
                this.emitFinalization(request, step, false, 'role-switch-completed');
              }
              for (const statement of step.statements) {
                await connection.query({ text: statement }, request.signal);
              }
            } finally {
              if (roleWasSet) {
                this.emitFinalization(request, step, false, 'role-reset-started');
                await connection.query({ text: 'RESET ROLE' }, request.signal);
                this.emitFinalization(request, step, false, 'role-reset-completed');
              }
            }
            if (transactionActive) {
              pendingObjects += 1;
              recordDedicatedFinalization(pendingFinalization, step);
            } else {
              counts.objects += 1;
              recordDedicatedFinalization(counts, step);
            }
            this.emitFinalization(request, step, true);
          } else if (step.kind === 'restore-sequence-state') {
            counts.sequencesAttempted += 1;
            const identity = sequenceIdentity(step.operation);
            this.emitProgress(request, {
              event: 'sequence-restore-started',
              phase: 'sequence-state',
              timestamp: this.timestamp(),
              stepId: step.stepId,
              archiveEntryId: step.archiveEntryId,
              sequenceIdentity: identity,
              lastValue: step.operation.lastValue,
              isCalled: step.operation.isCalled,
            });
            await connection.query(buildSequenceSetvalQuery(step.operation), request.signal);
            if (transactionActive) {
              pendingObjects += 1;
              pendingSequences += 1;
            } else {
              counts.objects += 1;
              counts.sequencesRestored += 1;
            }
            this.emitProgress(request, {
              event: 'sequence-restore-completed',
              phase: 'sequence-state',
              timestamp: this.timestamp(),
              stepId: step.stepId,
              archiveEntryId: step.archiveEntryId,
              sequenceIdentity: identity,
              lastValue: step.operation.lastValue,
              isCalled: step.operation.isCalled,
            });
          } else if (step.kind === 'load-table-data') {
            counts.tableDataAttempted += 1;
            if (options.rowSecurityMode === 'replica-role') {
              await connection.query(
                { text: `SET LOCAL session_replication_role = 'replica'` },
                request.signal,
              );
            }
            const tableIdentity = `${step.operation.table.schema}.${step.operation.table.table}`;
            const result = await loadCopyText({
              archive: request.archive,
              connection,
              operation: step.operation,
              stepId: step.stepId,
              archiveEntryId: step.archiveEntryId,
              ...(step.objectIdentity === undefined ? {} : { objectIdentity: step.objectIdentity }),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
              onStarted: () => {
                this.emitProgress(request, {
                  event: 'copy-started',
                  phase: step.phase,
                  timestamp: this.timestamp(),
                  stepId: step.stepId,
                  archiveEntryId: step.archiveEntryId,
                  ...(step.objectIdentity === undefined
                    ? {}
                    : { objectIdentity: step.objectIdentity }),
                  currentTable: tableIdentity,
                  bytesRestored: 0,
                  archiveBytesRead: 0,
                  copyBytesWritten: 0,
                  ...(step.operation.estimatedRows === undefined
                    ? {}
                    : { totalRows: step.operation.estimatedRows }),
                  ...(step.operation.estimatedBytes === undefined
                    ? {}
                    : { totalBytes: step.operation.estimatedBytes }),
                  durationMilliseconds: 0,
                });
              },
              onProgress: (progress) => {
                this.emitProgress(request, {
                  event: 'step-progress',
                  phase: step.phase,
                  timestamp: this.timestamp(),
                  stepId: step.stepId,
                  archiveEntryId: step.archiveEntryId,
                  ...(step.objectIdentity === undefined
                    ? {}
                    : { objectIdentity: step.objectIdentity }),
                  description: step.description,
                  rowsRestored: progress.rows,
                  bytesRestored: progress.bytes,
                  archiveBytesRead: progress.bytes,
                  copyBytesWritten: progress.bytes,
                  ...(step.operation.estimatedRows === undefined
                    ? {}
                    : { totalRows: step.operation.estimatedRows }),
                  ...(step.operation.estimatedBytes === undefined
                    ? {}
                    : { totalBytes: step.operation.estimatedBytes }),
                  currentTable: tableIdentity,
                });
              },
            });
            counts.tableDataCompleted += 1;
            counts.copyDurationMilliseconds += result.elapsedMilliseconds;
            counts.archiveReadDurationMilliseconds += result.archiveReadDurationMilliseconds;
            this.emitProgress(request, {
              event: 'copy-completed',
              phase: step.phase,
              timestamp: this.timestamp(),
              stepId: step.stepId,
              archiveEntryId: step.archiveEntryId,
              ...(step.objectIdentity === undefined ? {} : { objectIdentity: step.objectIdentity }),
              currentTable: tableIdentity,
              rowsRestored: result.serverRowCount ?? result.rows,
              bytesRestored: result.bytes,
              archiveBytesRead: result.bytes,
              copyBytesWritten: result.bytes,
              ...(step.operation.estimatedRows === undefined
                ? {}
                : { totalRows: step.operation.estimatedRows }),
              ...(step.operation.estimatedBytes === undefined
                ? {}
                : { totalBytes: step.operation.estimatedBytes }),
              durationMilliseconds: result.elapsedMilliseconds,
            });
            if (transactionActive) {
              pendingTableData += 1;
              pendingRows += result.serverRowCount ?? result.rows;
              pendingBytes += result.bytes;
            } else {
              counts.tableData += 1;
              counts.rows = (counts.rows ?? 0) + (result.serverRowCount ?? result.rows);
              counts.bytes = (counts.bytes ?? 0) + result.bytes;
            }
          }
          counts.executed += 1;
          this.emitStep(request, step, 'step-completed');
        } catch (cause) {
          if (isCancellation(cause, request.signal)) throw toRestoreCancellationError(cause);
          const error = this.stepError(step, cause);
          counts.failed += 1;
          if (step.kind === 'load-table-data') counts.tableDataFailed += 1;
          if (step.kind === 'restore-sequence-state') counts.sequencesFailed += 1;
          if (step.kind === 'restore-ownership') counts.ownershipFailed += 1;
          if (step.kind === 'apply-comment') counts.commentsFailed += 1;
          if (step.kind === 'apply-acl' || step.kind === 'apply-default-privilege') {
            if (step.aclAction === 'grant') counts.aclGrantsFailed += 1;
            else counts.aclRevokesFailed += 1;
          }
          if (step.kind === 'apply-default-privilege') {
            counts.defaultPrivilegesFailed += 1;
          }
          failedOrSkipped.add(step.stepId);
          partialStateMayRemain = counts.objects > 0 || step.kind === 'commit-transaction';
          const baseItem = this.stepDiagnostic(step, 'step-failed', 'error', error.message);
          const item: RestoreDiagnostic =
            error instanceof RestoreSequenceStateError
              ? {
                  ...baseItem,
                  safeDetails: {
                    ...(error.fields.sqlState === undefined
                      ? {}
                      : { sqlState: error.fields.sqlState }),
                    ...(error.fields.serverMessage === undefined
                      ? {}
                      : { serverMessage: error.fields.serverMessage }),
                    sequenceIdentity: error.sequenceIdentity,
                    lastValue: error.attemptedLastValue,
                    isCalled: error.attemptedIsCalled,
                  },
                }
              : baseItem;
          diagnostics.push(item);
          this.emitDiagnostic(request, item);
          if (step.kind === 'restore-sequence-state') {
            this.emitProgress(request, {
              event: 'sequence-restore-failed',
              phase: 'sequence-state',
              timestamp: this.timestamp(),
              stepId: step.stepId,
              archiveEntryId: step.archiveEntryId,
              sequenceIdentity: sequenceIdentity(step.operation),
              lastValue: step.operation.lastValue,
              isCalled: step.operation.isCalled,
            });
          }
          this.emitStep(request, step, 'step-failed');
          if (transactionActive) {
            await this.rollback(connection);
            transactionActive = false;
            pendingObjects = 0;
            pendingTableData = 0;
            pendingRows = 0;
            pendingBytes = 0;
            pendingSequences = 0;
            pendingFinalization = emptyFinalizationCounts();
          }
          if (options.errorMode === 'stop') throw error;
        }
      }
      if (currentPhase !== undefined) this.emitPhase(request, currentPhase, false);
      return {
        status:
          counts.failed > 0
            ? options.errorMode === 'continue' || counts.objects > 0 || counts.tableData > 0
              ? 'partial'
              : 'failed'
            : 'success',
        counts,
        partialStateMayRemain,
      };
    } catch (cause) {
      if (transactionActive) await this.rollback(connection);
      if (isCancellation(cause, request.signal)) {
        return {
          status: 'cancelled',
          counts,
          partialStateMayRemain: counts.objects > 0,
        };
      }
      return {
        status: 'failed',
        counts,
        partialStateMayRemain: partialStateMayRemain || counts.objects > 0,
      };
    }
  }

  private stepError(step: RestorePlanStep, cause: unknown): PostgresRestoreError {
    if (step.kind === 'restore-sequence-state') {
      if (cause instanceof RestoreSequenceStateError) return cause;
      return new RestoreSequenceStateError(
        'PostgreSQL sequence-state restoration failed.',
        step.stepId,
        step.archiveEntryId,
        sequenceIdentity(step.operation),
        step.operation.lastValue,
        step.operation.isCalled,
        'sequence-state',
        safeSqlPreview(
          'SELECT pg_catalog.setval($1::pg_catalog.regclass, $2::pg_catalog.int8, $3::pg_catalog.bool)',
        ),
        driverErrorFields(cause),
        { cause },
      );
    }
    if (cause instanceof PostgresRestoreError) return cause;
    if (step.kind === 'begin-transaction' || step.kind === 'commit-transaction') {
      return new RestoreTransactionError('A PostgreSQL restore transaction command failed.', {
        cause,
      });
    }
    const sql =
      step.kind === 'execute-sql'
        ? step.operation.sql
        : step.kind === 'restore-ownership' ||
            step.kind === 'apply-comment' ||
            step.kind === 'apply-acl' ||
            step.kind === 'apply-default-privilege'
          ? step.statements.join('; ')
          : '';
    return new RestoreSqlExecutionError(
      'A trusted PostgreSQL restore SQL operation failed.',
      step.stepId,
      step.archiveEntryId,
      safeSqlPreview(sql),
      driverErrorFields(cause),
      { cause },
    );
  }

  private async rollback(connection: PostgresConnection): Promise<void> {
    try {
      await connection.query({ text: 'ROLLBACK' });
    } catch (cause) {
      throw new RestoreTransactionError('Failed to roll back the PostgreSQL restore transaction.', {
        cause,
      });
    }
  }

  private stepDiagnostic(
    step: RestorePlanStep,
    code: 'step-failed' | 'step-skipped',
    severity: 'warning' | 'error',
    message: string,
  ): RestoreDiagnostic {
    return {
      code,
      severity,
      phase: step.phase,
      archiveEntryId: step.archiveEntryId,
      ...(step.objectIdentity === undefined ? {} : { objectIdentity: step.objectIdentity }),
      message,
    };
  }

  private emitPhase(request: RestoreRequest, phase: RestorePhase, started: boolean): void {
    this.emitProgress(request, {
      event: started ? 'phase-started' : 'phase-completed',
      phase,
      timestamp: this.timestamp(),
      message: `${phase} phase ${started ? 'started' : 'completed'}.`,
    });
  }

  private emitPostDataObject(
    request: RestoreRequest,
    step: RestorePlanStep,
    started: boolean,
  ): void {
    const event =
      step.archiveObjectType === 'index'
        ? started
          ? 'index-creation-started'
          : 'index-creation-completed'
        : step.archiveObjectType === 'constraint' || step.archiveObjectType === 'foreign-key'
          ? started
            ? 'constraint-creation-started'
            : 'constraint-creation-completed'
          : step.archiveObjectType === 'trigger'
            ? started
              ? 'trigger-creation-started'
              : 'trigger-creation-completed'
            : undefined;
    if (event === undefined) return;
    this.emitProgress(request, {
      event,
      phase: step.phase,
      timestamp: this.timestamp(),
      stepId: step.stepId,
      archiveEntryId: step.archiveEntryId,
      ...(step.objectIdentity === undefined ? {} : { objectIdentity: step.objectIdentity }),
    });
  }

  private emitFinalization(
    request: RestoreRequest,
    step: Extract<
      RestorePlanStep,
      {
        kind: 'restore-ownership' | 'apply-comment' | 'apply-acl' | 'apply-default-privilege';
      }
    >,
    completed: boolean,
    explicitEvent?: RestoreFinalizationProgress['event'],
  ): void {
    const event =
      explicitEvent ??
      (step.kind === 'restore-ownership'
        ? completed
          ? 'ownership-apply-completed'
          : 'ownership-apply-started'
        : step.kind === 'apply-comment'
          ? completed
            ? 'comment-apply-completed'
            : 'comment-apply-started'
          : step.kind === 'apply-default-privilege'
            ? completed
              ? 'default-privilege-apply-completed'
              : 'default-privilege-apply-started'
            : step.aclAction === 'grant'
              ? completed
                ? 'grant-apply-completed'
                : 'grant-apply-started'
              : completed
                ? 'revoke-apply-completed'
                : 'revoke-apply-started');
    this.emitProgress(request, {
      event,
      phase: step.phase,
      timestamp: this.timestamp(),
      stepId: step.stepId,
      archiveEntryId: step.archiveEntryId,
      ...(step.objectIdentity === undefined ? {} : { objectIdentity: step.objectIdentity }),
      ...(explicitEvent?.startsWith('role-') === true && step.executeAsRole !== undefined
        ? { role: step.executeAsRole }
        : {}),
    });
  }

  private emitStep(
    request: RestoreRequest,
    step: RestorePlanStep,
    event: 'step-started' | 'step-completed' | 'step-failed' | 'step-skipped',
  ): void {
    this.emitProgress(request, {
      event,
      phase: step.phase,
      timestamp: this.timestamp(),
      stepId: step.stepId,
      archiveEntryId: step.archiveEntryId,
      ...(step.objectIdentity === undefined ? {} : { objectIdentity: step.objectIdentity }),
      description: step.description,
    });
  }

  private emitDiagnostic(request: RestoreRequest, diagnostic: RestoreDiagnostic): void {
    request.onDiagnostic?.(diagnostic);
    this.emitProgress(request, {
      event: 'diagnostic-emitted',
      phase: diagnostic.phase,
      timestamp: this.timestamp(),
      diagnostic,
    });
  }

  private emitProgress(request: RestoreRequest, event: RestoreProgressEvent): void {
    request.onProgress?.(event);
    request.logger?.log({
      event: event.event,
      timestamp: event.timestamp,
      phase: event.phase,
      ...('stepId' in event ? { stepId: event.stepId } : {}),
      ...('archiveEntryId' in event ? { archiveEntryId: event.archiveEntryId } : {}),
      ...('objectIdentity' in event && event.objectIdentity !== undefined
        ? { objectIdentity: event.objectIdentity }
        : {}),
    });
  }

  private timestamp(): string {
    return this.#clock().toISOString();
  }
}

export function createRestoreEngine(
  config: PostgreSqlRestoreEngineConfig = {},
): PostgreSqlRestoreEngine {
  return new PostgreSqlRestoreEngine(config);
}

export function preflightRestore(request: RestoreRequest): Promise<RestorePreflightReport> {
  return createRestoreEngine().preflight(request);
}
