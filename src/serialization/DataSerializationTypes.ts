/**
 * Public contracts for turning normalized data batches into restorable plain
 * SQL. These types deliberately mention neither a PostgreSQL driver nor a
 * Node.js stream; the serializer depends only on `DumpWriter`.
 */

import type { TableDataExportDescriptor } from '../data/DataExportDescriptor.js';
import type { DataExportBatch } from '../data/DataExportTypes.js';
import type { DumpWriter } from '../writer/DumpWriter.js';

export type PlainDataOutputMode = 'copy' | 'inserts' | 'column-inserts';

export interface PlainDataSerializationOptions {
  /** COPY is fastest and is the deterministic default. */
  readonly mode?: PlainDataOutputMode;
  readonly tableModes?: Readonly<Record<string, PlainDataOutputMode>>;
  readonly rowsPerInsert?: number;
  readonly maxInsertStatementBytes?: number;
  readonly explicitColumnLists?: boolean;
  readonly excludedColumns?: Readonly<Record<string, readonly string[]>>;
  /** Reserved validation flag; COPY FREEZE is intentionally not emitted yet. */
  readonly copyFreeze?: boolean;
  readonly overridingSystemValue?: boolean;
  readonly debugValues?: boolean;
  /** Minimum interval for high-frequency row progress events. */
  readonly progressThrottleMilliseconds?: number;
}

export interface DataSerializationDiagnostic {
  readonly code:
    | 'invalid-value'
    | 'identity-incompatible'
    | 'column-mismatch'
    | 'cancelled'
    | 'unsupported-option';
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly stage: 'planning' | 'copy-field' | 'insert-literal' | 'writing';
  readonly tableIdentity?: string;
  readonly rowNumber?: number;
  readonly columnName?: string;
  readonly formattedType?: string;
  readonly archiveIdentity?: string;
  readonly debugValue?: string;
  readonly cause?: unknown;
}

export type DataSerializationProgressPhase =
  | 'table-started'
  | 'rows-serialized'
  | 'insert-emitted'
  | 'copy-completed'
  | 'table-completed'
  | 'completed';

export interface DataSerializationProgress {
  readonly phase: DataSerializationProgressPhase;
  readonly tableIdentity?: string;
  readonly rowsSerialized: number;
  readonly bytesWritten: number;
  readonly insertStatements: number;
  readonly copyBlocks: number;
}

export type DataSerializationProgressCallback = (event: DataSerializationProgress) => void;

export interface TableDataSerializationStatistics {
  readonly tableIdentity: string;
  readonly mode: PlainDataOutputMode;
  readonly rows: number;
  readonly bytesWritten: number;
  readonly copyBlocks: number;
  readonly insertStatements: number;
  readonly skipped: boolean;
}

export interface DataSerializationResult {
  readonly tablesProcessed: number;
  readonly tablesSkipped: number;
  readonly totalRows: number;
  readonly bytesWritten: number;
  readonly copyBlocks: number;
  readonly insertStatements: number;
  readonly sequencesRestored: number;
  readonly elapsedMilliseconds: number;
  readonly tableStatistics: readonly TableDataSerializationStatistics[];
  readonly diagnostics: readonly DataSerializationDiagnostic[];
  readonly incomplete: boolean;
  readonly cancelled: boolean;
}

export interface PlainDataSerializerRequest {
  readonly writer: DumpWriter;
  readonly tables: readonly TableDataExportDescriptor[];
  readonly targetSupportsIdentityOverride: boolean;
  readonly options?: PlainDataSerializationOptions;
  readonly onProgress?: DataSerializationProgressCallback;
  readonly signal?: AbortSignal;
}

/** Minimal sink shape accepted directly by `DataExportEngine.export`. */
export interface DataBatchSerializer {
  consume(batch: DataExportBatch): Promise<void>;
  finish(): Promise<DataSerializationResult>;
}
