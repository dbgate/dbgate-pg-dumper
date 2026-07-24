/**
 * Large-object tests exercise byte fidelity and every cleanup boundary without
 * requiring a PostgreSQL server. Catalog rows contain only bounded hex pages.
 */

import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type {
  PostgresConnection,
  PostgresQuery,
  PostgresQueryResult,
  PostgresRow,
} from '../../src/index.js';
import { LargeObjectExporter, StreamDumpWriter, StringDumpWriter } from '../../src/index.js';

function streamed(rows: readonly PostgresRow[]): PostgresConnection {
  return {
    query: () => Promise.reject(new Error('SQL cursor fallback was not expected.')),
    stream<Row extends PostgresRow>() {
      return (async function* () {
        await Promise.resolve();
        for (const row of rows) yield row as Row;
      })();
    },
    getTransactionStatus: () => Promise.resolve('in-transaction'),
  };
}

describe('LargeObjectExporter', () => {
  it('preserves bytes, original OID, and sparse page offsets', async () => {
    const writer = new StringDumpWriter();
    const progress: number[] = [];
    const result = await new LargeObjectExporter().export({
      connection: streamed([
        { pageno: 0, data_hex: '00ff27' },
        { pageno: 2, data_hex: 'deadbeef' },
      ]),
      objectOids: [42],
      writer,
      onProgress: (event) => progress.push(event.bytesWritten),
    });

    expect(writer.toString()).toContain(
      "SELECT pg_catalog.lo_put(42, 0, decode('00ff27', 'hex'));",
    );
    expect(writer.toString()).toContain(
      "SELECT pg_catalog.lo_put(42, 4096, decode('deadbeef', 'hex'));",
    );
    expect(result).toEqual({
      objectsWritten: 1,
      pagesWritten: 2,
      bytesWritten: 7,
      sparsePageGaps: 1,
    });
    expect(progress).toEqual([3, 7]);
  });

  it('uses a bounded SQL cursor fallback and closes it', async () => {
    const calls: string[] = [];
    let fetch = 0;
    const connection: PostgresConnection = {
      query<Row extends PostgresRow>(query: PostgresQuery): Promise<PostgresQueryResult<Row>> {
        calls.push(query.text);
        if (query.text.startsWith('FETCH')) {
          fetch += 1;
          const rows = fetch === 1 ? [{ pageno: 0, data_hex: '01' }] : [];
          return Promise.resolve({ rows: rows as unknown as Row[], rowCount: rows.length });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      getTransactionStatus: () => Promise.resolve('in-transaction'),
    };

    await new LargeObjectExporter().export({
      connection,
      objectOids: [9],
      writer: new StringDumpWriter(),
    });

    expect(calls[0]).toMatch(/^DECLARE "dbgate_lo_\d+" NO SCROLL CURSOR/u);
    expect(calls.some((sql) => sql === 'FETCH FORWARD 128 FROM "dbgate_lo_1"')).toBe(true);
    expect(calls.at(-1)).toMatch(/^CLOSE "dbgate_lo_\d+"/u);
  });

  it('closes the adapter iterator when cancelled during an object', async () => {
    const controller = new AbortController();
    let cleaned = false;
    const connection: PostgresConnection = {
      query: () => Promise.reject(new Error('unused')),
      stream<Row extends PostgresRow>() {
        return (async function* () {
          try {
            await Promise.resolve();
            yield { pageno: 0, data_hex: '01' } as unknown as Row;
            yield { pageno: 1, data_hex: '02' } as unknown as Row;
          } finally {
            cleaned = true;
          }
        })();
      },
      getTransactionStatus: () => Promise.resolve('in-transaction'),
    };

    await expect(
      new LargeObjectExporter().export({
        connection,
        objectOids: [7],
        writer: new StringDumpWriter(),
        signal: controller.signal,
        onProgress: () => controller.abort('test cancellation'),
      }),
    ).rejects.toBeDefined();
    expect(cleaned).toBe(true);
  });

  it('rejects malformed pages without exposing page contents in the error', async () => {
    await expect(
      new LargeObjectExporter().export({
        connection: streamed([{ pageno: -1, data_hex: 'private-data' }]),
        objectOids: [8],
        writer: new StringDumpWriter(),
      }),
    ).rejects.toMatchObject({
      code: 'DATA_EXPORT_FAILURE',
      diagnostic: { code: 'cursor-failure' },
    });
  });

  it('fails the export when the writable sink fails', async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('disk full'));
      },
    });
    await expect(
      new LargeObjectExporter().export({
        connection: streamed([{ pageno: 0, data_hex: '00' }]),
        objectOids: [10],
        writer: new StreamDumpWriter(output),
      }),
    ).rejects.toMatchObject({ code: 'DATA_EXPORT_FAILURE' });
  });
});
