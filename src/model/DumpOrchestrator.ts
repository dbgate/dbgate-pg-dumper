/**
 * Application-layer coordinator for a complete dump.
 *
 * Detects versions, introspects catalog objects, creates an ordered archive,
 * applies compatibility rules, renders schema SQL, streams table data, and
 * finalizes output without absorbing those layers' low-level responsibilities.
 */

import type { Writable } from 'node:stream';

import {
  toPlainSqlRenderOptions,
  type DumpOptions,
  type DumpProgressCallback,
  type DumpResult,
  type DumpWarning,
} from '../api/types.js';
import { inspectDumpArchive } from '../archive/inspectDumpArchive.js';
import type { PostgresConnectionInput } from '../connection/PostgresConnection.js';
import { DataExportEngine } from '../data/DataExportEngine.js';
import { DataExportPlanner } from '../data/DataExportPlanner.js';
import type { DataExportDiagnostic } from '../data/DataExportTypes.js';
import { LargeObjectExporter, type LargeObjectExportResult } from '../data/LargeObjectExporter.js';
import { withPostgresIntrospectionSession } from '../introspection/introspectPostgres.js';
import { renderPlainSql } from '../renderer/PlainSqlRenderer.js';
import { PlainDataSerializer } from '../serialization/PlainDataSerializer.js';
import type {
  DataSerializationProgress,
  DataSerializationResult,
} from '../serialization/DataSerializationTypes.js';
import { detectTargetCapabilities } from '../compatibility/TargetCapabilities.js';
import { throwIfAborted } from '../utils/abort.js';
import { toCancellationError } from '../utils/errors.js';
import { StreamDumpWriter } from '../writer/DumpWriter.js';
import { DumpPreflightAnalyzer } from '../preflight/DumpPreflightAnalyzer.js';
import { PreflightError } from '../utils/errors.js';

/** Dependencies and request data for one isolated dump execution. */
export interface DumpRequest {
  readonly connection: PostgresConnectionInput;
  readonly options: DumpOptions;
  readonly output: Writable;
  readonly onProgress: DumpProgressCallback | undefined;
  readonly signal: AbortSignal | undefined;
}

function rowProgressMessage(rows: number, estimatedTotalRows: number): string {
  const written = rows.toLocaleString('en-US');
  return estimatedTotalRows > 0
    ? `Written ${written} of approximately ${estimatedTotalRows.toLocaleString('en-US')} rows.`
    : `Written ${written} rows.`;
}

export function dataSerializationProgressMessage(
  event: DataSerializationProgress,
  estimatedTotalRows: number,
): string {
  const table = event.tableIdentity ?? 'the current table';
  switch (event.phase) {
    case 'table-started':
      return `Writing table ${table}.`;
    case 'rows-serialized':
    case 'insert-emitted':
      return rowProgressMessage(event.rowsSerialized, estimatedTotalRows);
    case 'copy-completed':
      return `Finished COPY data for table ${table}.`;
    case 'table-completed':
      return `Finished table ${table}. ${rowProgressMessage(
        event.rowsSerialized,
        estimatedTotalRows,
      )}`;
    case 'completed':
      return `Finished writing table data. ${event.rowsSerialized.toLocaleString(
        'en-US',
      )} rows written.`;
  }
}

/** Coordinates the clean-architecture services that implement the use case. */
export class DumpOrchestrator {
  async dump(request: DumpRequest): Promise<DumpResult> {
    const started = performance.now();
    throwIfAborted(request.signal);
    const progress = (
      phase: Parameters<NonNullable<DumpProgressCallback>>[0]['phase'],
      message: string,
      completed?: number,
      total?: number,
    ): void => {
      request.onProgress?.({
        phase,
        message,
        ...(completed === undefined ? {} : { completed }),
        ...(total === undefined ? {} : { total }),
      });
    };

    progress('initializing', 'Initializing PostgreSQL schema dump.');
    progress('detecting-version', 'Detecting PostgreSQL version and introspecting catalogs.');
    return withPostgresIntrospectionSession(
      request.connection,
      {
        transactionMode:
          request.options.transactionMode ??
          (request.options.useTransaction === false ? 'none' : 'managed'),
        ...(request.options.selection === undefined
          ? {}
          : { selection: request.options.selection }),
      },
      async (introspection, connection) => {
        progress('planning', 'Building and ordering the dump archive.');
        const selection = request.options.selection;
        const archive = inspectDumpArchive(introspection.database, {
          ...(introspection.database.extensions === undefined
            ? {}
            : { extensions: introspection.database.extensions }),
          ...(introspection.database.extensionMembers === undefined
            ? {}
            : { extensionMembers: introspection.database.extensionMembers }),
          expandExtensionMembers: request.options.expandExtensionMembers ?? false,
          includeLargeObjects: request.options.includeLargeObjects ?? true,
          includeUserMappings: request.options.includeUserMappings ?? false,
          includeEventTriggers: request.options.includeEventTriggers ?? true,
          includeSubscriptions: request.options.includeSubscriptions ?? false,
          includeRoles: request.options.includeRoles ?? false,
          includeSecurityLabels: request.options.includeSecurityLabels ?? false,
          selection: {
            mode: request.options.mode ?? 'full',
            ...(selection?.includeSchemas === undefined
              ? {}
              : { includeSchemas: selection.includeSchemas }),
            ...(selection?.excludeSchemas === undefined
              ? {}
              : { excludeSchemas: selection.excludeSchemas }),
            ...(selection?.includeTables === undefined
              ? {}
              : { includeTables: selection.includeTables }),
            ...(selection?.excludeTables === undefined
              ? {}
              : { excludeTables: selection.excludeTables }),
            includeDependencies: true,
          },
        });
        if (!archive.valid) {
          throw new PreflightError('Dump archive planning found errors; no output was written.', {
            valid: archive.valid,
            diagnostics: archive.diagnostics,
          });
        }

        const renderOptions = toPlainSqlRenderOptions(request.options);
        const targetVersion = renderOptions.targetVersion ?? introspection.metadata.source.version;
        progress('preflight', 'Analyzing dump safety and restore requirements.');
        const preflight = new DumpPreflightAnalyzer().analyze(
          introspection.database,
          archive,
          introspection.metadata.source.version,
          targetVersion,
          request.options,
        );
        const fatalPreflightIssue = preflight.issues.some(
          (issue) =>
            issue.severity === 'error' &&
            (issue.code !== 'unsupported-object' ||
              (request.options.unsupportedObjectPolicy ?? 'error') === 'error'),
        );
        if (fatalPreflightIssue) {
          throw new PreflightError(
            'Dump preflight found errors; no output was written.',
            preflight,
          );
        }
        if (request.options.dryRun) {
          return {
            sourceVersion: introspection.metadata.source.version,
            targetVersion,
            warnings: preflight.issues
              .filter((issue) => issue.severity !== 'error')
              .map((issue) => ({
                code:
                  issue.code === 'target-incompatibility'
                    ? ('compatibility-adjustment' as const)
                    : issue.code === 'portability-risk' ||
                        issue.code === 'unlogged-table' ||
                        issue.code === 'temporary-object'
                      ? ('portability-risk' as const)
                      : ('unsupported-object' as const),
                severity: 'warning' as const,
                message: issue.message,
                ...(issue.objectIdentity === undefined
                  ? {}
                  : { objectIdentity: issue.objectIdentity }),
              })),
            objectsWritten: 0,
            tablesWritten: 0,
            rowsWritten: 0,
            bytesWritten: 0,
            tablesSkipped: 0,
            copyBlocks: 0,
            insertStatements: 0,
            sequencesRestored: 0,
            largeObjectsWritten: 0,
            largeObjectBytesWritten: 0,
            elapsedMilliseconds: performance.now() - started,
            incomplete: false,
            tableDataStatistics: [],
            preflight,
          };
        }
        const writer = new StreamDumpWriter(request.output, {
          lineEnding: renderOptions.lineEnding ?? '\n',
        });
        let dataResult: DataSerializationResult | undefined;
        let dataDiagnostics: readonly DataExportDiagnostic[] = [];
        let largeObjectResult: LargeObjectExportResult | undefined;
        let omittedDataTables = 0;
        progress(
          'writing-schema',
          'Rendering the ordered plain SQL archive.',
          0,
          archive.orderedEntries.length,
        );
        const rendered = await renderPlainSql({
          archive,
          sourceVersion: introspection.metadata.source.version,
          sourceCapabilities: introspection.metadata.source.capabilities,
          writer,
          options: renderOptions,
          ...(request.options.mode === 'schema-only'
            ? {}
            : {
                renderLargeObjectData: async (entries): Promise<void> => {
                  const objectOids = entries.flatMap((entry) =>
                    entry.dataExport?.kind === 'large-object' ? [entry.dataExport.objectOid] : [],
                  );
                  progress(
                    'writing-data',
                    'Streaming PostgreSQL large objects.',
                    0,
                    objectOids.length,
                  );
                  largeObjectResult = await new LargeObjectExporter().export({
                    connection,
                    objectOids,
                    writer,
                    ...(request.signal === undefined ? {} : { signal: request.signal }),
                    onProgress: (event) =>
                      request.onProgress?.({
                        phase: 'writing-data',
                        message: 'large-object',
                        objectIdentity: `large object ${event.objectOid}`,
                        completed: event.pagesWritten,
                        bytesWritten: event.bytesWritten,
                      }),
                  });
                },
                renderTableData: async (entries): Promise<void> => {
                  progress('writing-data', 'Streaming and serializing PostgreSQL table data.');
                  for (const statement of [
                    `SET LOCAL DateStyle = 'ISO'`,
                    `SET LOCAL IntervalStyle = 'postgres'`,
                    `SET LOCAL TimeZone = 'UTC'`,
                    `SET LOCAL bytea_output = 'hex'`,
                    `SET LOCAL extra_float_digits = 3`,
                    `SET LOCAL lc_monetary = 'C'`,
                  ]) {
                    await connection.query({ text: statement }, request.signal);
                  }
                  const plan = new DataExportPlanner().plan(
                    {
                      ...archive,
                      orderedEntries: entries,
                      orderedDumpIds: entries.map((entry) => entry.dumpId),
                    },
                    {
                      adapterStreamingAvailable: connection.stream !== undefined,
                      includeForeignTables: request.options.includeForeignTableData ?? false,
                      rowSecurityMode: request.options.rowSecurityMode ?? 'disable',
                    },
                  );
                  const estimatedTotalRows = Math.max(0, Math.round(plan.totalEstimatedRows));
                  const serializer = new PlainDataSerializer({
                    writer,
                    tables: plan.tables.map((table) => table.descriptor),
                    targetSupportsIdentityOverride:
                      detectTargetCapabilities(targetVersion).identityColumns,
                    options: {
                      mode:
                        request.options.dataFormat === 'insert'
                          ? 'inserts'
                          : (request.options.dataFormat ?? 'copy'),
                      ...(request.options.rowsPerInsert === undefined
                        ? {}
                        : { rowsPerInsert: request.options.rowsPerInsert }),
                      ...(request.options.maxInsertStatementBytes === undefined
                        ? {}
                        : {
                            maxInsertStatementBytes: request.options.maxInsertStatementBytes,
                          }),
                      ...(request.options.explicitColumnLists === undefined
                        ? {}
                        : { explicitColumnLists: request.options.explicitColumnLists }),
                      ...(request.options.tableDataFormats === undefined
                        ? {}
                        : { tableModes: request.options.tableDataFormats }),
                      ...(request.options.excludedDataColumns === undefined
                        ? {}
                        : { excludedColumns: request.options.excludedDataColumns }),
                      ...(request.options.overridingSystemValue === undefined
                        ? {}
                        : {
                            overridingSystemValue: request.options.overridingSystemValue,
                          }),
                      ...(request.options.copyFreeze === undefined
                        ? {}
                        : { copyFreeze: request.options.copyFreeze }),
                    },
                    ...(request.signal === undefined ? {} : { signal: request.signal }),
                    onProgress: (event) =>
                      request.onProgress?.({
                        phase: 'writing-data',
                        message: dataSerializationProgressMessage(event, estimatedTotalRows),
                        completed: event.rowsSerialized,
                        ...(estimatedTotalRows === 0 ? {} : { total: estimatedTotalRows }),
                        ...(event.tableIdentity === undefined
                          ? {}
                          : { objectIdentity: event.tableIdentity }),
                        rowsWritten: event.rowsSerialized,
                        bytesWritten: event.bytesWritten,
                      }),
                  });
                  const exported = await new DataExportEngine().export(
                    {
                      connection,
                      plan,
                      ...(request.signal === undefined ? {} : { signal: request.signal }),
                      bestEffort: request.options.bestEffort ?? false,
                      onRecoverableTableError: (diagnostic) => serializer.recoverTable(diagnostic),
                    },
                    (batch) => serializer.consume(batch),
                  );
                  dataDiagnostics = exported.diagnostics;
                  omittedDataTables = plan.omittedTableIdentities.length;
                  if (exported.cancelled) throw toCancellationError(request.signal?.reason);
                  dataResult = await serializer.finish();
                },
              }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (rendered.cancelled) throw toCancellationError(request.signal?.reason);

        progress(
          'finalizing',
          'PostgreSQL schema dump complete.',
          archive.orderedEntries.length,
          archive.orderedEntries.length,
        );
        const warnings: DumpWarning[] = [
          ...introspection.diagnostics.map((diagnostic): DumpWarning => ({
            code: 'incomplete-metadata',
            severity: diagnostic.severity,
            message: diagnostic.message,
            ...(diagnostic.objectIdentity === undefined
              ? {}
              : { objectIdentity: diagnostic.objectIdentity }),
          })),
          ...rendered.warnings.map((warning): DumpWarning => ({
            code:
              warning.code === 'data-entry-skipped'
                ? 'data-export'
                : warning.code.startsWith('compatibility-')
                  ? 'compatibility-adjustment'
                  : 'unsupported-object',
            severity: 'warning',
            message: warning.message,
            objectIdentity: warning.archiveIdentity,
          })),
          ...dataDiagnostics.map((diagnostic): DumpWarning => ({
            code: diagnostic.code === 'permission-failure' ? 'permission-denied' : 'data-export',
            severity: 'warning',
            message: diagnostic.message,
            ...(diagnostic.tableIdentity === undefined
              ? {}
              : { objectIdentity: diagnostic.tableIdentity }),
            ...(diagnostic.cause === undefined ? {} : { cause: diagnostic.cause }),
          })),
        ];
        const renderedEntries = new Set(rendered.renderedDumpIds);
        return {
          sourceVersion: introspection.metadata.source.version,
          targetVersion,
          warnings,
          objectsWritten: rendered.renderedDumpIds.length,
          tablesWritten: archive.entries.filter(
            (entry) => entry.objectType === 'table' && renderedEntries.has(entry.dumpId),
          ).length,
          rowsWritten: dataResult?.totalRows ?? 0,
          bytesWritten: rendered.bytesWritten,
          tablesSkipped: (dataResult?.tablesSkipped ?? 0) + omittedDataTables,
          copyBlocks: dataResult?.copyBlocks ?? 0,
          insertStatements: dataResult?.insertStatements ?? 0,
          sequencesRestored: archive.entries.filter(
            (entry) => entry.objectType === 'sequence-state' && renderedEntries.has(entry.dumpId),
          ).length,
          largeObjectsWritten: largeObjectResult?.objectsWritten ?? 0,
          largeObjectBytesWritten: largeObjectResult?.bytesWritten ?? 0,
          elapsedMilliseconds: performance.now() - started,
          incomplete: dataResult?.incomplete ?? false,
          tableDataStatistics: dataResult?.tableStatistics ?? [],
          preflight,
        };
      },
      request.signal,
    );
  }
}
