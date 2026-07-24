/** Public, format-neutral contracts emitted by the Data Export Engine. */

import type { TableDataExportDescriptor } from './DataExportDescriptor.js';
import type { NormalizedPostgresValue } from './PostgresValueNormalizer.js';

export type DataExportProgressPhase =
  | 'preparing'
  | 'table-starting'
  | 'batch-exported'
  | 'rows-exported'
  | 'table-completed'
  | 'completed';

export interface DataExportProgress {
  readonly phase: DataExportProgressPhase;
  readonly message: string;
  readonly tableIdentity?: string;
  readonly rowsProcessed: number;
  readonly estimatedRows?: number;
  readonly bytesRead: number;
  readonly elapsedMilliseconds: number;
  readonly batchNumber?: number;
}

export type DataExportProgressCallback = (event: DataExportProgress) => void;

export type DataExportDiagnosticCode =
  | 'cursor-failure'
  | 'unsupported-type'
  | 'unreadable-value'
  | 'inconsistent-snapshot'
  | 'permission-failure'
  | 'cancelled-export'
  | 'truncated-driver-value'
  | 'failed-batch'
  | 'foreign-table-omitted'
  | 'row-security-active';

export interface DataExportDiagnostic {
  readonly code: DataExportDiagnosticCode;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly tableIdentity?: string;
  readonly columnName?: string;
  readonly batchNumber?: number;
  readonly cause?: unknown;
}

export interface NormalizedDataRow {
  /** Values follow the descriptor's exported column order. */
  readonly values: readonly NormalizedPostgresValue[];
}

export interface DataExportBatch {
  readonly table: TableDataExportDescriptor;
  readonly batchNumber: number;
  readonly firstRowNumber: number;
  readonly rows: readonly NormalizedDataRow[];
  readonly bytesRead: number;
}

export interface PlannedTableExport {
  readonly order: number;
  readonly descriptor: TableDataExportDescriptor;
  readonly tableIdentity: string;
  readonly batchSize: number;
  readonly fetchSize: number;
  readonly progressWeight: number;
  readonly strategy: 'adapter-cursor' | 'sql-cursor';
  readonly parallelReadEligible: boolean;
}

export interface DataExportPlan {
  readonly tables: readonly PlannedTableExport[];
  readonly sequential: true;
  readonly transactionUsage: 'existing-snapshot';
  readonly totalEstimatedRows: number;
  readonly totalProgressWeight: number;
  readonly diagnostics: readonly DataExportDiagnostic[];
  readonly omittedTableIdentities: readonly string[];
  readonly rowSecurityMode: 'honor' | 'disable';
  readonly requiresRowSecurityDisable: boolean;
}

export interface DataExportResult {
  readonly tablesCompleted: number;
  readonly rowsExported: number;
  readonly batchesExported: number;
  readonly bytesRead: number;
  readonly elapsedMilliseconds: number;
  readonly diagnostics: readonly DataExportDiagnostic[];
  readonly cancelled: boolean;
}
