/**
 * Optional adapter for the `pg` package.
 *
 * Client and PoolClient adapters borrow caller-owned clients. Pool adapters
 * acquire exactly one PoolClient and release it after the dump. Streaming uses
 * `pg-query-stream` only when requested, keeping ordinary introspection free of
 * cursor dependencies.
 */

import {
  Query,
  type Client,
  type Pool,
  type PoolClient,
  type QueryConfig,
  type QueryResultRow,
} from 'pg';

import type {
  AcquiredPostgresConnection,
  PostgresConnection,
  PostgresConnectionSource,
  PostgresQuery,
  PostgresQueryResult,
  PostgresRow,
  PostgresStreamOptions,
  PostgresTransactionStatus,
} from './PostgresConnection.js';
import { CancellationError, ConnectionError } from '../utils/errors.js';

type PgClientLike = Client | PoolClient;
interface PgCancelableClient {
  cancel(client: PgClientLike, query: Query): void;
}

/** Required because node-postgres does not expose transaction state publicly. */
export interface PgConnectionAdapterOptions {
  /**
   * State at adapter creation. Use `in-transaction` when wrapping a client whose
   * transaction was started outside this adapter.
   */
  readonly initialTransactionStatus?: PostgresTransactionStatus;
}

/** Adapts a connected pg.Client or pg.PoolClient as one physical session. */
export class PgConnectionAdapter implements PostgresConnection {
  #transactionStatus: PostgresTransactionStatus;

  constructor(
    private readonly client: PgClientLike,
    options: PgConnectionAdapterOptions = {},
  ) {
    this.#transactionStatus = options.initialTransactionStatus ?? 'idle';
  }

  async query<Row extends PostgresRow = PostgresRow>(
    query: PostgresQuery,
    signal?: AbortSignal,
  ): Promise<PostgresQueryResult<Row>> {
    signal?.throwIfAborted();

    try {
      const result = await this.executeQuery<Row>(query, signal);
      this.updateTransactionStatus(query.text);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    } catch (cause) {
      if (signal?.aborted) {
        throw new CancellationError('PostgreSQL query was cancelled.', { cause });
      }
      if (this.#transactionStatus === 'in-transaction') {
        this.#transactionStatus = 'failed';
      }
      throw new ConnectionError('PostgreSQL query failed.', { cause });
    }
  }

  async *stream<Row extends PostgresRow = PostgresRow>(
    query: PostgresQuery,
    options: PostgresStreamOptions = {},
  ): AsyncIterable<Row> {
    options.signal?.throwIfAborted();
    const { default: QueryStream } = await import('pg-query-stream');
    const stream = this.client.query(
      new QueryStream(query.text, query.values === undefined ? [] : [...query.values], {
        ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      }),
    );

    const abort = (): void => {
      stream.destroy(new CancellationError('PostgreSQL stream was cancelled.'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    try {
      for await (const row of stream) {
        options.signal?.throwIfAborted();
        yield row as Row;
      }
    } catch (cause) {
      if (options.signal?.aborted) {
        throw new CancellationError('PostgreSQL stream was cancelled.', { cause });
      }
      throw new ConnectionError('PostgreSQL streaming query failed.', { cause });
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  getTransactionStatus(signal?: AbortSignal): Promise<PostgresTransactionStatus> {
    signal?.throwIfAborted();
    return Promise.resolve(this.#transactionStatus);
  }

  private toQueryConfig(query: PostgresQuery): QueryConfig {
    return {
      text: query.text,
      ...(query.values === undefined ? {} : { values: [...query.values] }),
      ...(query.name === undefined ? {} : { name: query.name }),
    } as QueryConfig;
  }

  private executeQuery<Row extends PostgresRow>(
    query: PostgresQuery,
    signal?: AbortSignal,
  ): Promise<{
    readonly rows: readonly (Row & QueryResultRow)[];
    readonly rowCount: number | null;
  }> {
    return new Promise((resolve, reject) => {
      const nativeQuery = new Query<Row & QueryResultRow>(
        this.toQueryConfig(query),
        (error, result) => {
          signal?.removeEventListener('abort', abort);
          // node-postgres uses `null` at runtime although its declaration says
          // successful callbacks receive `undefined`.
          if (error === undefined || (error as Error | null) === null) {
            resolve(result);
          } else {
            reject(error);
          }
        },
      );
      const abort = (): void => {
        (this.client as unknown as PgCancelableClient).cancel(this.client, nativeQuery);
        reject(new CancellationError('PostgreSQL query was cancelled.'));
      };

      signal?.addEventListener('abort', abort, { once: true });
      this.client.query(nativeQuery);
    });
  }

  private updateTransactionStatus(sql: string): void {
    const command = sql.trimStart().split(/\s+/u)[0]?.toUpperCase();
    if (command === 'BEGIN' || command === 'START') {
      this.#transactionStatus = 'in-transaction';
    } else if (command === 'COMMIT' || command === 'ROLLBACK') {
      this.#transactionStatus = 'idle';
    }
  }
}

/** Pool-backed source retaining one acquired PoolClient for the whole callback. */
export class PgPoolConnectionSource implements PostgresConnectionSource {
  constructor(
    private readonly pool: Pool,
    private readonly options: PgConnectionAdapterOptions = {},
  ) {}

  async acquire(signal?: AbortSignal): Promise<AcquiredPostgresConnection> {
    signal?.throwIfAborted();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (cause) {
      throw new ConnectionError('Failed to acquire a PostgreSQL pool client.', { cause });
    }

    let released = false;
    return {
      connection: new PgConnectionAdapter(client, this.options),
      release: () => {
        if (!released) {
          released = true;
          client.release();
        }
        return Promise.resolve();
      },
    };
  }
}

/** Convenience factory for a connected pg.Client. */
export function fromPgClient(
  client: Client,
  options?: PgConnectionAdapterOptions,
): PostgresConnection {
  return new PgConnectionAdapter(client, options);
}

/** Convenience factory for an already acquired pg.PoolClient. */
export function fromPgPoolClient(
  client: PoolClient,
  options?: PgConnectionAdapterOptions,
): PostgresConnection {
  return new PgConnectionAdapter(client, options);
}

/** Convenience factory that acquires and releases one client from a pg.Pool. */
export function fromPgPool(
  pool: Pool,
  options?: PgConnectionAdapterOptions,
): PostgresConnectionSource {
  return new PgPoolConnectionSource(pool, options);
}
