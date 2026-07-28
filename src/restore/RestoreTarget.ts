import type { Writable } from 'node:stream';

import type { PostgresConnection } from '../connection/PostgresConnection.js';

export interface RestoreCopyFromRequest {
  readonly query: string;
  readonly signal?: AbortSignal;
}

export interface PostgreSqlCopyResult {
  readonly rowCount?: number;
}

export interface PostgreSqlCopyFromOperation {
  readonly writable: Writable;
  readonly completion: Promise<PostgreSqlCopyResult>;
  abort(reason?: Error): Promise<void>;
}

/** Connection capabilities required by sequential plain-SQL restore. */
export interface PostgresRestoreConnection extends PostgresConnection {
  openCopyFrom?(request: RestoreCopyFromRequest): Promise<PostgreSqlCopyFromOperation>;
  cancel?(): Promise<void>;
}
