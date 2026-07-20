/**
 * Public introspection orchestration use case.
 *
 * One physical connection is acquired first, source identity is detected on
 * it, then the consistent session manager starts the requested transaction and
 * all catalog phases run on that same connection. Pool-backed inputs are
 * released exactly once after transaction completion.
 */

import {
  acquirePostgresConnection,
  type PostgresConnection,
  type PostgresConnectionInput,
} from '../connection/PostgresConnection.js';
import {
  DumpSessionManager,
  type DumpSessionMetadata,
  type DumpTransactionMode,
} from '../connection/DumpSession.js';
import type { PostgresDatabase } from '../model/PostgresDatabase.js';
import {
  normalizeDumpSelection,
  type DumpSelection,
  type NormalizedDumpSelection,
} from '../selection/Selection.js';
import { ConnectionError, toCancellationError } from '../utils/errors.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import {
  detectSourceCapabilities,
  type SourceCapabilities,
} from '../version/SourceCapabilities.js';
import { QueryPostgresVersionDetector } from '../version/PostgresVersionDetector.js';
import { PostgresCatalogIntrospector } from './DatabaseIntrospector.js';
import type { IntrospectionDiagnostic } from './diagnostics.js';

export interface IntrospectPostgresOptions {
  readonly transactionMode?: DumpTransactionMode;
  readonly selection?: DumpSelection;
  readonly synchronizedSnapshotId?: string;
}

export interface SourceServerMetadata {
  readonly version: PostgresVersion;
  readonly capabilities: SourceCapabilities;
}

export interface PostgresIntrospectionMetadata {
  readonly source: SourceServerMetadata;
  readonly session: DumpSessionMetadata;
  readonly selection: NormalizedDumpSelection;
}

export interface PostgresIntrospectionResult {
  readonly database: PostgresDatabase;
  readonly metadata: PostgresIntrospectionMetadata;
  readonly diagnostics: readonly IntrospectionDiagnostic[];
}

export type PostgresIntrospectionSessionWork<Result> = (
  result: PostgresIntrospectionResult,
  connection: PostgresConnection,
) => Promise<Result>;

export async function introspectPostgres(
  input: PostgresConnectionInput,
  options: IntrospectPostgresOptions = {},
  signal?: AbortSignal,
): Promise<PostgresIntrospectionResult> {
  return withPostgresIntrospectionSession(
    input,
    options,
    (result) => Promise.resolve(result),
    signal,
  );
}

/**
 * Runs work after introspection but before the consistent snapshot commits.
 * This is the application-layer bridge used by full schema-plus-data dumps.
 */
export async function withPostgresIntrospectionSession<Result>(
  input: PostgresConnectionInput,
  options: IntrospectPostgresOptions,
  work: PostgresIntrospectionSessionWork<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  let acquired;
  let result: Result | undefined;
  let failure: Error | undefined;
  try {
    acquired = await acquirePostgresConnection(input, signal);
  } catch (cause) {
    if (signal?.aborted) throw toCancellationError(cause);
    throw new ConnectionError('Failed to acquire a PostgreSQL connection.', { cause });
  }

  try {
    const version = await new QueryPostgresVersionDetector().detect(acquired.connection, signal);
    const capabilities = detectSourceCapabilities(version);
    const selection = normalizeDumpSelection(options.selection);
    const sessionManager = new DumpSessionManager();

    result = await sessionManager.run(
      acquired.connection,
      {
        ...(options.transactionMode === undefined
          ? {}
          : { transactionMode: options.transactionMode }),
        ...(options.synchronizedSnapshotId === undefined
          ? {}
          : { synchronizedSnapshotId: options.synchronizedSnapshotId }),
      },
      async (session) => {
        const introspection = await new PostgresCatalogIntrospector().introspect(
          session.connection,
          capabilities,
          selection,
          signal,
        );
        const introspectionResult: PostgresIntrospectionResult = {
          database: introspection.database,
          diagnostics: introspection.diagnostics,
          metadata: {
            source: { version, capabilities },
            session: session.metadata,
            selection,
          },
        };
        return work(introspectionResult, session.connection);
      },
      signal,
    );
  } catch (cause) {
    failure = signal?.aborted
      ? toCancellationError(cause)
      : cause instanceof Error
        ? cause
        : new ConnectionError('PostgreSQL introspection failed.', { cause });
  }

  try {
    await acquired.release();
  } catch (cause) {
    if (failure === undefined) {
      failure = new ConnectionError('Failed to release the PostgreSQL connection.', { cause });
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
  return result as Result;
}
