import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  restoreSqlDump,
  SqlDumpRestoreError,
  type PostgresQuery,
  type PostgresQueryResult,
  type PostgresRestoreConnection,
  type PostgresRow,
  type PostgresTransactionStatus,
  type RestoreCopyFromRequest,
  type SqlDumpRestoreProgress,
} from '../../src/index.js';

const HEADER = '--\n-- dbgate-pg-dumper PostgreSQL schema dump\n--\n\n';

class SqlRestoreConnection implements PostgresRestoreConnection {
  readonly queries: string[] = [];
  readonly copyCommands: string[] = [];
  readonly copyPayloads: Buffer[] = [];
  transactionStatus: PostgresTransactionStatus = 'idle';
  failPattern: RegExp | undefined;
  insertRowCount = 0;

  query<Row extends PostgresRow = PostgresRow>(
    query: PostgresQuery,
    signal?: AbortSignal,
  ): Promise<PostgresQueryResult<Row>> {
    signal?.throwIfAborted();
    this.queries.push(query.text);
    if (this.failPattern?.test(query.text)) {
      return Promise.reject(
        Object.assign(new Error('deliberate SQL failure'), {
          code: '42601',
          position: '8',
        }),
      );
    }
    if (/\bBEGIN\s*;/iu.test(query.text)) this.transactionStatus = 'in-transaction';
    if (/\b(?:ROLLBACK|COMMIT)\b/iu.test(query.text)) this.transactionStatus = 'idle';
    return Promise.resolve({
      rows: [],
      rowCount: /^\s*INSERT\b/iu.test(query.text) ? this.insertRowCount : 0,
    });
  }

  openCopyFrom(request: RestoreCopyFromRequest) {
    this.copyCommands.push(request.query);
    const chunks: Buffer[] = [];
    let resolveCompletion!: (result: { readonly rowCount?: number }) => void;
    let rejectCompletion!: (cause: unknown) => void;
    const completion = new Promise<{ readonly rowCount?: number }>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const writable = new Writable({
      write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        const payload = Buffer.concat(chunks);
        this.copyPayloads.push(payload);
        resolveCompletion({
          rowCount: payload.length === 0 ? 0 : payload.toString('utf8').split('\n').length - 1,
        });
        callback();
      },
      destroy: (error, callback) => {
        if (error !== null) rejectCompletion(error);
        callback(error);
      },
    });
    return Promise.resolve({
      writable,
      completion,
      abort: async (reason?: Error) => {
        writable.destroy(reason);
        await completion.catch(() => undefined);
      },
    });
  }

  getTransactionStatus(): Promise<PostgresTransactionStatus> {
    return Promise.resolve(this.transactionStatus);
  }
}

describe('sequential SQL dump restore', () => {
  it('executes SQL in order, streams COPY through the native loader, and reports progress', async () => {
    const connection = new SqlRestoreConnection();
    const events: SqlDumpRestoreProgress[] = [];
    const dump =
      HEADER +
      `BEGIN;\n` +
      `CREATE TABLE public.items (id integer, payload text);\n` +
      `COPY public.items (id, payload) FROM stdin;\n` +
      `1\tone\n2\ttwo\\nlines\n\\.\n` +
      `COMMIT;\n`;

    const result = await restoreSqlDump({
      source: Readable.from(Array.from(Buffer.from(dump), (byte) => Buffer.from([byte]))),
      connection,
      options: { progressThrottleMilliseconds: 60_000 },
      progress: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      status: 'success',
      operationsCompleted: 4,
      statementsCompleted: 3,
      copyBlocksCompleted: 1,
      rowsRestored: 2,
      bytesRead: Buffer.byteLength(dump),
    });
    expect(connection.copyCommands).toEqual([
      `COPY "public"."items" ("id", "payload") FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`,
    ]);
    expect(connection.copyPayloads[0]?.toString('utf8')).toBe(`1\tone\n2\ttwo\\nlines\n`);
    expect(events.map((event) => event.phase)).toEqual(['started', 'completed']);
    expect(events.at(-1)).toMatchObject({ operationsCompleted: 4, rowsRestored: 2 });
  });

  it('counts INSERT rows and can expose unthrottled intermediate progress', async () => {
    const connection = new SqlRestoreConnection();
    connection.insertRowCount = 3;
    const events: SqlDumpRestoreProgress[] = [];

    const result = await restoreSqlDump({
      source: Readable.from([`${HEADER}INSERT INTO public.items VALUES (1), (2), (3);\n`]),
      connection,
      options: { progressThrottleMilliseconds: 0 },
      progress: (event) => events.push(event),
    });

    expect(result).toMatchObject({ operationsCompleted: 1, rowsRestored: 3 });
    expect(events.map((event) => event.phase)).toEqual([
      'started',
      'statement-started',
      'statement-completed',
      'completed',
    ]);
    expect(events.at(-1)).toMatchObject({ operationsCompleted: 1, rowsRestored: 3 });
  });

  it('reports the file location and rolls back an active dump transaction on SQL errors', async () => {
    const connection = new SqlRestoreConnection();
    connection.failPattern = /SELECT fail/u;
    const dump = `${HEADER}BEGIN;\nSELECT fail;\nCOMMIT;\n`;
    let error: unknown;
    try {
      await restoreSqlDump({ source: Readable.from([dump]), connection });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(SqlDumpRestoreError);
    expect(error).toMatchObject({
      code: 'RESTORE_SQL_FAILED',
      fileOffset: Buffer.byteLength(`${HEADER}BEGIN;\nSELECT `),
      line: 6,
      column: 8,
      operationNumber: 2,
      fields: { sqlState: '42601', position: '8' },
    });
    expect(connection.queries.at(-1)).toBe('ROLLBACK');
  });

  it('explains when the connection cannot stream COPY FROM STDIN', async () => {
    const baseConnection = new SqlRestoreConnection();
    const connection: PostgresRestoreConnection = {
      query: baseConnection.query.bind(baseConnection),
      getTransactionStatus: baseConnection.getTransactionStatus.bind(baseConnection),
    };
    const dump =
      HEADER +
      `CREATE TABLE public.items (id integer);\n` +
      `COPY public.items (id) FROM stdin;\n` +
      `1\n\\.\n`;

    await expect(
      restoreSqlDump({ source: Readable.from([dump]), connection }),
    ).rejects.toMatchObject({
      code: 'RESTORE_COPY_FAILED',
      operationNumber: 2,
      message:
        'SQL dump COPY operation 2 failed near line 7. ' +
        'The PostgreSQL restore connection does not support COPY FROM STDIN.',
      fields: {
        serverMessage: 'The PostgreSQL restore connection does not support COPY FROM STDIN.',
      },
    });
  });

  it('cancels before acquiring operations and destroys the source', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = Readable.from([`${HEADER}SELECT 1;`]);
    await expect(
      restoreSqlDump({ source, connection: new SqlRestoreConnection(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'RESTORE_CANCELLED' });
    expect(source.destroyed).toBe(true);
  });
});
