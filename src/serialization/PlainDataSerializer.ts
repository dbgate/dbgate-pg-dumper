/**
 * Stateful, bounded-memory serialization of normalized table batches.
 *
 * The serializer preserves table/archive order and relies on awaited writer
 * calls for natural backpressure. COPY fields stream incrementally. INSERT
 * buffering is capped by both row count and UTF-8 statement size, except that
 * one indivisible row may exceed the configured cap.
 */

import type {
  ColumnExportDescriptor,
  TableDataExportDescriptor,
} from '../data/DataExportDescriptor.js';
import type { DataExportBatch, NormalizedDataRow } from '../data/DataExportTypes.js';
import type { DataExportDiagnostic } from '../data/DataExportTypes.js';
import { quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import { DataSerializationError } from '../utils/errors.js';
import { throwIfAborted } from '../utils/abort.js';
import { writeCopyTextValue } from './CopyTextSerializer.js';
import { renderInsertLiteral } from './InsertLiteralSerializer.js';
import { postgresTextValue, safelyDescribeValue } from './PostgresTextValue.js';
import type {
  DataSerializationDiagnostic,
  DataSerializationProgressPhase,
  DataSerializationResult,
  PlainDataOutputMode,
  PlainDataSerializationOptions,
  PlainDataSerializerRequest,
  TableDataSerializationStatistics,
} from './DataSerializationTypes.js';

interface MutableTableStatistics {
  readonly tableIdentity: string;
  readonly mode: PlainDataOutputMode;
  rows: number;
  startBytes: number;
  endBytes: number;
  copyBlocks: number;
  insertStatements: number;
  skipped: boolean;
}

interface ActiveTable {
  readonly descriptor: TableDataExportDescriptor;
  readonly identity: string;
  readonly mode: PlainDataOutputMode;
  readonly columns: readonly ColumnExportDescriptor[];
  readonly indices: readonly number[];
  readonly stats: MutableTableStatistics;
  readonly insertPrefix?: string;
  pendingRows: string[];
  pendingBytes: number;
}

const DEFAULT_INSERT_ROWS = 100;
const DEFAULT_INSERT_BYTES = 1024 * 1024;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return result;
}

export class PlainDataSerializer {
  readonly #started = performance.now();
  readonly #options: Required<
    Pick<
      PlainDataSerializationOptions,
      | 'mode'
      | 'rowsPerInsert'
      | 'maxInsertStatementBytes'
      | 'explicitColumnLists'
      | 'copyFreeze'
      | 'overridingSystemValue'
      | 'debugValues'
      | 'progressThrottleMilliseconds'
    >
  > &
    Pick<PlainDataSerializationOptions, 'tableModes' | 'excludedColumns'>;
  readonly #statistics = new Map<string, MutableTableStatistics>();
  readonly #diagnostics: DataSerializationDiagnostic[] = [];
  #active: ActiveTable | undefined;
  #totalRows = 0;
  #copyBlocks = 0;
  #insertStatements = 0;
  #finished = false;
  #lastRowProgress = 0;

  constructor(private readonly request: PlainDataSerializerRequest) {
    this.#options = {
      mode: request.options?.mode ?? 'copy',
      rowsPerInsert: positiveInteger(
        request.options?.rowsPerInsert,
        DEFAULT_INSERT_ROWS,
        'rowsPerInsert',
      ),
      maxInsertStatementBytes: positiveInteger(
        request.options?.maxInsertStatementBytes,
        DEFAULT_INSERT_BYTES,
        'maxInsertStatementBytes',
      ),
      explicitColumnLists: request.options?.explicitColumnLists ?? false,
      copyFreeze: request.options?.copyFreeze ?? false,
      overridingSystemValue: request.options?.overridingSystemValue ?? true,
      debugValues: request.options?.debugValues ?? false,
      progressThrottleMilliseconds: request.options?.progressThrottleMilliseconds ?? 100,
      ...(request.options?.tableModes === undefined
        ? {}
        : { tableModes: request.options.tableModes }),
      ...(request.options?.excludedColumns === undefined
        ? {}
        : { excludedColumns: request.options.excludedColumns }),
    };
    if (this.#options.copyFreeze) {
      throw this.failure({
        code: 'unsupported-option',
        severity: 'error',
        message: 'COPY FREEZE is reserved for future support and cannot be emitted safely yet.',
        stage: 'planning',
      });
    }
  }

  async consume(batch: DataExportBatch): Promise<void> {
    this.assertOpen();
    throwIfAborted(this.request.signal);
    const identity = this.identity(batch.table);
    if (this.#active?.identity !== identity) {
      await this.completeActive();
      await this.startTable(batch.table);
    }
    const active = this.#active!;
    for (let offset = 0; offset < batch.rows.length; offset += 1) {
      throwIfAborted(this.request.signal);
      const rowNumber = batch.firstRowNumber + offset;
      const row = batch.rows[offset]!;
      if (active.mode === 'copy') {
        await this.writeCopyRow(active, row, rowNumber);
      } else {
        await this.queueInsertRow(active, row, rowNumber);
      }
      active.stats.rows += 1;
      this.#totalRows += 1;
    }
    this.progress('rows-serialized', identity);
  }

  async finish(): Promise<DataSerializationResult> {
    this.assertOpen();
    await this.completeActive();
    for (const table of this.request.tables) {
      const identity = this.identity(table);
      if (!this.#statistics.has(identity)) {
        this.#statistics.set(identity, {
          tableIdentity: identity,
          mode: this.mode(identity),
          rows: 0,
          startBytes: this.request.writer.bytesWritten,
          endBytes: this.request.writer.bytesWritten,
          copyBlocks: 0,
          insertStatements: 0,
          skipped: true,
        });
      }
    }
    await this.request.writer.flush(this.request.signal);
    this.#finished = true;
    this.progress('completed');
    const tables = [...this.#statistics.values()].map((statistics) =>
      this.freezeStatistics(statistics),
    );
    return {
      tablesProcessed: tables.filter((table) => !table.skipped).length,
      tablesSkipped: tables.filter((table) => table.skipped).length,
      totalRows: this.#totalRows,
      bytesWritten: tables.reduce((total, table) => total + table.bytesWritten, 0),
      copyBlocks: this.#copyBlocks,
      insertStatements: this.#insertStatements,
      sequencesRestored: 0,
      elapsedMilliseconds: performance.now() - this.#started,
      tableStatistics: tables,
      diagnostics: [...this.#diagnostics],
      incomplete: this.#diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
      cancelled: false,
    };
  }

  /**
   * Closes a recoverable table fragment and makes incompleteness visible in
   * both SQL and structured results. Output writer failures remain fatal.
   */
  async recoverTable(diagnostic: DataExportDiagnostic): Promise<void> {
    const active = this.#active;
    if (active !== undefined) {
      if (active.mode === 'copy') {
        await this.request.writer.writeLine('\\.', this.request.signal);
      } else {
        active.pendingRows = [];
        active.pendingBytes = 0;
      }
      active.stats.endBytes = this.request.writer.bytesWritten;
      this.#active = undefined;
    }
    const identity = diagnostic.tableIdentity ?? 'unknown table';
    await this.request.writer.writeLine(
      `-- WARNING: INCOMPLETE table data for ${identity}; see dump diagnostics.`,
      this.request.signal,
    );
    await this.request.writer.writeLine('', this.request.signal);
    this.#diagnostics.push({
      code: 'invalid-value',
      severity: 'error',
      message: diagnostic.message,
      stage: 'writing',
      ...(diagnostic.tableIdentity === undefined
        ? {}
        : { tableIdentity: diagnostic.tableIdentity }),
      ...(diagnostic.cause === undefined ? {} : { cause: diagnostic.cause }),
    });
  }

  private async startTable(descriptor: TableDataExportDescriptor): Promise<void> {
    const identity = this.identity(descriptor);
    const excluded = new Set(this.#options.excludedColumns?.[identity] ?? []);
    const indices = descriptor.columns.flatMap((column, index) =>
      excluded.has(column.name) ? [] : [index],
    );
    const columns = indices.map((index) => descriptor.columns[index]!);
    if (columns.length === 0) {
      throw this.failure({
        code: 'column-mismatch',
        severity: 'error',
        message: 'No exportable columns remain for a table containing data.',
        stage: 'planning',
        tableIdentity: identity,
      });
    }
    const mode = this.mode(identity);
    const alwaysIdentity = columns.some((column) => column.identity === 'always');
    if (
      mode !== 'copy' &&
      alwaysIdentity &&
      (!this.#options.overridingSystemValue || !this.request.targetSupportsIdentityOverride)
    ) {
      throw this.failure({
        code: 'identity-incompatible',
        severity: 'error',
        message:
          'Identity GENERATED ALWAYS values require target support for OVERRIDING SYSTEM VALUE.',
        stage: 'planning',
        tableIdentity: identity,
      });
    }
    const stats: MutableTableStatistics = {
      tableIdentity: identity,
      mode,
      rows: 0,
      startBytes: this.request.writer.bytesWritten,
      endBytes: this.request.writer.bytesWritten,
      copyBlocks: 0,
      insertStatements: 0,
      skipped: false,
    };
    const columnSql = columns.map((column) => column.quotedName).join(', ');
    const relation = quoteQualifiedIdentifier([descriptor.schema, descriptor.name]);
    const needsColumns =
      mode === 'column-inserts' ||
      this.#options.explicitColumnLists ||
      descriptor.generatedColumns.length > 0 ||
      excluded.size > 0 ||
      descriptor.identityColumns.length > 0;
    const override = mode !== 'copy' && alwaysIdentity ? ' OVERRIDING SYSTEM VALUE' : '';
    this.#active = {
      descriptor,
      identity,
      mode,
      columns,
      indices,
      stats,
      ...(mode === 'copy'
        ? {}
        : {
            insertPrefix: `INSERT INTO ${relation}${needsColumns ? ` (${columnSql})` : ''}${override} VALUES `,
          }),
      pendingRows: [],
      pendingBytes: 0,
    };
    this.#statistics.set(identity, stats);
    this.progress('table-started', identity);
    if (mode === 'copy') {
      await this.request.writer.writeLine(
        `COPY ${relation} (${columnSql}) FROM stdin;`,
        this.request.signal,
      );
      stats.copyBlocks = 1;
      this.#copyBlocks += 1;
    }
  }

  private async writeCopyRow(
    active: ActiveTable,
    row: NormalizedDataRow,
    rowNumber: number,
  ): Promise<void> {
    const texts = active.indices.map((inputIndex, outputIndex) => {
      const column = active.columns[outputIndex]!;
      const value = row.values[inputIndex];
      if (value === undefined) throw this.columnFailure(active, column, rowNumber, undefined);
      try {
        return postgresTextValue(value, column);
      } catch (cause) {
        throw this.columnFailure(active, column, rowNumber, value.value, cause, 'copy-field');
      }
    });
    for (let outputIndex = 0; outputIndex < active.indices.length; outputIndex += 1) {
      if (outputIndex > 0) await this.request.writer.write('\t', this.request.signal);
      const text = texts[outputIndex]!;
      if (text === null) await this.request.writer.write('\\N', this.request.signal);
      else await writeCopyTextValue(this.request.writer, text, this.request.signal);
    }
    await this.request.writer.write(this.request.writer.lineEnding, this.request.signal);
  }

  private async queueInsertRow(
    active: ActiveTable,
    row: NormalizedDataRow,
    rowNumber: number,
  ): Promise<void> {
    const literals = active.indices.map((inputIndex, outputIndex) => {
      const column = active.columns[outputIndex]!;
      const value = row.values[inputIndex];
      if (value === undefined) throw this.columnFailure(active, column, rowNumber, undefined);
      try {
        return renderInsertLiteral(value, column);
      } catch (cause) {
        throw this.columnFailure(active, column, rowNumber, value.value, cause, 'insert-literal');
      }
    });
    const renderedRow = `(${literals.join(', ')})`;
    const separatorBytes = active.pendingRows.length === 0 ? 0 : Buffer.byteLength(', ');
    const projected =
      Buffer.byteLength(active.insertPrefix!) +
      active.pendingBytes +
      separatorBytes +
      Buffer.byteLength(renderedRow) +
      Buffer.byteLength(`;${this.request.writer.lineEnding}`);
    if (
      active.pendingRows.length > 0 &&
      (active.pendingRows.length >= this.#options.rowsPerInsert ||
        projected > this.#options.maxInsertStatementBytes)
    ) {
      await this.flushInsert(active);
    }
    active.pendingRows.push(renderedRow);
    active.pendingBytes +=
      Buffer.byteLength(renderedRow) + (active.pendingRows.length === 1 ? 0 : 2);
    if (active.pendingRows.length >= this.#options.rowsPerInsert) await this.flushInsert(active);
  }

  private async flushInsert(active: ActiveTable): Promise<void> {
    if (active.pendingRows.length === 0) return;
    await this.request.writer.writeLine(
      `${active.insertPrefix!}${active.pendingRows.join(', ')};`,
      this.request.signal,
    );
    active.pendingRows = [];
    active.pendingBytes = 0;
    active.stats.insertStatements += 1;
    this.#insertStatements += 1;
    this.progress('insert-emitted', active.identity);
  }

  private async completeActive(): Promise<void> {
    const active = this.#active;
    if (active === undefined) return;
    if (active.mode === 'copy') {
      await this.request.writer.writeLine('\\.', this.request.signal);
      this.progress('copy-completed', active.identity);
    } else {
      await this.flushInsert(active);
    }
    await this.request.writer.writeLine('', this.request.signal);
    active.stats.endBytes = this.request.writer.bytesWritten;
    this.progress('table-completed', active.identity);
    this.#active = undefined;
  }

  private mode(identity: string): PlainDataOutputMode {
    return this.#options.tableModes?.[identity] ?? this.#options.mode;
  }

  private identity(table: TableDataExportDescriptor): string {
    return `${table.schema}.${table.name}`;
  }

  private columnFailure(
    active: ActiveTable,
    column: ColumnExportDescriptor,
    rowNumber: number,
    value: unknown,
    cause?: unknown,
    stage: DataSerializationDiagnostic['stage'] = 'copy-field',
  ): DataSerializationError {
    return this.failure({
      code: value === undefined ? 'column-mismatch' : 'invalid-value',
      severity: 'error',
      message:
        value === undefined
          ? 'A normalized row did not contain an expected exported column.'
          : 'A PostgreSQL value could not be serialized safely.',
      stage,
      tableIdentity: active.identity,
      archiveIdentity: `table-data:${active.descriptor.schema}:${active.descriptor.name}`,
      rowNumber,
      columnName: column.name,
      formattedType: column.formattedType,
      ...(this.#options.debugValues ? { debugValue: safelyDescribeValue(value) } : {}),
      ...(cause === undefined ? {} : { cause }),
    });
  }

  private failure(diagnostic: DataSerializationDiagnostic): DataSerializationError {
    this.#diagnostics.push(diagnostic);
    return new DataSerializationError(diagnostic.message, diagnostic, {
      ...(diagnostic.cause === undefined ? {} : { cause: diagnostic.cause }),
    });
  }

  private progress(phase: DataSerializationProgressPhase, tableIdentity?: string): void {
    const now = performance.now();
    if (
      phase === 'rows-serialized' &&
      now - this.#lastRowProgress < this.#options.progressThrottleMilliseconds
    ) {
      return;
    }
    if (phase === 'rows-serialized') this.#lastRowProgress = now;
    this.request.onProgress?.({
      phase,
      ...(tableIdentity === undefined ? {} : { tableIdentity }),
      rowsSerialized: this.#totalRows,
      bytesWritten: this.request.writer.bytesWritten,
      insertStatements: this.#insertStatements,
      copyBlocks: this.#copyBlocks,
    });
  }

  private freezeStatistics(statistics: MutableTableStatistics): TableDataSerializationStatistics {
    return {
      tableIdentity: statistics.tableIdentity,
      mode: statistics.mode,
      rows: statistics.rows,
      bytesWritten: statistics.endBytes - statistics.startBytes,
      copyBlocks: statistics.copyBlocks,
      insertStatements: statistics.insertStatements,
      skipped: statistics.skipped,
    };
  }

  private assertOpen(): void {
    if (this.#finished) throw new Error('The data serializer has already finished.');
  }
}
