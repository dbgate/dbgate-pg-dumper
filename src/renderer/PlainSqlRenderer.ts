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

const DATA_OBJECT_TYPES = new Set(['table-data', 'materialized-view-data', 'large-object-data']);

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
    if (options.includeCreateDatabase && options.transactionMode !== 'none') {
      throw new RenderError('CREATE DATABASE cannot be emitted inside a restore transaction.');
    }

    const warnings = new PlainSqlWarningCollector();
    const rendered: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const selectedEntries = archive.orderedEntries.filter((entry) => entry.selection.selected);
    const transactionIncompatible = selectedEntries.find(
      (entry) =>
        entry.objectType === 'tablespace' ||
        entry.objectType === 'subscription' ||
        (entry.objectType === 'database' && options.includeCreateDatabase),
    );
    if (options.transactionMode !== 'none' && transactionIncompatible !== undefined) {
      throw new RenderError(
        `${transactionIncompatible.objectType} cannot be emitted inside a restore transaction; no output was written.`,
      );
    }
    const tableDataEntries = selectedEntries.filter((entry) => entry.objectType === 'table-data');
    const largeObjectDataEntries = selectedEntries.filter(
      (entry) => entry.objectType === 'large-object-data',
    );
    let tableDataHandled = false;
    let largeObjectDataHandled = false;
    let activeTransactionSection: (typeof selectedEntries)[number]['section'] | undefined;

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

      if (options.transactionMode === 'single') {
        await writer.writeLine(`${keyword('BEGIN', options.keywordCase)};`, signal);
        await writer.writeLine('', signal);
      }

      if (options.clean) {
        if (options.transactionMode === 'sections') {
          activeTransactionSection = selectedEntries[0]?.section;
          if (activeTransactionSection !== undefined) {
            await writer.writeLine(`${keyword('BEGIN', options.keywordCase)};`, signal);
            await writer.writeLine('', signal);
          }
        }
        for (const entry of [...selectedEntries].reverse()) {
          throwIfAborted(signal);
          if (entry.extensionMembership?.emitIndependently === false) continue;
          const statements = this.entryRenderer.renderDrop(contextFor(entry));
          await this.writeStatements(statements, contextFor(entry), signal, false);
        }
      }

      for (const entry of selectedEntries) {
        throwIfAborted(signal);
        if (options.transactionMode === 'sections') {
          if (activeTransactionSection === undefined) {
            activeTransactionSection = entry.section;
            await writer.writeLine(`${keyword('BEGIN', options.keywordCase)};`, signal);
            await writer.writeLine('', signal);
          } else if (activeTransactionSection !== entry.section) {
            await writer.writeLine(`${keyword('COMMIT', options.keywordCase)};`, signal);
            await writer.writeLine('', signal);
            await writer.writeLine(`${keyword('BEGIN', options.keywordCase)};`, signal);
            await writer.writeLine('', signal);
            activeTransactionSection = entry.section;
          }
        }
        if (
          entry.objectType === 'large-object-data' &&
          request.renderLargeObjectData !== undefined
        ) {
          if (!largeObjectDataHandled) {
            await request.renderLargeObjectData(largeObjectDataEntries);
            rendered.push(...largeObjectDataEntries.map((item) => item.dumpId));
            largeObjectDataHandled = true;
          }
          continue;
        }
        if (entry.objectType === 'table-data' && request.renderTableData !== undefined) {
          if (!tableDataHandled) {
            if (options.triggerMode === 'replica-role') {
              await writer.writeLine(
                '-- WARNING: replica-role loading suppresses user triggers and requires elevated privileges.',
                signal,
              );
              await writer.writeLine(
                `${keyword('SET', options.keywordCase)} session_replication_role = replica;`,
                signal,
              );
              await writer.writeLine('', signal);
            }
            await request.renderTableData(tableDataEntries);
            if (options.triggerMode === 'replica-role') {
              await writer.writeLine(
                `${keyword('SET', options.keywordCase)} session_replication_role = origin;`,
                signal,
              );
              await writer.writeLine('', signal);
            }
            rendered.push(...tableDataEntries.map((item) => item.dumpId));
            tableDataHandled = true;
          }
          continue;
        }
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

      if (options.transactionMode === 'single' || activeTransactionSection !== undefined) {
        await writer.writeLine(`${keyword('COMMIT', options.keywordCase)};`, signal);
        await writer.writeLine('', signal);
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
    await writer.writeLine(`${k('SET')} DateStyle = 'ISO';`, signal);
    await writer.writeLine(`${k('SET')} IntervalStyle = 'postgres';`, signal);
    await writer.writeLine(`${k('SET')} TimeZone = 'UTC';`, signal);
    await writer.writeLine(`${k('SET')} bytea_output = 'hex';`, signal);
    await writer.writeLine(`${k('SET')} extra_float_digits = 3;`, signal);
    await writer.writeLine(`${k('SET')} lc_monetary = 'C';`, signal);
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
