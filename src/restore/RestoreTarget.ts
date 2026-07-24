import type { Writable } from 'node:stream';

import type {
  PostgresConnection,
  PostgresQuery,
  PostgresRow,
} from '../connection/PostgresConnection.js';
import type { TargetCapabilities } from '../compatibility/TargetCapabilities.js';
import { detectTargetCapabilities } from '../compatibility/TargetCapabilities.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import type { PostgresVersionDetector } from '../version/PostgresVersionDetector.js';
import { QueryPostgresVersionDetector } from '../version/PostgresVersionDetector.js';
import { RestoreTargetCompatibilityError } from './RestoreErrors.js';

export interface RestoreCopyFromRequest {
  readonly query: string;
  readonly signal?: AbortSignal;
}

export interface PostgresRestoreConnection extends PostgresConnection {
  openCopyFrom?(request: RestoreCopyFromRequest): Promise<Writable>;
  cancel?(): Promise<void>;
}

export interface RestoreDriverCapabilities {
  readonly parameterizedQueries: true;
  readonly abortSignalCancellation: true;
  readonly copyFromStdin: boolean;
  readonly explicitCancellation: boolean;
  readonly noticeReporting: boolean;
  readonly identifierQuoting: 'library';
}

export function inspectRestoreDriverCapabilities(
  connection: PostgresConnection,
): RestoreDriverCapabilities {
  const candidate = connection as PostgresRestoreConnection;
  return {
    parameterizedQueries: true,
    abortSignalCancellation: true,
    copyFromStdin: typeof candidate.openCopyFrom === 'function',
    explicitCancellation: typeof candidate.cancel === 'function',
    noticeReporting: false,
    identifierQuoting: 'library',
  };
}

export interface RestoreTargetCurrentUser {
  readonly name: string;
  readonly superuser: boolean;
  readonly createRole: boolean;
  readonly createDatabase: boolean;
}

export interface RestoreTargetSnapshot {
  readonly version: PostgresVersion;
  readonly serverCapabilities: TargetCapabilities;
  readonly driverCapabilities: RestoreDriverCapabilities;
  readonly schemas: readonly string[];
  readonly extensions: readonly string[];
  readonly roles: readonly string[];
  readonly tablespaces: readonly string[];
  readonly currentUser: RestoreTargetCurrentUser;
}

export interface RestoreTargetInspector {
  inspect(connection: PostgresConnection, signal?: AbortSignal): Promise<RestoreTargetSnapshot>;
}

interface NameRow extends PostgresRow {
  readonly name: string;
}

interface CurrentUserRow extends PostgresRow {
  readonly name: string;
  readonly superuser: boolean;
  readonly create_role: boolean;
  readonly create_database: boolean;
}

const SCHEMAS_QUERY: PostgresQuery = {
  text: `SELECT nspname AS name FROM pg_catalog.pg_namespace ORDER BY nspname`,
};
const EXTENSIONS_QUERY: PostgresQuery = {
  text: `SELECT extname AS name FROM pg_catalog.pg_extension ORDER BY extname`,
};
const ROLES_QUERY: PostgresQuery = {
  text: `SELECT rolname AS name FROM pg_catalog.pg_roles ORDER BY rolname`,
};
const TABLESPACES_QUERY: PostgresQuery = {
  text: `SELECT spcname AS name FROM pg_catalog.pg_tablespace ORDER BY spcname`,
};
const CURRENT_USER_QUERY: PostgresQuery = {
  text: `
    SELECT
      role.rolname AS name,
      role.rolsuper AS superuser,
      role.rolcreaterole AS create_role,
      role.rolcreatedb AS create_database
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = current_user
  `,
};

export class QueryRestoreTargetInspector implements RestoreTargetInspector {
  constructor(
    private readonly versions: PostgresVersionDetector = new QueryPostgresVersionDetector(),
  ) {}

  async inspect(
    connection: PostgresConnection,
    signal?: AbortSignal,
  ): Promise<RestoreTargetSnapshot> {
    signal?.throwIfAborted();
    try {
      const version = await this.versions.detect(connection, signal);
      const schemas = await connection.query<NameRow>(SCHEMAS_QUERY, signal);
      const extensions = await connection.query<NameRow>(EXTENSIONS_QUERY, signal);
      const roles = await connection.query<NameRow>(ROLES_QUERY, signal);
      const tablespaces = await connection.query<NameRow>(TABLESPACES_QUERY, signal);
      const users = await connection.query<CurrentUserRow>(CURRENT_USER_QUERY, signal);
      const currentUser = users.rows[0];
      if (currentUser === undefined) {
        throw new RestoreTargetCompatibilityError(
          'PostgreSQL target inspection could not resolve the current role.',
        );
      }
      return {
        version,
        serverCapabilities: detectTargetCapabilities(version),
        driverCapabilities: inspectRestoreDriverCapabilities(connection),
        schemas: schemas.rows.map((row) => row.name),
        extensions: extensions.rows.map((row) => row.name),
        roles: roles.rows.map((row) => row.name),
        tablespaces: tablespaces.rows.map((row) => row.name),
        currentUser: {
          name: currentUser.name,
          superuser: currentUser.superuser,
          createRole: currentUser.create_role,
          createDatabase: currentUser.create_database,
        },
      };
    } catch (cause) {
      if (cause instanceof RestoreTargetCompatibilityError) throw cause;
      throw new RestoreTargetCompatibilityError(
        'Failed to inspect the PostgreSQL restore target.',
        { cause },
      );
    }
  }
}
