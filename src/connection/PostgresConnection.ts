/**
 * Driver-independent PostgreSQL connection contracts.
 *
 * A `PostgresConnection` represents exactly one physical backend session. The
 * dumper never accepts a generic pool query facade because catalog reads and a
 * repeatable-read snapshot must stay on the same backend for their full
 * lifetime. A `PostgresConnectionSource` acquires that session and returns a
 * cleanup callback describing resource ownership.
 */

/** The widest safe row shape accepted from a PostgreSQL client adapter. */
export type PostgresRow = Readonly<Record<string, unknown>>;

/** A parameterized SQL request sent through the caller-provided adapter. */
export interface PostgresQuery {
  readonly text: string;
  readonly values?: readonly unknown[];
  readonly name?: string;
}

/** Materialized result used for catalog and other bounded metadata queries. */
export interface PostgresQueryResult<Row extends PostgresRow = PostgresRow> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

/** Controls bounded buffering when an adapter supports streamed query results. */
export interface PostgresStreamOptions {
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
}

/**
 * Transaction state known by an adapter.
 *
 * `unknown` is deliberately distinct from `idle`: managed mode refuses to
 * begin when an adapter cannot establish that nesting is safe.
 */
export type PostgresTransactionStatus = 'idle' | 'in-transaction' | 'failed' | 'unknown';

/** One physical PostgreSQL backend session used for an entire dump. */
export interface PostgresConnection {
  query<Row extends PostgresRow = PostgresRow>(
    query: PostgresQuery,
    signal?: AbortSignal,
  ): Promise<PostgresQueryResult<Row>>;

  /** Optional because not every Node.js driver exposes cursor-style streaming. */
  stream?<Row extends PostgresRow = PostgresRow>(
    query: PostgresQuery,
    options?: PostgresStreamOptions,
  ): AsyncIterable<Row>;

  /**
   * Reports transaction state without changing it.
   *
   * Implementations should return `unknown` rather than guessing. Managed
   * transaction mode requires `idle`; existing mode requires `in-transaction`.
   */
  getTransactionStatus(signal?: AbortSignal): Promise<PostgresTransactionStatus>;
}

/** Acquired connection plus an idempotent ownership-aware cleanup callback. */
export interface AcquiredPostgresConnection {
  readonly connection: PostgresConnection;
  release(): Promise<void>;
}

/** Factory that guarantees acquisition of one physical PostgreSQL session. */
export interface PostgresConnectionSource {
  acquire(signal?: AbortSignal): Promise<AcquiredPostgresConnection>;
}

/** Inputs accepted wherever the library needs to acquire a dump session. */
export type PostgresConnectionInput = PostgresConnection | PostgresConnectionSource;

/** Type guard used without coupling callers to concrete adapter classes. */
export function isPostgresConnectionSource(
  input: PostgresConnectionInput,
): input is PostgresConnectionSource {
  return 'acquire' in input && typeof input.acquire === 'function';
}

/**
 * Acquires or borrows one physical connection.
 *
 * Direct connections remain caller-owned and therefore receive a no-op release.
 * Sources such as pool adapters return their real release operation.
 */
export async function acquirePostgresConnection(
  input: PostgresConnectionInput,
  signal?: AbortSignal,
): Promise<AcquiredPostgresConnection> {
  signal?.throwIfAborted();

  if (isPostgresConnectionSource(input)) {
    return input.acquire(signal);
  }

  return {
    connection: input,
    release: () => Promise.resolve(),
  };
}
