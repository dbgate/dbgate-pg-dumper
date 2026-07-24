/**
 * Consistent PostgreSQL dump-session management.
 *
 * Managed mode establishes one repeatable-read, read-only transaction and owns
 * its commit or rollback. Existing mode validates that the caller already has a
 * transaction and never finishes it. None mode performs no transaction work.
 * This boundary is ready for future snapshot identifiers and coordinated
 * parallel workers without implementing parallel dumping today.
 */

import type {
  AcquiredPostgresConnection,
  PostgresConnection,
  PostgresConnectionInput,
} from './PostgresConnection.js';
import { acquirePostgresConnection } from './PostgresConnection.js';
import {
  CancellationError,
  ConnectionError,
  TransactionSetupError,
  toCancellationError,
} from '../utils/errors.js';

/** Determines ownership of transaction boundaries during a dump. */
export type DumpTransactionMode = 'managed' | 'existing' | 'none';

/** Metadata describing consistency guarantees for one acquired dump session. */
export interface DumpSessionMetadata {
  readonly transactionMode: DumpTransactionMode;
  readonly consistentSnapshot: boolean;
  readonly synchronizedSnapshotId?: string;
}

/** Active session passed to all introspection phases. */
export interface DumpSession {
  readonly connection: PostgresConnection;
  readonly metadata: DumpSessionMetadata;
}

/** Options reserved for transaction and future snapshot behavior. */
export interface DumpSessionOptions {
  readonly transactionMode?: DumpTransactionMode;
  readonly synchronizedSnapshotId?: string;
}

/** Runs work with deterministic transaction and connection cleanup semantics. */
export class DumpSessionManager {
  async run<T>(
    input: PostgresConnectionInput,
    options: DumpSessionOptions,
    work: (session: DumpSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let acquired: AcquiredPostgresConnection;

    try {
      acquired = await acquirePostgresConnection(input, signal);
    } catch (cause) {
      if (signal?.aborted) {
        throw toCancellationError(cause);
      }
      throw new ConnectionError('Failed to acquire a PostgreSQL connection.', { cause });
    }

    const mode = options.transactionMode ?? 'managed';
    let managedTransactionStarted = false;
    let result: T | undefined;
    let failure: Error | undefined;

    try {
      await this.prepare(acquired.connection, mode, options.synchronizedSnapshotId, signal);
      managedTransactionStarted = mode === 'managed';

      result = await work({
        connection: acquired.connection,
        metadata: {
          transactionMode: mode,
          consistentSnapshot: mode !== 'none',
          ...(options.synchronizedSnapshotId === undefined
            ? {}
            : { synchronizedSnapshotId: options.synchronizedSnapshotId }),
        },
      });

      signal?.throwIfAborted();
      if (managedTransactionStarted) {
        await acquired.connection.query({ text: 'COMMIT' }, signal);
        managedTransactionStarted = false;
      }
    } catch (cause) {
      if (managedTransactionStarted) {
        await this.rollback(acquired.connection);
      }
      if (signal?.aborted || cause instanceof CancellationError) {
        failure = toCancellationError(cause);
      } else {
        failure =
          cause instanceof Error ? cause : new Error('PostgreSQL dump session failed.', { cause });
      }
    }

    try {
      await acquired.release();
    } catch (cause) {
      if (failure === undefined && !signal?.aborted) {
        failure = new ConnectionError('Failed to release the PostgreSQL connection.', { cause });
      }
    }

    if (failure !== undefined) {
      throw failure;
    }
    return result as T;
  }

  private async prepare(
    connection: PostgresConnection,
    mode: DumpTransactionMode,
    synchronizedSnapshotId: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    let status;
    try {
      status = await connection.getTransactionStatus(signal);
    } catch (cause) {
      throw new TransactionSetupError('Failed to determine PostgreSQL transaction state.', {
        cause,
      });
    }

    if (synchronizedSnapshotId !== undefined) {
      throw new TransactionSetupError(
        'Synchronized snapshots are reserved for a future parallel-dump implementation.',
      );
    }

    if (mode === 'managed') {
      if (status !== 'idle') {
        throw new TransactionSetupError(
          `Managed transaction mode requires an idle connection; adapter reported "${status}".`,
        );
      }

      try {
        await connection.query({ text: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' }, signal);
      } catch (cause) {
        await this.rollback(connection);
        throw new TransactionSetupError('Failed to establish the consistent dump transaction.', {
          cause,
        });
      }
      return;
    }

    if (mode === 'existing' && status !== 'in-transaction') {
      throw new TransactionSetupError(
        `Existing transaction mode requires an active transaction; adapter reported "${status}".`,
      );
    }
  }

  private async rollback(connection: PostgresConnection): Promise<void> {
    try {
      await connection.query({ text: 'ROLLBACK' });
    } catch {
      // Preserve the original failure; a broken connection may reject rollback.
    }
  }
}
