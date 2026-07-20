/**
 * Bounded PostgreSQL large-object export.
 *
 * PostgreSQL stores large objects as independently addressable 2 KiB pages in
 * `pg_largeobject`. This service streams those pages in OID/page order and
 * emits `lo_put` calls, so memory use is bounded by one catalog row and the
 * caller's writable-stream buffer. Page offsets are retained exactly; gaps
 * therefore remain sparse zero-filled regions when PostgreSQL restores them.
 *
 * Access failures are deliberately fatal. Silently omitting an unreadable page
 * would produce a valid-looking but corrupt dump.
 */

import type { PostgresConnection, PostgresRow } from '../connection/PostgresConnection.js';
import { quoteIdentifier } from '../renderer/SqlPrimitives.js';
import { throwIfAborted } from '../utils/abort.js';
import { DataExportError } from '../utils/errors.js';
import type { DumpWriter } from '../writer/DumpWriter.js';

const LARGE_OBJECT_PAGE_SIZE = 2048;
let cursorSequence = 0;

interface LargeObjectPageRow extends PostgresRow {
  readonly pageno: unknown;
  readonly data_hex: unknown;
}

export interface LargeObjectExportProgress {
  readonly objectOid: number;
  readonly pagesWritten: number;
  readonly bytesWritten: number;
}

export interface LargeObjectExportResult {
  readonly objectsWritten: number;
  readonly pagesWritten: number;
  readonly bytesWritten: number;
  readonly sparsePageGaps: number;
}

export interface LargeObjectExportRequest {
  readonly connection: PostgresConnection;
  readonly objectOids: readonly number[];
  readonly writer: DumpWriter;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: LargeObjectExportProgress) => void;
}

/** Streams selected large objects as psql-compatible SQL without buffering an object. */
export class LargeObjectExporter {
  async export(request: LargeObjectExportRequest): Promise<LargeObjectExportResult> {
    let objectsWritten = 0;
    let pagesWritten = 0;
    let bytesWritten = 0;
    let sparsePageGaps = 0;

    for (const objectOid of request.objectOids) {
      throwIfAborted(request.signal);
      let expectedPage = 0;
      let objectPages = 0;
      let objectBytes = 0;
      try {
        for await (const row of this.streamPages(request.connection, objectOid, request.signal)) {
          throwIfAborted(request.signal);
          const pageNumber = this.pageNumber(row.pageno, objectOid);
          const hex = this.pageHex(row.data_hex, objectOid, pageNumber);
          if (pageNumber < expectedPage) {
            throw new Error(`Large-object pages are not strictly ordered for OID ${objectOid}.`);
          }
          if (pageNumber > expectedPage) sparsePageGaps += pageNumber - expectedPage;

          await request.writer.writeLine(
            `SELECT pg_catalog.lo_put(${objectOid}, ${pageNumber * LARGE_OBJECT_PAGE_SIZE}, decode('${hex}', 'hex'));`,
            request.signal,
          );
          expectedPage = pageNumber + 1;
          objectPages += 1;
          objectBytes += hex.length / 2;
          pagesWritten += 1;
          bytesWritten += hex.length / 2;
          request.onProgress?.({
            objectOid,
            pagesWritten: objectPages,
            bytesWritten: objectBytes,
          });
        }
      } catch (cause) {
        if (request.signal?.aborted) throw cause;
        throw new DataExportError(
          `Failed to export PostgreSQL large object ${objectOid}; the dump is incomplete.`,
          {
            code: 'cursor-failure',
            severity: 'error',
            message: `Large object ${objectOid} could not be read completely.`,
            cause: cause instanceof Error ? cause.message : 'Unknown large-object read failure.',
          },
          { cause },
        );
      }
      objectsWritten += 1;
      await request.writer.writeLine('', request.signal);
    }

    return { objectsWritten, pagesWritten, bytesWritten, sparsePageGaps };
  }

  private async *streamPages(
    connection: PostgresConnection,
    objectOid: number,
    signal?: AbortSignal,
  ): AsyncGenerator<LargeObjectPageRow> {
    const select =
      "SELECT pageno, pg_catalog.encode(data, 'hex') AS data_hex " +
      `FROM pg_catalog.pg_largeobject WHERE loid = ${objectOid} ORDER BY pageno`;

    if (connection.stream !== undefined) {
      yield* connection.stream<LargeObjectPageRow>(
        { text: select },
        { batchSize: 128, ...(signal === undefined ? {} : { signal }) },
      );
      return;
    }

    cursorSequence += 1;
    const cursor = quoteIdentifier(`dbgate_lo_${cursorSequence}`, {
      quoteAllIdentifiers: true,
    });
    let declared = false;
    try {
      await connection.query({ text: `DECLARE ${cursor} NO SCROLL CURSOR FOR ${select}` }, signal);
      declared = true;
      while (true) {
        throwIfAborted(signal);
        const result = await connection.query<LargeObjectPageRow>(
          { text: `FETCH FORWARD 128 FROM ${cursor}` },
          signal,
        );
        for (const row of result.rows) yield row;
        if (result.rows.length < 128) break;
      }
    } finally {
      if (declared) {
        try {
          await connection.query({ text: `CLOSE ${cursor}` });
        } catch {
          // A failed transaction or connection closes the cursor itself. The
          // original read/cancellation error remains the actionable failure.
        }
      }
    }
  }

  private pageNumber(value: unknown, objectOid: number): number {
    const page = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(page) || page < 0) {
      throw new Error(`Large object ${objectOid} returned malformed page metadata.`);
    }
    return page;
  }

  private pageHex(value: unknown, objectOid: number, pageNumber: number): string {
    if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(value)) {
      throw new Error(`Large object ${objectOid} returned malformed data for page ${pageNumber}.`);
    }
    if (value.length > LARGE_OBJECT_PAGE_SIZE * 2) {
      throw new Error(`Large object ${objectOid} page ${pageNumber} exceeds 2 KiB.`);
    }
    return value;
  }
}
