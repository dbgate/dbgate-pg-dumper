/**
 * Plain SQL rendering options, context, warnings, and results.
 */

import type { ArchiveEntry, DumpArchiveInspection } from '../archive/ArchiveTypes.js';
import type { TargetCapabilities } from '../compatibility/TargetCapabilities.js';
import type { SourceCapabilities } from '../version/SourceCapabilities.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import type { DumpWriter, SqlLineEnding } from '../writer/DumpWriter.js';
import type { IdentifierQuotingPolicy, SqlKeywordCase } from './SqlPrimitives.js';

export type UnsupportedFeaturePolicy = 'error' | 'warn-omit' | 'warn-downgrade';

export interface PlainSqlRenderOptions {
  readonly targetVersion?: PostgresVersion;
  readonly keywordCase?: SqlKeywordCase;
  readonly indentation?: string;
  readonly lineEnding?: SqlLineEnding;
  readonly quoteAllIdentifiers?: boolean;
  readonly statementComments?: boolean;
  readonly includeTimestamp?: boolean;
  readonly clean?: boolean;
  readonly ifExists?: boolean;
  readonly cascade?: boolean;
  readonly includeCreateDatabase?: boolean;
  readonly schemaAuthorization?: boolean;
  readonly noOwner?: boolean;
  readonly noComments?: boolean;
  readonly noPrivileges?: boolean;
  readonly createOrReplaceViews?: boolean;
  readonly unsupportedFeaturePolicy?: UnsupportedFeaturePolicy;
}

export interface NormalizedPlainSqlRenderOptions {
  readonly targetVersion: PostgresVersion;
  readonly nativeTarget: boolean;
  readonly keywordCase: SqlKeywordCase;
  readonly indentation: string;
  readonly lineEnding: SqlLineEnding;
  readonly quoteAllIdentifiers: boolean;
  readonly statementComments: boolean;
  readonly includeTimestamp: boolean;
  readonly clean: boolean;
  readonly ifExists: boolean;
  readonly cascade: boolean;
  readonly includeCreateDatabase: boolean;
  readonly schemaAuthorization: boolean;
  readonly noOwner: boolean;
  readonly noComments: boolean;
  readonly noPrivileges: boolean;
  readonly createOrReplaceViews: boolean;
  readonly unsupportedFeaturePolicy: UnsupportedFeaturePolicy;
}

export type PlainSqlWarningCode =
  | 'unsupported-feature'
  | 'compatibility-omission'
  | 'compatibility-downgrade'
  | 'unsupported-object'
  | 'data-entry-skipped'
  | 'invalid-archive-entry';

export interface PlainSqlWarning {
  readonly code: PlainSqlWarningCode;
  readonly message: string;
  readonly archiveIdentity: string;
  readonly dumpId: string;
  readonly feature?: string;
  readonly transformation?: string;
}

export interface PlainSqlRenderResult {
  readonly bytesWritten: number;
  readonly renderedDumpIds: readonly string[];
  readonly skippedDumpIds: readonly string[];
  readonly failedDumpIds: readonly string[];
  readonly warnings: readonly PlainSqlWarning[];
  readonly compatibilityTransformations: readonly string[];
  readonly unsupportedObjects: readonly string[];
  readonly cancelled: boolean;
}

export interface PlainSqlRenderRequest {
  readonly archive: DumpArchiveInspection;
  readonly sourceVersion: PostgresVersion;
  readonly sourceCapabilities: SourceCapabilities;
  readonly writer: DumpWriter;
  readonly options?: PlainSqlRenderOptions;
  readonly signal?: AbortSignal;
}

export interface RenderWarningCollector {
  add(warning: PlainSqlWarning): void;
  getAll(): readonly PlainSqlWarning[];
}

export interface PlainSqlRenderContext {
  readonly sourceVersion: PostgresVersion;
  readonly targetVersion: PostgresVersion;
  readonly sourceCapabilities: SourceCapabilities;
  readonly targetCapabilities: TargetCapabilities;
  readonly options: NormalizedPlainSqlRenderOptions;
  readonly archive: DumpArchiveInspection;
  readonly entry: ArchiveEntry;
  readonly identifierPolicy: IdentifierQuotingPolicy;
  readonly warnings: RenderWarningCollector;
  readonly writer: DumpWriter;
}

export class PlainSqlWarningCollector implements RenderWarningCollector {
  readonly #warnings: PlainSqlWarning[] = [];

  add(warning: PlainSqlWarning): void {
    if (
      !this.#warnings.some(
        (item) =>
          item.code === warning.code &&
          item.dumpId === warning.dumpId &&
          item.feature === warning.feature &&
          item.message === warning.message,
      )
    ) {
      this.#warnings.push(warning);
    }
  }

  getAll(): readonly PlainSqlWarning[] {
    return [...this.#warnings];
  }
}

export function normalizePlainSqlRenderOptions(
  sourceVersion: PostgresVersion,
  options: PlainSqlRenderOptions = {},
): NormalizedPlainSqlRenderOptions {
  return {
    targetVersion: options.targetVersion ?? sourceVersion,
    nativeTarget: options.targetVersion === undefined,
    keywordCase: options.keywordCase ?? 'upper',
    indentation: options.indentation ?? '    ',
    lineEnding: options.lineEnding ?? '\n',
    quoteAllIdentifiers: options.quoteAllIdentifiers ?? false,
    statementComments: options.statementComments ?? false,
    includeTimestamp: options.includeTimestamp ?? false,
    clean: options.clean ?? false,
    ifExists: options.ifExists ?? true,
    cascade: options.cascade ?? false,
    includeCreateDatabase: options.includeCreateDatabase ?? false,
    schemaAuthorization: options.schemaAuthorization ?? false,
    noOwner: options.noOwner ?? false,
    noComments: options.noComments ?? false,
    noPrivileges: options.noPrivileges ?? false,
    createOrReplaceViews: options.createOrReplaceViews ?? false,
    unsupportedFeaturePolicy: options.unsupportedFeaturePolicy ?? 'error',
  };
}
