import { describe, expect, it } from 'vitest';

import { DumpSessionManager } from '../../src/connection/DumpSession.js';
import type {
  PostgresConnection,
  PostgresConnectionSource,
  PostgresQuery,
  PostgresTransactionStatus,
} from '../../src/connection/PostgresConnection.js';
import { CancellationError, TransactionSetupError } from '../../src/index.js';

class SessionDouble implements PostgresConnection {
  readonly commands: string[] = [];

  constructor(private status: PostgresTransactionStatus) {}

  query<Row>(query: PostgresQuery) {
    this.commands.push(query.text);
    const command = query.text.trim().split(/\s+/u)[0]?.toUpperCase();
    if (command === 'BEGIN') this.status = 'in-transaction';
    if (command === 'COMMIT' || command === 'ROLLBACK') this.status = 'idle';
    return Promise.resolve({ rows: [] as Row[], rowCount: 0 });
  }

  getTransactionStatus() {
    return Promise.resolve(this.status);
  }
}

describe('DumpSessionManager', () => {
  it('owns begin and commit in managed mode', async () => {
    const connection = new SessionDouble('idle');
    const result = await new DumpSessionManager().run(connection, {}, (session) =>
      Promise.resolve(session.metadata.consistentSnapshot),
    );
    expect(result).toBe(true);
    expect(connection.commands).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'COMMIT',
    ]);
  });

  it('rolls back managed transactions when work fails', async () => {
    const connection = new SessionDouble('idle');
    await expect(
      new DumpSessionManager().run(connection, {}, () =>
        Promise.reject(new Error('fixture failure')),
      ),
    ).rejects.toThrow('fixture failure');
    expect(connection.commands.at(-1)).toBe('ROLLBACK');
  });

  it('does not finish caller-owned existing transactions', async () => {
    const connection = new SessionDouble('in-transaction');
    await new DumpSessionManager().run(connection, { transactionMode: 'existing' }, () =>
      Promise.resolve(),
    );
    expect(connection.commands).toEqual([]);
  });

  it('refuses a nested managed transaction', async () => {
    await expect(
      new DumpSessionManager().run(
        new SessionDouble('in-transaction'),
        { transactionMode: 'managed' },
        () => Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(TransactionSetupError);
  });

  it('rolls back on cancellation', async () => {
    const connection = new SessionDouble('idle');
    const controller = new AbortController();
    await expect(
      new DumpSessionManager().run(
        connection,
        {},
        () => {
          controller.abort();
          return Promise.resolve();
        },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(CancellationError);
    expect(connection.commands.at(-1)).toBe('ROLLBACK');
  });

  it('releases an acquired connection exactly once', async () => {
    const connection = new SessionDouble('idle');
    let releases = 0;
    const source: PostgresConnectionSource = {
      acquire: () =>
        Promise.resolve({
          connection,
          release: () => {
            releases += 1;
            return Promise.resolve();
          },
        }),
    };

    await new DumpSessionManager().run(source, {}, () => Promise.resolve());
    expect(releases).toBe(1);
  });
});
