import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  buildCopyFromCommand,
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  InMemoryRestoreArchiveSource,
  RESTORE_ARCHIVE_FORMAT,
  RESTORE_ARCHIVE_FORMAT_VERSION,
  type PostgresQuery,
  type PostgresQueryResult,
  type PostgresRestoreConnection,
  type PostgresRow,
  type PostgresTransactionStatus,
  type RestoreDataOperation,
} from '../../src/index.js';
import { loadCopyText } from '../../src/restore/CopyTextLoader.js';

function operation(overrides: Partial<RestoreDataOperation> = {}): RestoreDataOperation {
  return {
    kind: 'table-data',
    table: { schema: 'Odd "schema', table: 'select' },
    columns: ['second', 'First "column'],
    format: 'copy-text',
    copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
    dataSourceId: 'payload',
    identityBehavior: 'preserve',
    partitionBehavior: 'target-table',
    transactionRequirement: 'allowed',
    ...overrides,
  };
}

function archive(payload?: string | (() => Readable)): InMemoryRestoreArchiveSource {
  return new InMemoryRestoreArchiveSource({
    metadata: {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: 'copy-unit',
      sourceVersion: {
        complete: 'PostgreSQL 18',
        number: 180000,
        normalizedMajor: '18',
        major: 18,
        minor: 0,
        patch: 0,
      },
      requiredExtensions: [],
      requiredRoles: [],
      requiredPrivileges: [],
      requiredTablespaces: [],
      transactionCompatibility: 'compatible',
      diagnostics: [],
    },
    entries: [],
    ...(payload === undefined ? {} : { data: new Map([['payload', payload]]) }),
  });
}

class CopyConnection implements PostgresRestoreConnection {
  readonly received: Buffer[] = [];
  copyCount = 0;
  abortCount = 0;
  failCompletion?: Error;
  failWrite?: Error;
  writeDelay = 0;
  activeWrites = 0;
  maximumActiveWrites = 0;

  query<Row extends PostgresRow>(
    _query: PostgresQuery,
    signal?: AbortSignal,
  ): Promise<PostgresQueryResult<Row>> {
    signal?.throwIfAborted();
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  getTransactionStatus(): Promise<PostgresTransactionStatus> {
    return Promise.resolve('idle');
  }

  openCopyFrom(): Promise<{
    readonly writable: Writable;
    readonly completion: Promise<{ readonly rowCount?: number }>;
    abort(reason?: Error): Promise<void>;
  }> {
    this.copyCount += 1;
    let resolveCompletion!: (result: { readonly rowCount?: number }) => void;
    let rejectCompletion!: (cause: unknown) => void;
    const completion = new Promise<{ readonly rowCount?: number }>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    let aborted = false;
    const writable = new Writable({
      highWaterMark: 4,
      write: (chunk: Buffer, _encoding, callback) => {
        this.activeWrites += 1;
        this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.activeWrites);
        setTimeout(() => {
          if (this.failWrite !== undefined) {
            this.activeWrites -= 1;
            callback(this.failWrite);
            return;
          }
          this.received.push(Buffer.from(chunk));
          this.activeWrites -= 1;
          callback();
        }, this.writeDelay);
      },
      final: (callback) => {
        callback();
        if (this.failCompletion === undefined) {
          resolveCompletion({
            rowCount: Buffer.concat(this.received).toString('utf8').split('\n').length - 1,
          });
        } else {
          rejectCompletion(this.failCompletion);
        }
      },
    });
    return Promise.resolve({
      writable,
      completion,
      abort: async (reason) => {
        if (aborted) return;
        aborted = true;
        this.abortCount += 1;
        writable.destroy(reason);
        rejectCompletion(reason);
        await Promise.resolve();
      },
    });
  }
}

describe('native COPY text restore', () => {
  it('generates deterministic COPY SQL with every identifier quoted in column order', () => {
    expect(buildCopyFromCommand(operation())).toBe(
      `COPY "Odd ""schema"."select" ("second", "First ""column") FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`,
    );
    expect(() => buildCopyFromCommand(operation({ columns: [] }))).toThrow(/at least one/u);
  });

  it('streams with backpressure and reports format-aware rows and bytes', async () => {
    const connection = new CopyConnection();
    connection.writeDelay = 1;
    const chunks = Array.from({ length: 40 }, (_, index) => `${String(index)}\tvalue\\n${index}\n`);
    const progress: number[] = [];
    const result = await loadCopyText({
      archive: archive(() => Readable.from(chunks)),
      connection,
      operation: operation(),
      stepId: 'step',
      archiveEntryId: 'entry',
      onProgress: (item) => progress.push(item.bytes),
    });
    expect(result.rows).toBe(40);
    expect(result.bytes).toBe(Buffer.byteLength(chunks.join('')));
    expect(result.serverRowCount).toBe(40);
    expect(progress.at(-1)).toBe(result.bytes);
    expect(progress.length).toBeLessThan(chunks.length);
    expect(connection.maximumActiveWrites).toBe(1);
  });

  it('verifies SHA-256 while streaming and strips only a declared final psql marker', async () => {
    const payload = '1\tliteral\\\\.\\n\n2\t\\\\N\n';
    const checksum = createHash('sha256').update(payload).digest('hex');
    const connection = new CopyConnection();
    const result = await loadCopyText({
      archive: archive(`${payload}\\.\n`),
      connection,
      operation: operation({
        copyText: { ...CANONICAL_RESTORE_COPY_TEXT_FORMAT, endMarker: 'psql' },
        checksum: { algorithm: 'sha256', value: checksum },
      }),
      stepId: 'step',
      archiveEntryId: 'entry',
    });
    expect(Buffer.concat(connection.received).toString('utf8')).toBe(payload);
    expect(result.rows).toBe(2);
  });

  it('turns missing streams, checksum mismatches, and server failures into secret-safe errors', async () => {
    const missing = loadCopyText({
      archive: archive(),
      connection: new CopyConnection(),
      operation: operation(),
      stepId: 'safe-step',
      archiveEntryId: 'safe-entry',
    });
    await expect(missing).rejects.toMatchObject({
      code: 'RESTORE_COPY_FAILED',
      stepId: 'safe-step',
      archiveEntryId: 'safe-entry',
    });

    const mismatch = loadCopyText({
      archive: archive('1\tvalue\n'),
      connection: new CopyConnection(),
      operation: operation({
        checksum: { algorithm: 'sha256', value: '0'.repeat(64) },
      }),
      stepId: 'checksum-step',
      archiveEntryId: 'checksum-entry',
    });
    await expect(mismatch).rejects.toMatchObject({ code: 'RESTORE_COPY_FAILED' });

    const failing = new CopyConnection();
    failing.failCompletion = Object.assign(new Error('invalid input password=secret'), {
      code: '22P02',
      context: 'COPY select, line 1, column second: "redacted-row"',
    });
    const serverFailure = loadCopyText({
      archive: archive('bad\tvalue\n'),
      connection: failing,
      operation: operation(),
      stepId: 'server-step',
      archiveEntryId: 'server-entry',
    });
    const error = await serverFailure.catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: 'RESTORE_COPY_FAILED',
      fields: { sqlState: '22P02' },
    });
    expect(String(error)).not.toContain('redacted-row');
    expect(String(error)).not.toContain('secret');
  });

  it('propagates source and COPY writable failures and cleans up the operation', async () => {
    const failingSource = function* () {
      yield '1\tvalue\n';
      throw new Error('archive read failed');
    };
    const sourceConnection = new CopyConnection();
    await expect(
      loadCopyText({
        archive: archive(() => Readable.from(failingSource())),
        connection: sourceConnection,
        operation: operation(),
        stepId: 'source-step',
        archiveEntryId: 'source-entry',
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_COPY_FAILED' });
    expect(sourceConnection.abortCount).toBe(1);

    const writeConnection = new CopyConnection();
    writeConnection.failWrite = new Error('COPY writable failed');
    await expect(
      loadCopyText({
        archive: archive('1\tvalue\n'),
        connection: writeConnection,
        operation: operation(),
        stepId: 'write-step',
        archiveEntryId: 'write-entry',
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_COPY_FAILED' });
    expect(writeConnection.abortCount).toBe(1);
  });

  it('cancels a running pipeline and aborts COPY exactly once', async () => {
    const controller = new AbortController();
    const connection = new CopyConnection();
    connection.writeDelay = 10;
    const source = function* () {
      for (let index = 0; index < 1_000; index += 1) {
        yield `${String(index)}\tvalue\n`;
      }
    };
    const loading = loadCopyText({
      archive: archive(() => Readable.from(source())),
      connection,
      operation: operation(),
      stepId: 'cancel-step',
      archiveEntryId: 'cancel-entry',
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(loading).rejects.toMatchObject({ code: 'RESTORE_CANCELLED' });
    expect(connection.abortCount).toBe(1);
  });

  it('honors cancellation before opening the archive stream', async () => {
    const controller = new AbortController();
    controller.abort();
    const connection = new CopyConnection();
    await expect(
      loadCopyText({
        archive: archive('1\tvalue\n'),
        connection,
        operation: operation(),
        stepId: 'cancel-before-step',
        archiveEntryId: 'cancel-before-entry',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.copyCount).toBe(0);
  });
});
