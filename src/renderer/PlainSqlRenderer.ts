/**
 * Streaming orchestration for deterministic plain PostgreSQL schema dumps.
 *
 * This layer walks an already validated and ordered archive. It owns document
 * framing and accounting, while object-specific syntax remains isolated in
 * `PostgresSqlRenderer`. No renderer in this package accesses a connection.
 */

import type { PostgresDatabase } from '../model/PostgresDatabase.js';
import { CancellationError, RenderError } from '../utils/errors.js';
import { detectTargetCapabilities } from '../compatibility/TargetCapabilities.js';
import { throwIfAborted } from '../utils/abort.js';
import {
  normalizePlainSqlRenderOptions,
  PlainSqlWarningCollector,
  type PlainSqlRenderContext,
  type PlainSqlRenderRequest,
  type PlainSqlRenderResult,
} from './RenderTypes.js';
import { keyword, quoteStringLiteral } from './SqlPrimitives.js';
import { PostgresSqlRenderer, type ArchiveEntrySqlRenderer } from './SqlRenderer.js';

const DATA_OBJECT_TYPES = new Set(['table-data', 'materialized-view-data', 'sequence-state']);

/** Renders one archive to the request writer without buffering the document. */
export async function renderPlainSql(
  request: PlainSqlRenderRequest,
): Promise<PlainSqlRenderResult> {
  return new PlainSqlArchiveRenderer().render(request);
}

/** Stateful only for one invocation, making render accounting easy to audit. */
export class PlainSqlArchiveRenderer {
  constructor(
    private readonly entryRenderer: ArchiveEntrySqlRenderer = new PostgresSqlRenderer(),
  ) {}

  async render(request: PlainSqlRenderRequest): Promise<PlainSqlRenderResult> {
    const { archive, sourceVersion, sourceCapabilities, writer, signal } = request;
    if (!archive.valid) {
      throw new RenderError('Cannot render an invalid dump archive.');
    }

    const options = normalizePlainSqlRenderOptions(sourceVersion, request.options);
    if (writer.lineEnding !== options.lineEnding) {
      throw new RenderError('The writer and renderer must use the same configured line ending.');
    }

    const warnings = new PlainSqlWarningCollector();
    const rendered: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const selectedEntries = archive.orderedEntries.filter((entry) => entry.selection.selected);

    const contextFor = (entry: (typeof selectedEntries)[number]): PlainSqlRenderContext => ({
      sourceVersion,
      targetVersion: options.targetVersion,
      sourceCapabilities,
      targetCapabilities: detectTargetCapabilities(options.targetVersion),
      options,
      archive,
      entry,
      identifierPolicy: { quoteAllIdentifiers: options.quoteAllIdentifiers },
      warnings,
      writer,
    });

    try {
      throwIfAborted(signal);
      await this.writeHeader(request, options, signal);

      if (options.clean) {
        for (const entry of [...selectedEntries].reverse()) {
          throwIfAborted(signal);
          if (entry.extensionMembership?.emitIndependently === false) continue;
          const statements = this.entryRenderer.renderDrop(contextFor(entry));
          await this.writeStatements(statements, contextFor(entry), signal, false);
        }
      }

      for (const entry of selectedEntries) {
        throwIfAborted(signal);
        if (DATA_OBJECT_TYPES.has(entry.objectType)) {
          skipped.push(entry.dumpId);
          warnings.add({
            code: 'data-entry-skipped',
            message: `${entry.objectType} is selected, but data export is not implemented yet.`,
            archiveIdentity: entry.archiveIdentity,
            dumpId: entry.dumpId,
          });
          continue;
        }
        if (entry.extensionMembership?.emitIndependently === false) {
          skipped.push(entry.dumpId);
          continue;
        }

        const context = contextFor(entry);
        try {
          const statements = this.entryRenderer.renderCreate(context);
          if (statements.length === 0) {
            skipped.push(entry.dumpId);
          } else {
            await this.writeStatements(statements, context, signal, true);
            rendered.push(entry.dumpId);
          }
        } catch (cause) {
          failed.push(entry.dumpId);
          throw cause;
        }
      }

      await writer.writeLine('--', signal);
      await writer.writeLine('-- PostgreSQL schema dump complete', signal);
      await writer.flush(signal);
    } catch (cause) {
      if (cause instanceof CancellationError || signal?.aborted) {
        return this.result(writer.bytesWritten, rendered, skipped, failed, warnings, true);
      }
      throw cause;
    }

    return this.result(writer.bytesWritten, rendered, skipped, failed, warnings, false);
  }

  private async writeHeader(
    request: PlainSqlRenderRequest,
    options: ReturnType<typeof normalizePlainSqlRenderOptions>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const { writer, sourceVersion } = request;
    const k = (value: string): string => keyword(value, options.keywordCase);
    const database = request.archive.entries.find((entry) => entry.objectType === 'database')
      ?.sourceObject as PostgresDatabase | undefined;
    const encoding = database?.encoding ?? 'UTF8';
    const targetCapabilities = detectTargetCapabilities(options.targetVersion);

    await writer.writeLine('--', signal);
    await writer.writeLine('-- dbgate-pg-dumper PostgreSQL schema dump', signal);
    await writer.writeLine(`-- Source PostgreSQL: ${sourceVersion.normalizedMajor}`, signal);
    await writer.writeLine(
      `-- Target PostgreSQL: ${options.targetVersion.normalizedMajor}`,
      signal,
    );
    if (options.includeTimestamp) {
      await writer.writeLine(`-- Generated at: ${new Date().toISOString()}`, signal);
    }
    await writer.writeLine('--', signal);
    await writer.writeLine('', signal);
    await writer.writeLine(`${k('SET')} statement_timeout = 0;`, signal);
    await writer.writeLine(`${k('SET')} lock_timeout = 0;`, signal);
    if (targetCapabilities.idleInTransactionSessionTimeout) {
      await writer.writeLine(`${k('SET')} idle_in_transaction_session_timeout = 0;`, signal);
    }
    await writer.writeLine(
      `${k('SET')} client_encoding = ${quoteStringLiteral(encoding)};`,
      signal,
    );
    await writer.writeLine(`${k('SET')} standard_conforming_strings = on;`, signal);
    await writer.writeLine(`${k('SET')} check_function_bodies = false;`, signal);
    await writer.writeLine(`${k('SET')} client_min_messages = warning;`, signal);
    await writer.writeLine(`${k('SET')} row_security = off;`, signal);
    await writer.writeLine(
      `${k('SELECT')} pg_catalog.set_config('search_path', '', false);`,
      signal,
    );
    await writer.writeLine('', signal);
  }

  private async writeStatements(
    statements: readonly string[],
    context: PlainSqlRenderContext,
    signal: AbortSignal | undefined,
    includeDiagnosticComment: boolean,
  ): Promise<void> {
    if (statements.length === 0) return;
    if (includeDiagnosticComment && context.options.statementComments) {
      await context.writer.writeLine(
        `-- Entry ${context.entry.dumpId}: ${context.entry.archiveIdentity}`,
        signal,
      );
    }
    for (const statement of statements) {
      await context.writer.writeLine(statement, signal);
    }
    await context.writer.writeLine('', signal);
  }

  private result(
    bytesWritten: number,
    renderedDumpIds: readonly string[],
    skippedDumpIds: readonly string[],
    failedDumpIds: readonly string[],
    collector: PlainSqlWarningCollector,
    cancelled: boolean,
  ): PlainSqlRenderResult {
    const warnings = collector.getAll();
    return {
      bytesWritten,
      renderedDumpIds: [...renderedDumpIds],
      skippedDumpIds: [...skippedDumpIds],
      failedDumpIds: [...failedDumpIds],
      warnings,
      compatibilityTransformations: warnings.flatMap((warning) =>
        warning.transformation === undefined ? [] : [warning.transformation],
      ),
      unsupportedObjects: warnings
        .filter((warning) => warning.code === 'unsupported-object')
        .map((warning) => warning.archiveIdentity),
      cancelled,
    };
  }
}
