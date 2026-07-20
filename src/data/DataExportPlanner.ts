/**
 * Deterministic planning for selected table-data archive entries.
 *
 * Planning is deliberately cheap and query-free. Sequential execution is
 * fixed for now, while progress weights and parallel eligibility are retained
 * for future synchronized-snapshot workers.
 */

import type { DumpArchiveInspection } from '../archive/ArchiveTypes.js';
import type { DataExportPlan } from './DataExportTypes.js';
import type { DataExportDiagnostic } from './DataExportTypes.js';
import { DataExportError } from '../utils/errors.js';

export interface DataExportPlannerOptions {
  readonly batchSize?: number;
  readonly fetchSize?: number;
  readonly preferAdapterCursor?: boolean;
  readonly adapterStreamingAvailable?: boolean;
  readonly includeForeignTables?: boolean;
  readonly rowSecurityMode?: 'honor' | 'disable' | 'require-complete';
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return normalized;
}

export class DataExportPlanner {
  plan(archive: DumpArchiveInspection, options: DataExportPlannerOptions = {}): DataExportPlan {
    if (!archive.valid) throw new Error('Cannot plan data export from an invalid archive.');
    const batchSize = positiveInteger(options.batchSize, 1_000, 'batchSize');
    const fetchSize = positiveInteger(options.fetchSize, batchSize, 'fetchSize');
    const useAdapter =
      (options.preferAdapterCursor ?? true) && (options.adapterStreamingAvailable ?? false);
    const allDescriptors = archive.orderedEntries.flatMap((entry) =>
      entry.selection.selected &&
      entry.objectType === 'table-data' &&
      entry.dataExport?.kind === 'table'
        ? [entry.dataExport]
        : [],
    );
    const diagnostics: DataExportDiagnostic[] = [];
    const omittedTableIdentities: string[] = [];
    const descriptors = allDescriptors.filter((descriptor) => {
      if (
        descriptor.defaultDataPolicy === 'omit-foreign' &&
        !(options.includeForeignTables ?? false)
      ) {
        const identity = `${descriptor.schema}.${descriptor.name}`;
        omittedTableIdentities.push(identity);
        diagnostics.push({
          code: 'foreign-table-omitted',
          severity: 'warning',
          message: 'Foreign-table data was omitted by the safe default policy.',
          tableIdentity: identity,
        });
        return false;
      }
      return true;
    });
    const requestedRowSecurity = options.rowSecurityMode ?? 'disable';
    const secured = descriptors.filter(
      (descriptor) => descriptor.rowLevelSecurity || descriptor.forceRowLevelSecurity,
    );
    if (requestedRowSecurity === 'require-complete' && secured.length > 0) {
      const diagnostic: DataExportDiagnostic = {
        code: 'row-security-active',
        severity: 'error',
        message: 'A complete export cannot be guaranteed while selected tables use row security.',
        tableIdentity: `${secured[0]!.schema}.${secured[0]!.name}`,
      };
      throw new DataExportError(diagnostic.message, diagnostic);
    }
    for (const descriptor of secured) {
      diagnostics.push({
        code: 'row-security-active',
        severity: 'warning',
        message:
          requestedRowSecurity === 'honor'
            ? 'Row security remains active; exported rows reflect the current role and policies.'
            : 'The dump session disables row security and PostgreSQL will fail rather than silently filter rows when bypass is unavailable.',
        tableIdentity: `${descriptor.schema}.${descriptor.name}`,
      });
    }
    const tables = descriptors.map((descriptor, order) => {
      const progressWeight = Math.max(descriptor.estimatedRowCount, 1);
      return {
        order,
        descriptor,
        tableIdentity: `${descriptor.schema}.${descriptor.name}`,
        batchSize,
        fetchSize,
        progressWeight,
        strategy: useAdapter ? ('adapter-cursor' as const) : ('sql-cursor' as const),
        parallelReadEligible: descriptor.persistence === 'permanent',
      };
    });
    return {
      tables,
      sequential: true,
      transactionUsage: 'existing-snapshot',
      totalEstimatedRows: descriptors.reduce(
        (total, descriptor) => total + descriptor.estimatedRowCount,
        0,
      ),
      totalProgressWeight: tables.reduce((total, table) => total + table.progressWeight, 0),
      diagnostics,
      omittedTableIdentities,
      rowSecurityMode: requestedRowSecurity === 'honor' ? 'honor' : 'disable',
      requiresRowSecurityDisable: requestedRowSecurity !== 'honor' && secured.length > 0,
    };
  }
}
