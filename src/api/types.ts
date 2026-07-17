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
import type { SqlKeywordCase } from '../renderer/SqlPrimitives.js';
import type { SqlLineEnding } from '../writer/DumpWriter.js';

/** Selects which major sections are included in the generated SQL document. */
export type DumpMode = 'full' | 'schema-only' | 'data-only';

/** Selects the SQL representation used when table rows are exported. */
export type DataExportFormat = 'copy' | 'insert';

/** Stable machine-readable identifiers attached to non-fatal dump warnings. */
export type DumpWarningCode =
  | 'unsupported-object'
  | 'compatibility-adjustment'
  | 'permission-denied'
  | 'incomplete-metadata'
  | 'data-export';

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
      ? {}
      : { unsupportedFeaturePolicy: options.unsupportedFeaturePolicy }),
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
}
