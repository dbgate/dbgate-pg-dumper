import type { Readable } from 'node:stream';

import {
  acquirePostgresConnection,
  type PostgresConnectionInput,
} from '../connection/PostgresConnection.js';
import { redactSensitiveText } from '../security/SensitiveValuePolicy.js';
import { loadCopyTextStream } from './CopyTextLoader.js';
import {
  RestoreCancellationError,
  RestoreCopyLoadError,
  SqlDumpRestoreError,
  safeSqlPreview,
  type RestoreSqlErrorFields,
} from './RestoreErrors.js';
import { SqlDumpReader, type SqlDumpLocation, type SqlDumpReaderOptions } from './SqlDumpReader.js';
import type { PostgresRestoreConnection } from './RestoreTarget.js';

export interface SqlDumpRestoreOptions extends SqlDumpReaderOptions {
  /** Stop at the first SQL or COPY execution error. Defaults to true. */
  readonly stopOnError?: boolean;
  /** Roll back an active dump transaction after an error or cancellation. Defaults to true. */
  readonly rollbackOnError?: boolean;
  /** Minimum interval between intermediate progress events. Defaults to 1 second. */
  readonly progressThrottleMilliseconds?: number;
}

export type SqlDumpRestoreProgressPhase =
  | 'started'
  | 'statement-started'
  | 'statement-completed'
  | 'copy-started'
  | 'copy-progress'
  | 'copy-completed'
  | 'completed';

export interface SqlDumpRestoreProgress {
  readonly phase: SqlDumpRestoreProgressPhase;
  readonly bytesRead: number;
  readonly line: number;
  readonly column: number;
  readonly operationNumber: number;
  readonly operationsCompleted: number;
  readonly statementsCompleted: number;
  readonly copyBlocksCompleted: number;
  readonly copyBytesWritten: number;
  readonly rowsRestored: number;
  readonly objectIdentity?: string;
  readonly elapsedMilliseconds: number;
}

export type SqlDumpRestoreProgressCallback = (progress: SqlDumpRestoreProgress) => void;

export interface SqlDumpRestoreRequest {
  readonly source: Readable;
  readonly connection: PostgresConnectionInput;
  readonly options?: SqlDumpRestoreOptions;
  readonly progress?: SqlDumpRestoreProgressCallback;
  readonly signal?: AbortSignal;
}

export interface SqlDumpRestoreResult {
  readonly status: 'success' | 'completed-with-errors';
  readonly bytesRead: number;
  readonly operationsCompleted: number;
  readonly operationsFailed: number;
  readonly statementsCompleted: number;
  readonly copyBlocksCompleted: number;
  readonly copyBytesWritten: number;
  readonly rowsRestored: number;
  readonly errors: readonly SqlDumpRestoreError[];
  readonly elapsedMilliseconds: number;
}

function sqlErrorFields(cause: unknown): RestoreSqlErrorFields {
  let value = cause;
  for (let depth = 0; depth < 6; depth += 1) {
    if (value === null || typeof value !== 'object') break;
    const record = value as Record<string, unknown>;
    const safe = (field: string): string | undefined =>
      typeof record[field] === 'string' ? redactSensitiveText(record[field]) : undefined;
    const fields: RestoreSqlErrorFields = {
      ...(safe('code') === undefined ? {} : { sqlState: safe('code')! }),
      ...(safe('message') === undefined ? {} : { serverMessage: safe('message')! }),
      ...(safe('detail') === undefined ? {} : { detail: safe('detail')! }),
      ...(safe('hint') === undefined ? {} : { hint: safe('hint')! }),
      ...(safe('position') === undefined ? {} : { position: safe('position')! }),
      ...(safe('schema') === undefined ? {} : { schema: safe('schema')! }),
      ...(safe('table') === undefined ? {} : { table: safe('table')! }),
      ...(safe('column') === undefined ? {} : { column: safe('column')! }),
      ...(safe('constraint') === undefined ? {} : { constraint: safe('constraint')! }),
      ...(safe('context') === undefined ? {} : { context: safe('context')! }),
    };
    if (Object.keys(fields).length > 0) return fields;
    value = record.cause;
  }
  return {};
}

function serverErrorLocation(
  start: SqlDumpLocation,
  sql: string,
  position: string | undefined,
): SqlDumpLocation {
  const characterPosition = Number(position);
  if (!Number.isSafeInteger(characterPosition) || characterPosition <= 1) return start;
  const prefix = Array.from(sql)
    .slice(0, characterPosition - 1)
    .join('');
  const bytes = Buffer.from(prefix, 'utf8');
  let line = start.line;
  let column = start.column;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { offset: start.offset + bytes.length, line, column };
}

async function rollbackActiveTransaction(
  connection: PostgresRestoreConnection,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  try {
    const status = await connection.getTransactionStatus();
    if (status === 'in-transaction' || status === 'failed') {
      await connection.query({ text: 'ROLLBACK' });
    }
  } catch {
    // Preserve the original restore error. A broken connection cannot be cleaned further.
  }
}

function positiveProgressInterval(value: number | undefined): number {
  const interval = value ?? 1_000;
  if (!Number.isFinite(interval) || interval < 0) {
    throw new RangeError('progressThrottleMilliseconds must be a non-negative finite number.');
  }
  return interval;
}

function startsWithInsert(sql: string): boolean {
  let offset = 0;
  while (offset < sql.length) {
    const whitespace = /^\s+/u.exec(sql.slice(offset));
    if (whitespace !== null) {
      offset += whitespace[0].length;
      continue;
    }
    if (sql.startsWith('--', offset)) {
      const newline = sql.indexOf('\n', offset + 2);
      offset = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', offset)) {
      const end = sql.indexOf('*/', offset + 2);
      if (end < 0) return false;
      offset = end + 2;
      continue;
    }
    break;
  }
  return /^INSERT\b/iu.test(sql.slice(offset));
}

const TRANSACTION_CONTROL_STATEMENT =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;
const RESTORE_SAVEPOINT = 'dbgate_restore_operation';

function isTransactionControlStatement(sql: string): boolean {
  return TRANSACTION_CONTROL_STATEMENT.test(sql.trimStart());
}

async function recoverFailedOperation(
  connection: PostgresRestoreConnection,
  usedSavepoint: boolean,
): Promise<boolean> {
  try {
    if (usedSavepoint) {
      await connection.query({ text: `ROLLBACK TO SAVEPOINT ${RESTORE_SAVEPOINT}` });
      await connection.query({ text: `RELEASE SAVEPOINT ${RESTORE_SAVEPOINT}` });
      return true;
    }
    const status = await connection.getTransactionStatus();
    if (status === 'failed' || status === 'in-transaction') {
      await connection.query({ text: 'ROLLBACK' });
    }
    return status !== 'unknown';
  } catch {
    return false;
  }
}

/**
 * Restores supported sequential dbgate-pg-dumper and pg_dump plain-SQL formats.
 *
 * No dependency graph, target mapping, clean planning, or archive metadata is
 * inferred from the sequential SQL input.
 */
export async function restoreSqlDump(
  request: SqlDumpRestoreRequest,
): Promise<SqlDumpRestoreResult> {
  const started = performance.now();
  const stopOnError = request.options?.stopOnError ?? true;
  const progressThrottleMilliseconds = positiveProgressInterval(
    request.options?.progressThrottleMilliseconds,
  );
  const reader = new SqlDumpReader(request.source, request.options, request.signal);
  let acquired: Awaited<ReturnType<typeof acquirePostgresConnection>> | undefined;
  let connection: PostgresRestoreConnection | undefined;
  let operationNumber = 0;
  let operationsCompleted = 0;
  let operationsFailed = 0;
  let statementsCompleted = 0;
  let copyBlocksCompleted = 0;
  let copyBytesWritten = 0;
  let rowsRestored = 0;
  const errors: SqlDumpRestoreError[] = [];
  let activeLocation: SqlDumpLocation = reader.location;
  let activeSql: string | undefined;
  let lastIntermediateProgress = started;

  const emit = (
    phase: SqlDumpRestoreProgressPhase,
    overrides: Partial<SqlDumpRestoreProgress> = {},
  ): void => {
    if (request.progress === undefined) return;
    const now = performance.now();
    const lifecycleEvent = phase === 'started' || phase === 'completed';
    if (!lifecycleEvent && now - lastIntermediateProgress < progressThrottleMilliseconds) {
      return;
    }
    if (phase === 'started' || !lifecycleEvent) lastIntermediateProgress = now;
    const location = reader.location;
    request.progress({
      phase,
      bytesRead: location.offset,
      line: location.line,
      column: location.column,
      operationNumber,
      operationsCompleted,
      statementsCompleted,
      copyBlocksCompleted,
      copyBytesWritten,
      rowsRestored,
      elapsedMilliseconds: now - started,
      ...overrides,
    });
  };

  try {
    request.signal?.throwIfAborted();
    acquired = await acquirePostgresConnection(request.connection, request.signal);
    connection = acquired.connection;
    emit('started');

    while (true) {
      request.signal?.throwIfAborted();
      const operation = await reader.nextOperation();
      if (operation === undefined) break;
      operationNumber += 1;
      activeLocation = operation.start;
      activeSql = operation.sql;
      let usedSavepoint = false;

      if (!stopOnError && !isTransactionControlStatement(operation.sql)) {
        const transactionStatus = await connection.getTransactionStatus(request.signal);
        if (transactionStatus === 'in-transaction') {
          await connection.query({ text: `SAVEPOINT ${RESTORE_SAVEPOINT}` }, request.signal);
          usedSavepoint = true;
        }
      }

      const rowsBeforeOperation = rowsRestored;
      try {
        if (operation.kind === 'sql') {
          emit('statement-started', {
            bytesRead: operation.start.offset,
            line: operation.start.line,
            column: operation.start.column,
          });
          try {
            const result = await connection.query({ text: operation.sql }, request.signal);
            if (startsWithInsert(operation.sql)) rowsRestored += result.rowCount;
          } catch (cause) {
            if (request.signal?.aborted) throw cause;
            const fields = sqlErrorFields(cause);
            const failure = serverErrorLocation(operation.start, operation.sql, fields.position);
            throw new SqlDumpRestoreError(
              'RESTORE_SQL_FAILED',
              `SQL dump statement ${operationNumber} failed at line ${failure.line}.`,
              failure.offset,
              failure.line,
              failure.column,
              operationNumber,
              safeSqlPreview(operation.sql),
              fields,
              { cause },
            );
          }
          if (usedSavepoint) {
            await connection.query(
              { text: `RELEASE SAVEPOINT ${RESTORE_SAVEPOINT}` },
              request.signal,
            );
          }
          operationsCompleted += 1;
          statementsCompleted += 1;
          emit('statement-completed');
          continue;
        }

        const objectIdentity = `${operation.table.schema}.${operation.table.table}`;
        const completedCopyBytes = copyBytesWritten;
        emit('copy-started', {
          bytesRead: operation.dataStart.offset,
          line: operation.dataStart.line,
          column: operation.dataStart.column,
          objectIdentity,
        });
        try {
          const result = await loadCopyTextStream({
            source: operation.payload,
            connection,
            copyCommand: operation.copyCommand,
            operationId: `sql-dump-operation-${operationNumber}`,
            objectIdentity,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            onProgress: (progress) => {
              copyBytesWritten = completedCopyBytes + progress.bytes;
              rowsRestored = rowsBeforeOperation + progress.rows;
              emit('copy-progress', { objectIdentity });
            },
          });
          copyBytesWritten = completedCopyBytes + result.bytes;
          rowsRestored = rowsBeforeOperation + result.rows;
        } catch (cause) {
          if (request.signal?.aborted) throw cause;
          const copy =
            cause instanceof RestoreCopyLoadError
              ? cause
              : new RestoreCopyLoadError(
                  'PostgreSQL COPY FROM STDIN table-data restore failed.',
                  `sql-dump-operation-${operationNumber}`,
                  objectIdentity,
                  safeSqlPreview(operation.copyCommand),
                  0,
                  undefined,
                  sqlErrorFields(cause),
                  { cause },
                );
          throw new SqlDumpRestoreError(
            'RESTORE_COPY_FAILED',
            `SQL dump COPY operation ${operationNumber} failed near line ${reader.location.line}.${
              copy.fields.serverMessage === undefined ? '' : ` ${copy.fields.serverMessage}`
            }`,
            reader.location.offset,
            reader.location.line,
            reader.location.column,
            operationNumber,
            safeSqlPreview(operation.copyCommand),
            copy.fields,
            { cause: copy },
          );
        }
        if (usedSavepoint) {
          await connection.query(
            { text: `RELEASE SAVEPOINT ${RESTORE_SAVEPOINT}` },
            request.signal,
          );
        }
        operationsCompleted += 1;
        copyBlocksCompleted += 1;
        emit('copy-completed', { objectIdentity });
      } catch (cause) {
        if (request.signal?.aborted) throw cause;
        const error =
          cause instanceof SqlDumpRestoreError
            ? cause
            : new SqlDumpRestoreError(
                'RESTORE_SQL_DUMP_INVALID',
                `SQL dump restore failed at line ${activeLocation.line}.`,
                activeLocation.offset,
                activeLocation.line,
                activeLocation.column,
                operationNumber,
                safeSqlPreview(operation.sql),
                sqlErrorFields(cause),
                { cause },
              );
        if (stopOnError) throw error;

        rowsRestored = rowsBeforeOperation;
        if (operation.kind === 'copy') {
          await reader.discardCopyPayloadRemainder();
        }
        errors.push(error);
        operationsFailed += 1;
        if (!(await recoverFailedOperation(connection, usedSavepoint))) throw error;
      }
    }

    emit('completed');
    return {
      status: errors.length === 0 ? 'success' : 'completed-with-errors',
      bytesRead: reader.location.offset,
      operationsCompleted,
      operationsFailed,
      statementsCompleted,
      copyBlocksCompleted,
      copyBytesWritten,
      rowsRestored,
      errors,
      elapsedMilliseconds: performance.now() - started,
    };
  } catch (cause) {
    if (connection !== undefined) {
      if (request.signal?.aborted) await connection.cancel?.().catch(() => undefined);
      await rollbackActiveTransaction(connection, request.options?.rollbackOnError ?? true);
    }
    if (request.signal?.aborted) {
      throw new RestoreCancellationError('PostgreSQL SQL dump restore was cancelled.', { cause });
    }
    if (cause instanceof SqlDumpRestoreError) throw cause;
    throw new SqlDumpRestoreError(
      'RESTORE_SQL_DUMP_INVALID',
      `SQL dump restore failed at line ${activeLocation.line}.`,
      activeLocation.offset,
      activeLocation.line,
      activeLocation.column,
      operationNumber === 0 ? undefined : operationNumber,
      activeSql === undefined ? undefined : safeSqlPreview(activeSql),
      sqlErrorFields(cause),
      { cause },
    );
  } finally {
    await Promise.allSettled([reader.close(), acquired?.release()]);
  }
}
