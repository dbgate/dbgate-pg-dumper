/**
 * Source PostgreSQL version detection through the connection port.
 *
 * Detection reads server settings from the same physical connection later used
 * for introspection, preventing pool routing from mixing server identities.
 */

import type { PostgresConnection, PostgresRow } from '../connection/PostgresConnection.js';
import { IntrospectionQueryError, UnsupportedPostgresVersionError } from '../utils/errors.js';
import type { PostgresVersion } from './PostgresVersion.js';
import { PostgresVersionService } from './PostgresVersion.js';

interface VersionRow extends PostgresRow {
  readonly server_version: string;
  readonly server_version_num: string;
}

/** Connection-facing version detection boundary. */
export interface PostgresVersionDetector {
  detect(connection: PostgresConnection, signal?: AbortSignal): Promise<PostgresVersion>;
}

/** Reads both complete and machine-readable server versions. */
export class QueryPostgresVersionDetector implements PostgresVersionDetector {
  constructor(private readonly versions = new PostgresVersionService()) {}

  async detect(connection: PostgresConnection, signal?: AbortSignal): Promise<PostgresVersion> {
    try {
      const result = await connection.query<VersionRow>(
        {
          text: `
            SELECT
              current_setting('server_version') AS server_version,
              current_setting('server_version_num') AS server_version_num
          `,
        },
        signal,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new IntrospectionQueryError('PostgreSQL version query returned no rows.');
      }
      return this.versions.parse(row.server_version_num, row.server_version);
    } catch (cause) {
      if (
        cause instanceof IntrospectionQueryError ||
        cause instanceof UnsupportedPostgresVersionError
      ) {
        throw cause;
      }
      throw new IntrospectionQueryError('Failed to detect the PostgreSQL source version.', {
        cause,
      });
    }
  }
}
