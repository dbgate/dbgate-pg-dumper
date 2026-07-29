/**
 * Public API contracts for configuring a dump and observing its execution.
 *
 * These types intentionally describe user intent rather than PostgreSQL client
 * details. Future implementation layers will translate them into an immutable
 * dump plan before any output is written.
 */

import type { PostgresVersion } from '../version/PostgresVersion.js';
import type { DumpTransactionMode } from '../connection/DumpSession.js';
import type { DumpSelection } from '../selection/Selection.js';
import type { PlainSqlRenderOptions, UnsupportedFeaturePolicy } from '../renderer/RenderTypes.js';
import type { RestoreTransactionMode, RestoreTriggerMode } from '../renderer/RenderTypes.js';
import type { SqlKeywordCase } from '../renderer/SqlPrimitives.js';
import type { SqlLineEnding } from '../writer/DumpWriter.js';
import type { PlainDataSerializationOptions } from '../serialization/DataSerializationTypes.js';
import type { TableDataSerializationStatistics } from '../serialization/DataSerializationTypes.js';
import type { DumpPreflightReport, UnsupportedObjectPolicy } from '../preflight/PreflightTypes.js';
import type { SensitiveValuePolicy } from '../security/SensitiveValuePolicy.js';

/** Selects which major sections are included in the generated SQL document. */
export type DumpMode = 'full' | 'schema-only' | 'data-only';

/** Selects the SQL representation used when table rows are exported. */
export type DataExportFormat = 'copy' | 'insert' | 'column-inserts';

/** Stable machine-readable identifiers attached to non-fatal dump warnings. */
export type DumpWarningCode =
  | 'unsupported-object'
  | 'compatibility-adjustment'
  | 'permission-denied'
  | 'incomplete-metadata'
  | 'data-export'
  | 'portability-risk'
  | 'security-decision'
  | 'runtime-state';

/** Indicates how strongly a caller should surface a warning. */
export type DumpWarningSeverity = 'info' | 'warning';

/** A non-fatal condition encountered while planning or producing a dump. */
export interface DumpWarning {
  readonly code: DumpWarningCode;
  readonly severity: DumpWarningSeverity;
  readonly message: string;
  readonly objectIdentity?: string;
  readonly cause?: unknown;
}

/** High-level phases used for progress reporting across implementation layers. */
export type DumpProgressPhase =
  | 'initializing'
  | 'detecting-version'
  | 'introspecting'
  | 'planning'
  | 'preflight'
  | 'writing-schema'
  | 'writing-data'
  | 'finalizing';

/** A structured, forward-compatible progress event emitted by the dump pipeline. */
export interface DumpProgress {
  readonly phase: DumpProgressPhase;
  readonly message: string;
  readonly completed?: number;
  readonly total?: number;
  readonly objectIdentity?: string;
  readonly rowsWritten?: number;
  readonly bytesWritten?: number;
}

/** Receives synchronous notifications; exceptions abort the dump operation. */
export type DumpProgressCallback = (progress: DumpProgress) => void;

/**
 * Options accepted by the public dump operation.
 *
 * Rendering-related options remain placeholders, while transaction and
 * selection options are already shared with the introspection use case.
 */
export interface DumpOptions {
  readonly mode?: DumpMode;
  readonly dataFormat?: DataExportFormat;
  readonly targetVersion?: PostgresVersion;
  readonly includeDropStatements?: boolean;
  readonly includeCreateDatabase?: boolean;
  readonly useTransaction?: boolean;
  readonly rowsPerInsert?: number;
  readonly maxInsertStatementBytes?: number;
  readonly explicitColumnLists?: boolean;
  readonly tableDataFormats?: PlainDataSerializationOptions['tableModes'];
  readonly excludedDataColumns?: PlainDataSerializationOptions['excludedColumns'];
  readonly overridingSystemValue?: boolean;
  readonly copyFreeze?: boolean;
  readonly includeForeignTableData?: boolean;
  readonly rowSecurityMode?: 'honor' | 'disable' | 'require-complete';
  /**
   * Continue after recoverable data errors and skip target-incompatible schema
   * features with structured warnings. Defaults to false.
   */
  readonly bestEffort?: boolean;
  readonly transactionMode?: DumpTransactionMode;
  readonly selection?: DumpSelection;
  readonly keywordCase?: SqlKeywordCase;
  readonly indentation?: string;
  readonly lineEnding?: SqlLineEnding;
  readonly quoteAllIdentifiers?: boolean;
  readonly statementComments?: boolean;
  readonly includeTimestamp?: boolean;
  readonly ifExists?: boolean;
  readonly cascade?: boolean;
  readonly schemaAuthorization?: boolean;
  readonly noOwner?: boolean;
  readonly noComments?: boolean;
  readonly noPrivileges?: boolean;
  readonly createOrReplaceViews?: boolean;
  readonly unsupportedFeaturePolicy?: UnsupportedFeaturePolicy;
  readonly restoreTransactionMode?: RestoreTransactionMode;
  readonly restoreTriggerMode?: RestoreTriggerMode;
  /** Analyze the complete dump without writing output. */
  readonly dryRun?: boolean;
  readonly unsupportedObjectPolicy?: UnsupportedObjectPolicy;
  readonly sensitiveValuePolicy?: SensitiveValuePolicy;
  readonly tablespacePolicy?: 'preserve' | 'omit' | 'remap' | 'fail-unmapped';
  readonly tablespaceMappings?: Readonly<Record<string, string>>;
  readonly roleMappings?: Readonly<Record<string, string>>;
  readonly includeLargeObjects?: boolean;
  readonly includeUserMappings?: boolean;
  readonly includeEventTriggers?: boolean;
  readonly includeSubscriptions?: boolean;
  readonly includeRoles?: boolean;
  readonly includeSecurityLabels?: boolean;
  readonly includeTemporaryObjects?: boolean;
  readonly expandExtensionMembers?: boolean;
  /** Emit CREATE EXTENSION IF NOT EXISTS. Defaults to true for restore-safe dumps. */
  readonly extensionIfNotExists?: boolean;
  readonly extensionVersion?: 'source' | 'default';
  readonly extensionUpdate?: Readonly<Record<string, string>>;
}

/** Converts public dump options to the renderer's deliberately narrower view. */
export function toPlainSqlRenderOptions(options: DumpOptions): PlainSqlRenderOptions {
  return {
    ...(options.targetVersion === undefined ? {} : { targetVersion: options.targetVersion }),
    ...(options.keywordCase === undefined ? {} : { keywordCase: options.keywordCase }),
    ...(options.indentation === undefined ? {} : { indentation: options.indentation }),
    ...(options.lineEnding === undefined ? {} : { lineEnding: options.lineEnding }),
    ...(options.quoteAllIdentifiers === undefined
      ? {}
      : { quoteAllIdentifiers: options.quoteAllIdentifiers }),
    ...(options.statementComments === undefined
      ? {}
      : { statementComments: options.statementComments }),
    ...(options.includeTimestamp === undefined
      ? {}
      : { includeTimestamp: options.includeTimestamp }),
    clean: options.includeDropStatements ?? false,
    ...(options.ifExists === undefined ? {} : { ifExists: options.ifExists }),
    ...(options.cascade === undefined ? {} : { cascade: options.cascade }),
    includeCreateDatabase: options.includeCreateDatabase ?? false,
    ...(options.schemaAuthorization === undefined
      ? {}
      : { schemaAuthorization: options.schemaAuthorization }),
    ...(options.noOwner === undefined ? {} : { noOwner: options.noOwner }),
    ...(options.noComments === undefined ? {} : { noComments: options.noComments }),
    ...(options.noPrivileges === undefined ? {} : { noPrivileges: options.noPrivileges }),
    ...(options.createOrReplaceViews === undefined
      ? {}
      : { createOrReplaceViews: options.createOrReplaceViews }),
    ...(options.unsupportedFeaturePolicy === undefined
      ? options.bestEffort === true
        ? { unsupportedFeaturePolicy: 'warn-skip' as const }
        : {}
      : { unsupportedFeaturePolicy: options.unsupportedFeaturePolicy }),
    ...(options.restoreTransactionMode === undefined
      ? {}
      : { transactionMode: options.restoreTransactionMode }),
    ...(options.restoreTriggerMode === undefined
      ? {}
      : { triggerMode: options.restoreTriggerMode }),
    ...(options.extensionIfNotExists === undefined
      ? {}
      : { extensionIfNotExists: options.extensionIfNotExists }),
    ...(options.extensionVersion === undefined
      ? {}
      : { extensionVersion: options.extensionVersion }),
    ...(options.extensionUpdate === undefined ? {} : { extensionUpdate: options.extensionUpdate }),
    ...(options.tablespacePolicy === undefined
      ? {}
      : { tablespacePolicy: options.tablespacePolicy }),
    ...(options.tablespaceMappings === undefined
      ? {}
      : { tablespaceMappings: options.tablespaceMappings }),
    ...(options.roleMappings === undefined ? {} : { roleMappings: options.roleMappings }),
    ...(options.sensitiveValuePolicy?.mode === undefined
      ? {}
      : { sensitiveValueMode: options.sensitiveValuePolicy.mode }),
    ...(options.sensitiveValuePolicy?.placeholder === undefined
      ? {}
      : {
          sensitiveValuePlaceholder: options.sensitiveValuePolicy.placeholder,
        }),
  };
}

/** Summary returned only after the writable stream has accepted the full dump. */
export interface DumpResult {
  readonly sourceVersion: PostgresVersion;
  readonly targetVersion: PostgresVersion;
  readonly warnings: readonly DumpWarning[];
  readonly objectsWritten: number;
  readonly tablesWritten: number;
  readonly rowsWritten: number;
  readonly bytesWritten: number;
  readonly tablesSkipped: number;
  readonly copyBlocks: number;
  readonly insertStatements: number;
  readonly sequencesRestored: number;
  readonly largeObjectsWritten: number;
  readonly largeObjectBytesWritten: number;
  readonly elapsedMilliseconds: number;
  readonly incomplete: boolean;
  readonly tableDataStatistics: readonly TableDataSerializationStatistics[];
  readonly preflight: DumpPreflightReport;
}
