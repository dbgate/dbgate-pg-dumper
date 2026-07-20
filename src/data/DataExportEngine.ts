/**
 * Sequential, snapshot-safe, format-neutral table data export.
 *
 * The engine applies natural backpressure by yielding one bounded batch at a
 * time. It neither writes output nor understands COPY/INSERT/CSV/JSON syntax.
 */

import type { PostgresConnection, PostgresRow } from '../connection/PostgresConnection.js';
import { CancellationError, DataExportError } from '../utils/errors.js';
import { PostgresValueNormalizer } from './PostgresValueNormalizer.js';
import { streamTableRows } from './TableCursor.js';
import type {
  DataExportBatch,
  DataExportDiagnostic,
  DataExportPlan,
  DataExportProgressCallback,
  DataExportResult,
  NormalizedDataRow,
  PlannedTableExport,
} from './DataExportTypes.js';

export interface DataExportRequest {
  readonly connection: PostgresConnection;
  readonly plan: DataExportPlan;
  readonly onProgress?: DataExportProgressCallback;
  readonly signal?: AbortSignal;
  readonly bestEffort?: boolean;
  readonly onRecoverableTableError?: (diagnostic: DataExportDiagnostic) => void | Promise<void>;
}

export type DataExportBatchConsumer = (batch: DataExportBatch) => void | Promise<void>;

class RecoverableBatchConsumerFailure extends Error {
  constructor(
    readonly diagnostic: DataExportDiagnostic,
    options: ErrorOptions,
  ) {
    super(diagnostic.message, options);
  }
}

export class DataExportEngine {
  constructor(private readonly normalizer = new PostgresValueNormalizer()) {}

  async export(
    request: DataExportRequest,
    consume: DataExportBatchConsumer,
  ): Promise<DataExportResult> {
    const stream = this.stream(request);
    let next = await stream.next();
    while (true) {
      if (next.done) return next.value;
      const batch = next.value;
      try {
        await consume(batch);
        next = await stream.next();
      } catch (cause) {
        const diagnostic: DataExportDiagnostic = {
          code: 'failed-batch',
          severity: 'error',
          message: 'The data export batch consumer failed.',
          tableIdentity: `${batch.table.schema}.${batch.table.name}`,
          batchNumber: batch.batchNumber,
          cause,
        };
        if (request.bestEffort) {
          await request.onRecoverableTableError?.(diagnostic);
          next = await stream.throw(new RecoverableBatchConsumerFailure(diagnostic, { cause }));
          continue;
        }
        await stream.return(this.result(0, 0, 0, 0, performance.now(), [], false));
        throw new DataExportError(diagnostic.message, diagnostic, { cause });
      }
    }
  }

  async *stream(request: DataExportRequest): AsyncGenerator<DataExportBatch, DataExportResult> {
    const started = performance.now();
    const diagnostics: DataExportDiagnostic[] = [...request.plan.diagnostics];
    let tablesCompleted = 0;
    let rowsExported = 0;
    let batchesExported = 0;
    let bytesRead = 0;
    const progress = (
      phase: Parameters<NonNullable<DataExportProgressCallback>>[0]['phase'],
      message: string,
      table: PlannedTableExport | undefined,
      batchNumber?: number,
    ): void => {
      request.onProgress?.({
        phase,
        message,
        ...(table === undefined ? {} : { tableIdentity: table.tableIdentity }),
        rowsProcessed: rowsExported,
        ...(table === undefined ? {} : { estimatedRows: table.descriptor.estimatedRowCount }),
        bytesRead,
        elapsedMilliseconds: performance.now() - started,
        ...(batchNumber === undefined ? {} : { batchNumber }),
      });
    };

    progress('preparing', 'Preparing table data export.', undefined);
    if (request.signal?.aborted) {
      diagnostics.push({
        code: 'cancelled-export',
        severity: 'warning',
        message: 'Table data export was cancelled before reading began.',
      });
      return this.result(0, 0, 0, 0, started, diagnostics, true);
    }
    let initialStatus;
    try {
      initialStatus = await request.connection.getTransactionStatus(request.signal);
    } catch (cause) {
      if (request.signal?.aborted || cause instanceof CancellationError) {
        diagnostics.push({
          code: 'cancelled-export',
          severity: 'warning',
          message: 'Table data export was cancelled before reading began.',
          cause,
        });
        return this.result(0, 0, 0, 0, started, diagnostics, true);
      }
      const diagnostic: DataExportDiagnostic = {
        code: 'inconsistent-snapshot',
        severity: 'error',
        message: 'The active dump transaction could not be verified.',
        cause,
      };
      throw new DataExportError(diagnostic.message, diagnostic, { cause });
    }
    if (initialStatus !== 'in-transaction') {
      const diagnostic: DataExportDiagnostic = {
        code: 'inconsistent-snapshot',
        severity: 'error',
        message: 'Data export requires one already-active dump transaction.',
      };
      throw new DataExportError(diagnostic.message, diagnostic);
    }
    if (request.plan.requiresRowSecurityDisable) {
      try {
        await request.connection.query({ text: 'SET LOCAL row_security = off' }, request.signal);
      } catch (cause) {
        const diagnostic: DataExportDiagnostic = {
          code: 'permission-failure',
          severity: 'error',
          message: 'The dump session could not disable PostgreSQL row security.',
          cause,
        };
        throw new DataExportError(diagnostic.message, diagnostic, { cause });
      }
    }

    for (const table of request.plan.tables) {
      if (request.signal?.aborted) {
        diagnostics.push(this.cancelled(table));
        return this.result(
          tablesCompleted,
          rowsExported,
          batchesExported,
          bytesRead,
          started,
          diagnostics,
          true,
        );
      }
      progress('table-starting', `Starting ${table.tableIdentity}.`, table);
      let tableRows = 0;
      let batchRows: NormalizedDataRow[] = [];
      let batchBytes = 0;
      const unknownColumns = new Set<string>();

      try {
        for await (const row of streamTableRows(request.connection, table, request.signal)) {
          if (request.signal?.aborted) {
            throw new CancellationError('Table data export was cancelled.');
          }
          const normalized = this.normalizeRow(
            row,
            table,
            diagnostics,
            unknownColumns,
            batchesExported + 1,
          );
          batchRows.push(normalized.row);
          batchBytes += normalized.bytesRead;
          tableRows += 1;

          if (batchRows.length >= table.batchSize) {
            batchesExported += 1;
            rowsExported += batchRows.length;
            bytesRead += batchBytes;
            const batch: DataExportBatch = {
              table: table.descriptor,
              batchNumber: batchesExported,
              firstRowNumber: rowsExported - batchRows.length + 1,
              rows: batchRows,
              bytesRead: batchBytes,
            };
            progress(
              'batch-exported',
              `Exported batch ${batchesExported}.`,
              table,
              batchesExported,
            );
            progress('rows-exported', `Exported ${rowsExported} rows.`, table, batchesExported);
            yield batch;
            batchRows = [];
            batchBytes = 0;
          }
        }

        if (batchRows.length > 0) {
          batchesExported += 1;
          rowsExported += batchRows.length;
          bytesRead += batchBytes;
          const batch: DataExportBatch = {
            table: table.descriptor,
            batchNumber: batchesExported,
            firstRowNumber: rowsExported - batchRows.length + 1,
            rows: batchRows,
            bytesRead: batchBytes,
          };
          progress('batch-exported', `Exported batch ${batchesExported}.`, table, batchesExported);
          progress('rows-exported', `Exported ${rowsExported} rows.`, table, batchesExported);
          yield batch;
        }

        const status = await request.connection.getTransactionStatus(request.signal);
        if (status !== 'in-transaction') {
          const diagnostic: DataExportDiagnostic = {
            code: 'inconsistent-snapshot',
            severity: 'error',
            message: 'The dump transaction ended while table data was being exported.',
            tableIdentity: table.tableIdentity,
          };
          throw new DataExportError(diagnostic.message, diagnostic);
        }
        tablesCompleted += 1;
        progress('table-completed', `Completed ${table.tableIdentity} (${tableRows} rows).`, table);
      } catch (cause) {
        if (request.signal?.aborted || cause instanceof CancellationError) {
          diagnostics.push(this.cancelled(table, cause));
          return this.result(
            tablesCompleted,
            rowsExported,
            batchesExported,
            bytesRead,
            started,
            diagnostics,
            true,
          );
        }
        if (cause instanceof DataExportError && !request.bestEffort) throw cause;
        const diagnostic: DataExportDiagnostic =
          cause instanceof RecoverableBatchConsumerFailure
            ? cause.diagnostic
            : {
                code: this.isPermissionFailure(cause) ? 'permission-failure' : 'cursor-failure',
                severity: 'error',
                message: this.isPermissionFailure(cause)
                  ? 'Permission was denied while reading table data.'
                  : 'The table cursor failed while reading data.',
                tableIdentity: table.tableIdentity,
                batchNumber: batchesExported + 1,
                cause,
              };
        if (request.bestEffort) {
          diagnostics.push(diagnostic);
          if (!(cause instanceof RecoverableBatchConsumerFailure)) {
            await request.onRecoverableTableError?.(diagnostic);
          }
          continue;
        }
        throw new DataExportError(diagnostic.message, diagnostic, { cause });
      }
    }

    progress('completed', `Exported ${rowsExported} rows.`, undefined);
    return this.result(
      tablesCompleted,
      rowsExported,
      batchesExported,
      bytesRead,
      started,
      diagnostics,
      false,
    );
  }

  private normalizeRow(
    row: PostgresRow,
    table: PlannedTableExport,
    diagnostics: DataExportDiagnostic[],
    unknownColumns: Set<string>,
    batchNumber: number,
  ): { readonly row: NormalizedDataRow; readonly bytesRead: number } {
    let bytesRead = 0;
    const values = table.descriptor.columns.map((column) => {
      if (!Object.hasOwn(row, column.name)) {
        diagnostics.push({
          code: 'truncated-driver-value',
          severity: 'warning',
          message: 'The driver row did not contain an expected exported column.',
          tableIdentity: table.tableIdentity,
          columnName: column.name,
          batchNumber,
        });
      }
      const raw = row[column.name];
      try {
        const value = this.normalizer.normalize(raw, column, table.descriptor.valueReadStrategy);
        bytesRead += this.valueBytes(raw);
        if (
          value.kind === 'unknown' &&
          value.representation !== 'canonical-text' &&
          !unknownColumns.has(column.name)
        ) {
          unknownColumns.add(column.name);
          diagnostics.push({
            code: 'unsupported-type',
            severity: 'warning',
            message: `PostgreSQL type ${column.formattedType} has no specialized normalizer.`,
            tableIdentity: table.tableIdentity,
            columnName: column.name,
            batchNumber,
          });
        }
        return value;
      } catch (cause) {
        const diagnostic: DataExportDiagnostic = {
          code: 'unreadable-value',
          severity: 'error',
          message: 'A driver value could not be normalized.',
          tableIdentity: table.tableIdentity,
          columnName: column.name,
          batchNumber,
          cause,
        };
        throw new DataExportError(diagnostic.message, diagnostic, { cause });
      }
    });
    return { row: { values }, bytesRead };
  }

  private valueBytes(value: unknown): number {
    if (typeof value === 'string') return Buffer.byteLength(value);
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value).length;
    if (typeof value === 'boolean') return 1;
    return 0;
  }

  private cancelled(table: PlannedTableExport, cause?: unknown): DataExportDiagnostic {
    return {
      code: 'cancelled-export',
      severity: 'warning',
      message: 'Table data export was cancelled.',
      tableIdentity: table.tableIdentity,
      ...(cause === undefined ? {} : { cause }),
    };
  }

  private result(
    tablesCompleted: number,
    rowsExported: number,
    batchesExported: number,
    bytesRead: number,
    started: number,
    diagnostics: readonly DataExportDiagnostic[],
    cancelled: boolean,
  ): DataExportResult {
    return {
      tablesCompleted,
      rowsExported,
      batchesExported,
      bytesRead,
      elapsedMilliseconds: performance.now() - started,
      diagnostics: [...diagnostics],
      cancelled,
    };
  }

  private isPermissionFailure(cause: unknown): boolean {
    let current = cause;
    while (current instanceof Error) {
      if ((current as Error & { readonly code?: string }).code === '42501') return true;
      current = current.cause;
    }
    return false;
  }
}
