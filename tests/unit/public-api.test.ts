/**
 * Contract tests for the package entry point.
 *
 * These tests intentionally avoid asserting internal architecture. They ensure
 * the production pipeline fails safely and cancellation wins before database
 * or stream work starts.
 */

import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  dumpPostgres,
  type DumpProgress,
  type PostgresConnection,
  type PostgresQueryResult,
  type PostgresRow,
} from '../../src/index.js';

interface ConnectionDouble {
  readonly connection: PostgresConnection;
  readonly queryCalls: () => number;
  readonly streamCalls: () => number;
}

function createConnection(): ConnectionDouble {
  let queryCalls = 0;
  let streamCalls = 0;

  return {
    connection: {
      query<Row extends PostgresRow>(): Promise<PostgresQueryResult<Row>> {
        queryCalls += 1;
        return Promise.reject(new Error('query should not be called'));
      },
      stream<Row extends PostgresRow>(): AsyncIterable<Row> {
        streamCalls += 1;
        throw new Error('stream should not be called');
      },
      getTransactionStatus() {
        return Promise.resolve('idle' as const);
      },
    },
    queryCalls: () => queryCalls,
    streamCalls: () => streamCalls,
  };
}

function createOutput(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe('dumpPostgres', () => {
  it('routes through introspection and preserves structured failures', async () => {
    const double = createConnection();
    const output = createOutput();

    await expect(dumpPostgres(double.connection, {}, output)).rejects.toMatchObject({
      code: 'INTROSPECTION_QUERY_FAILURE',
    });
    expect(double.queryCalls()).toBe(1);
    expect(double.streamCalls()).toBe(0);
  });

  it('reports an unsupported PostgreSQL source version as an error', async () => {
    const progress: DumpProgress[] = [];
    const connection: PostgresConnection = {
      query<Row extends PostgresRow>(): Promise<PostgresQueryResult<Row>> {
        return Promise.resolve({
          rows: [{ server_version: '9.5.25', server_version_num: '90525' } as unknown as Row],
          rowCount: 1,
        });
      },
      getTransactionStatus() {
        return Promise.resolve('idle' as const);
      },
    };

    await expect(
      dumpPostgres(connection, {}, createOutput(), (event) => progress.push(event)),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE_VERSION' });

    expect(progress.at(-1)).toMatchObject({
      phase: 'detecting-version',
      severity: 'error',
      message: 'PostgreSQL source version 9.5.25 is unsupported; version 9.6 or newer is required.',
    });
  });

  it('honors an already-aborted signal before touching external resources', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by test'));

    await expect(
      dumpPostgres(createConnection().connection, {}, createOutput(), undefined, controller.signal),
    ).rejects.toThrow('cancelled by test');
  });
});
