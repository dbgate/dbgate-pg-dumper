import type { PostgresConnection } from '../connection/PostgresConnection.js';
import {
  acquirePostgresConnection,
  type AcquiredPostgresConnection,
} from '../connection/PostgresConnection.js';
import { quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import { redactSensitiveText } from '../security/SensitiveValuePolicy.js';
import type { RestoreArchiveEntry, RestoreArchiveMetadata } from './RestoreArchive.js';
import {
  PostgresRestoreError,
  RestoreArchiveValidationError,
  RestoreCancellationError,
  RestoreCopyLoadError,
  RestorePlanningError,
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
  type RestoreOptions,
  type RestorePhase,
  type RestoreProgressEvent,
  type RestoreRequest,
  type RestoreResult,
  type RestoreStatus,
  type RestoreValidationSummary,
} from './RestoreTypes.js';

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
    };
    if (
      fields.sqlState !== undefined ||
      fields.detail !== undefined ||
      fields.hint !== undefined ||
      fields.position !== undefined
    ) {
      return fields;
    }
    value = record.cause;
  }
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
        status = outcome.status;
        partialStateMayRemain = outcome.partialStateMayRemain;
        validation = {
          level: options.validationLevel,
          checksPerformed: status === 'success' && options.validationLevel !== 'none' ? 1 : 0,
          checksFailed: 0,
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
    };
    const failedOrSkipped = new Set<string>();
    let transactionActive = false;
    let partialStateMayRemain = false;
    let pendingObjects = 0;
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
              pendingObjects = 0;
            }
          } else if (step.kind === 'rollback-transaction') {
            if (transactionActive) {
              await connection.query({ text: 'ROLLBACK' }, request.signal);
              transactionActive = false;
              pendingObjects = 0;
            }
          } else if (step.kind === 'execute-sql') {
            await connection.query(
              {
                text: step.operation.sql,
                ...(step.operation.parameters === undefined
                  ? {}
                  : { values: step.operation.parameters }),
              },
              request.signal,
            );
            if (transactionActive) pendingObjects += 1;
            else counts.objects += 1;
          } else if (step.kind === 'restore-sequence-state') {
            const identity = quoteQualifiedIdentifier([
              step.operation.schema,
              step.operation.sequence,
            ]);
            await connection.query(
              {
                text: 'SELECT pg_catalog.setval($1::regclass, $2::bigint, $3::boolean)',
                values: [identity, step.operation.lastValue, step.operation.isCalled],
              },
              request.signal,
            );
            if (transactionActive) pendingObjects += 1;
            else counts.objects += 1;
          } else if (step.kind === 'load-table-data') {
            throw new RestoreCopyLoadError(
              'Native COPY FROM STDIN table-data restore is not implemented.',
            );
          }
          counts.executed += 1;
          this.emitStep(request, step, 'step-completed');
        } catch (cause) {
          if (isCancellation(cause, request.signal)) throw toRestoreCancellationError(cause);
          const error = this.stepError(step, cause);
          counts.failed += 1;
          failedOrSkipped.add(step.stepId);
          partialStateMayRemain = counts.objects > 0 || step.kind === 'commit-transaction';
          const item = this.stepDiagnostic(step, 'step-failed', 'error', error.message);
          diagnostics.push(item);
          this.emitDiagnostic(request, item);
          if (transactionActive) {
            await this.rollback(connection);
            transactionActive = false;
            pendingObjects = 0;
          }
          if (options.errorMode === 'stop') throw error;
        }
      }
      if (currentPhase !== undefined) this.emitPhase(request, currentPhase, false);
      return {
        status: counts.failed > 0 ? (counts.objects > 0 ? 'partial' : 'failed') : 'success',
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
    if (cause instanceof PostgresRestoreError) return cause;
    if (step.kind === 'begin-transaction' || step.kind === 'commit-transaction') {
      return new RestoreTransactionError('A PostgreSQL restore transaction command failed.', {
        cause,
      });
    }
    const sql =
      step.kind === 'execute-sql'
        ? step.operation.sql
        : step.kind === 'restore-sequence-state'
          ? 'SELECT pg_catalog.setval(...)'
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

  private emitStep(
    request: RestoreRequest,
    step: RestorePlanStep,
    event: 'step-started' | 'step-completed' | 'step-skipped',
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
