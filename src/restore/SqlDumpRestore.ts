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
  /** Roll back an active dump transaction after an error or cancellation. Defaults to true. */
  readonly rollbackOnError?: boolean;
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
  readonly status: 'success';
  readonly bytesRead: number;
  readonly operationsCompleted: number;
  readonly statementsCompleted: number;
  readonly copyBlocksCompleted: number;
  readonly copyBytesWritten: number;
  readonly rowsRestored: number;
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

/**
 * Restores supported sequential dbgate-pg-dumper and pg_dump plain-SQL formats.
 *
 * This is deliberately separate from RestoreArchiveSource: no dependency graph,
 * target mapping, clean planning, or structured archive metadata is inferred.
 */
export async function restoreSqlDump(
  request: SqlDumpRestoreRequest,
): Promise<SqlDumpRestoreResult> {
  const started = performance.now();
  const reader = new SqlDumpReader(request.source, request.options, request.signal);
  let acquired: Awaited<ReturnType<typeof acquirePostgresConnection>> | undefined;
  let connection: PostgresRestoreConnection | undefined;
  let operationNumber = 0;
  let operationsCompleted = 0;
  let statementsCompleted = 0;
  let copyBlocksCompleted = 0;
  let copyBytesWritten = 0;
  let rowsRestored = 0;
  let activeLocation: SqlDumpLocation = reader.location;
  let activeSql: string | undefined;

  const emit = (
    phase: SqlDumpRestoreProgressPhase,
    overrides: Partial<SqlDumpRestoreProgress> = {},
  ): void => {
    const location = reader.location;
    request.progress?.({
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
      elapsedMilliseconds: performance.now() - started,
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

      if (operation.kind === 'sql') {
        emit('statement-started', {
          bytesRead: operation.start.offset,
          line: operation.start.line,
          column: operation.start.column,
        });
        try {
          await connection.query({ text: operation.sql }, request.signal);
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
        operationsCompleted += 1;
        statementsCompleted += 1;
        emit('statement-completed');
        continue;
      }

      const objectIdentity = `${operation.table.schema}.${operation.table.table}`;
      const completedCopyBytes = copyBytesWritten;
      const completedCopyRows = rowsRestored;
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
          endMarker: 'absent',
          stepId: `sql-dump-operation-${operationNumber}`,
          archiveEntryId: `sql-dump-operation-${operationNumber}`,
          objectIdentity,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          onProgress: (progress) => {
            copyBytesWritten = completedCopyBytes + progress.bytes;
            rowsRestored = completedCopyRows + progress.rows;
            emit('copy-progress', { objectIdentity });
          },
        });
        copyBytesWritten = completedCopyBytes + result.bytes;
        rowsRestored = completedCopyRows + result.rows;
      } catch (cause) {
        if (request.signal?.aborted) throw cause;
        const copy =
          cause instanceof RestoreCopyLoadError
            ? cause
            : new RestoreCopyLoadError(
                'PostgreSQL COPY FROM STDIN table-data restore failed.',
                `sql-dump-operation-${operationNumber}`,
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
      operationsCompleted += 1;
      copyBlocksCompleted += 1;
      emit('copy-completed', { objectIdentity });
    }

    emit('completed');
    return {
      status: 'success',
      bytesRead: reader.location.offset,
      operationsCompleted,
      statementsCompleted,
      copyBlocksCompleted,
      copyBytesWritten,
      rowsRestored,
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
