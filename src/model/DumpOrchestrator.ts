/**
 * Application-layer coordinator for a complete dump.
 *
 * The future implementation will detect versions, introspect catalog objects,
 * create an ordered dump plan, apply compatibility rules, render schema SQL,
 * stream table data, collect warnings, and finalize output. It will coordinate
 * those services without implementing any of their low-level responsibilities.
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
import { introspectPostgres } from '../introspection/introspectPostgres.js';
import { renderPlainSql } from '../renderer/PlainSqlRenderer.js';
import { throwIfAborted } from '../utils/abort.js';
import { toCancellationError } from '../utils/errors.js';
import { StreamDumpWriter } from '../writer/DumpWriter.js';

/** Dependencies and request data for one isolated dump execution. */
export interface DumpRequest {
  readonly connection: PostgresConnectionInput;
  readonly options: DumpOptions;
  readonly output: Writable;
  readonly onProgress: DumpProgressCallback | undefined;
  readonly signal: AbortSignal | undefined;
}

/** Coordinates the clean-architecture services that implement the use case. */
export class DumpOrchestrator {
  async dump(request: DumpRequest): Promise<DumpResult> {
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
    const introspection = await introspectPostgres(
      request.connection,
      {
        transactionMode:
          request.options.transactionMode ??
          (request.options.useTransaction === false ? 'none' : 'managed'),
        ...(request.options.selection === undefined
          ? {}
          : { selection: request.options.selection }),
      },
      request.signal,
    );

    progress('planning', 'Building and ordering the dump archive.');
    const selection = request.options.selection;
    const archive = inspectDumpArchive(introspection.database, {
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

    const renderOptions = toPlainSqlRenderOptions(request.options);
    const writer = new StreamDumpWriter(request.output, {
      lineEnding: renderOptions.lineEnding ?? '\n',
    });
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
    ];
    const renderedEntries = new Set(rendered.renderedDumpIds);
    return {
      sourceVersion: introspection.metadata.source.version,
      targetVersion: renderOptions.targetVersion ?? introspection.metadata.source.version,
      warnings,
      objectsWritten: rendered.renderedDumpIds.length,
      tablesWritten: archive.entries.filter(
        (entry) => entry.objectType === 'table' && renderedEntries.has(entry.dumpId),
      ).length,
      rowsWritten: 0,
      bytesWritten: rendered.bytesWritten,
    };
  }
}
