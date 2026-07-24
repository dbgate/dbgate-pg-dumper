import type { Writable } from 'node:stream';

import type {
  PostgresConnection,
  PostgresQuery,
  PostgresRow,
} from '../connection/PostgresConnection.js';
import type { TargetCapabilities } from '../compatibility/TargetCapabilities.js';
import { detectTargetCapabilities } from '../compatibility/TargetCapabilities.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import type { PostgresObjectKind } from '../model/PostgresStructuralObjects.js';
import type { PostgresVersionDetector } from '../version/PostgresVersionDetector.js';
import { QueryPostgresVersionDetector } from '../version/PostgresVersionDetector.js';
import { RestoreTargetCompatibilityError } from './RestoreErrors.js';

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

export interface PostgresRestoreConnection extends PostgresConnection {
  openCopyFrom?(request: RestoreCopyFromRequest): Promise<PostgreSqlCopyFromOperation>;
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
  readonly clientEncoding: string;
  readonly databaseName?: string;
  readonly schemas: readonly string[];
  readonly extensions: readonly string[];
  readonly roles: readonly string[];
  /** Roles the current session may assume with SET ROLE. */
  readonly setRoleTargets?: readonly string[];
  readonly tablespaces: readonly string[];
  readonly currentUser: RestoreTargetCurrentUser;
  readonly objects?: readonly RestoreTargetObject[];
  readonly objectDependencies?: readonly RestoreTargetDependency[];
  readonly extensionSchemas?: readonly string[];
}

export interface RestoreTargetColumn {
  readonly name: string;
  readonly position: number;
  readonly formattedType: string;
  readonly notNull: boolean;
  readonly generated: boolean;
  readonly identity: '' | 'a' | 'd';
}

export interface RestoreTargetObject {
  readonly catalogOid?: number;
  readonly kind: PostgresObjectKind;
  readonly schema?: string;
  readonly name: string;
  readonly identityArguments?: string;
  readonly parentSchema?: string;
  readonly parentName?: string;
  readonly extensionName?: string;
  readonly tablespace?: string;
  readonly estimatedRows?: number;
  readonly columns?: readonly RestoreTargetColumn[];
  readonly returnType?: string;
}

export interface RestoreTargetDependency {
  readonly dependent: RestoreTargetObject;
  readonly referenced: RestoreTargetObject;
  readonly dependencyType?: 'view-reference' | 'foreign-key';
}

export interface RestoreTargetInspector {
  inspect(connection: PostgresConnection, signal?: AbortSignal): Promise<RestoreTargetSnapshot>;
}

interface NameRow extends PostgresRow {
  readonly name: string;
  readonly can_set_role?: boolean;
}

interface CurrentUserRow extends PostgresRow {
  readonly name: string;
  readonly superuser: boolean;
  readonly create_role: boolean;
  readonly create_database: boolean;
}

interface ClientEncodingRow extends PostgresRow {
  readonly client_encoding: string;
  readonly database_name: string;
}

interface TargetObjectRow extends PostgresRow {
  readonly oid: number;
  readonly kind: PostgresObjectKind;
  readonly schema_name: string | null;
  readonly object_name: string;
  readonly identity_arguments: string | null;
  readonly parent_schema: string | null;
  readonly parent_name: string | null;
  readonly extension_name: string | null;
  readonly tablespace_name: string | null;
  readonly estimated_rows: number | null;
  readonly return_type: string | null;
}

interface TargetColumnRow extends PostgresRow {
  readonly relation_oid: number;
  readonly name: string;
  readonly position: number;
  readonly formatted_type: string;
  readonly not_null: boolean;
  readonly generated: string;
  readonly identity_kind: '' | 'a' | 'd';
}

interface TargetDependencyRow extends PostgresRow {
  readonly dependent_oid: number;
  readonly dependent_kind: PostgresObjectKind;
  readonly dependent_schema: string;
  readonly dependent_name: string;
  readonly referenced_oid: number;
  readonly referenced_kind: PostgresObjectKind;
  readonly referenced_schema: string;
  readonly referenced_name: string;
  readonly dependency_type: 'view-reference' | 'foreign-key';
}

const SCHEMAS_QUERY: PostgresQuery = {
  text: `SELECT nspname AS name FROM pg_catalog.pg_namespace ORDER BY nspname`,
};
const EXTENSIONS_QUERY: PostgresQuery = {
  text: `SELECT extname AS name FROM pg_catalog.pg_extension ORDER BY extname`,
};
const ROLES_QUERY: PostgresQuery = {
  text: `
    SELECT
      rolname AS name,
      CASE
        WHEN pg_catalog.current_setting('server_version_num')::integer >= 160000
          THEN pg_catalog.pg_has_role(current_user, oid, 'SET')
        ELSE pg_catalog.pg_has_role(current_user, oid, 'MEMBER')
      END AS can_set_role
    FROM pg_catalog.pg_roles
    ORDER BY rolname
  `,
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
const CLIENT_ENCODING_QUERY: PostgresQuery = {
  text: `SELECT pg_catalog.current_setting('client_encoding') AS client_encoding,
    current_database()::text AS database_name`,
};

function targetColumnsQuery(version: PostgresVersion): PostgresQuery {
  return {
    text: `
    SELECT
      attribute.attrelid::integer AS relation_oid,
      attribute.attname AS name,
      attribute.attnum::integer AS position,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type,
      attribute.attnotnull AS not_null,
      ${version.major >= 12 ? 'attribute.attgenerated::text' : `''::text`} AS generated,
      ${version.major >= 10 ? 'attribute.attidentity::text' : `''::text`} AS identity_kind
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS class ON class.oid = attribute.attrelid
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND class.relkind IN ('r', 'p', 'f', 'v', 'm')
    ORDER BY attribute.attrelid, attribute.attnum
    `,
  };
}

const TARGET_RELATION_DEPENDENCIES_QUERY: PostgresQuery = {
  text: `
    SELECT DISTINCT
      dependent.oid::integer AS dependent_oid,
      CASE dependent.relkind
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized-view'
        WHEN 'S' THEN 'sequence'
        WHEN 'i' THEN 'index'
        ELSE 'table'
      END AS dependent_kind,
      dependent_namespace.nspname AS dependent_schema,
      dependent.relname AS dependent_name,
      referenced.oid::integer AS referenced_oid,
      CASE referenced.relkind
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized-view'
        WHEN 'S' THEN 'sequence'
        WHEN 'i' THEN 'index'
        ELSE 'table'
      END AS referenced_kind,
      referenced_namespace.nspname AS referenced_schema,
      referenced.relname AS referenced_name,
      'view-reference'::text AS dependency_type
    FROM pg_catalog.pg_depend AS dependency
    JOIN pg_catalog.pg_rewrite AS rewrite
      ON dependency.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
      AND rewrite.oid = dependency.objid
    JOIN pg_catalog.pg_class AS dependent ON dependent.oid = rewrite.ev_class
    JOIN pg_catalog.pg_namespace AS dependent_namespace
      ON dependent_namespace.oid = dependent.relnamespace
    JOIN pg_catalog.pg_class AS referenced
      ON dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND referenced.oid = dependency.refobjid
    JOIN pg_catalog.pg_namespace AS referenced_namespace
      ON referenced_namespace.oid = referenced.relnamespace
    WHERE dependent.oid <> referenced.oid
    UNION
    SELECT
      dependent.oid::integer,
      'table',
      dependent_namespace.nspname,
      dependent.relname,
      referenced.oid::integer,
      'table',
      referenced_namespace.nspname,
      referenced.relname,
      'foreign-key'::text
    FROM pg_catalog.pg_constraint AS foreign_key
    JOIN pg_catalog.pg_class AS dependent ON dependent.oid = foreign_key.conrelid
    JOIN pg_catalog.pg_namespace AS dependent_namespace
      ON dependent_namespace.oid = dependent.relnamespace
    JOIN pg_catalog.pg_class AS referenced ON referenced.oid = foreign_key.confrelid
    JOIN pg_catalog.pg_namespace AS referenced_namespace
      ON referenced_namespace.oid = referenced.relnamespace
    WHERE foreign_key.contype = 'f' AND dependent.oid <> referenced.oid
  `,
};

function targetObjectsQuery(version: PostgresVersion): PostgresQuery {
  const routineKind =
    version.major >= 11
      ? `CASE procedure.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END`
      : `CASE WHEN procedure.proisagg THEN 'aggregate' ELSE 'function' END`;
  const optionalObjects = [
    ...(version.major >= 10
      ? [
          `
          SELECT publication.oid::integer, 'publication', NULL, publication.pubname,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL
          FROM pg_catalog.pg_publication AS publication
        `,
          `
          SELECT statistics.oid::integer, 'statistics', namespace.nspname, statistics.stxname,
            NULL, NULL, NULL, extension.extname, NULL, NULL, NULL
          FROM pg_catalog.pg_statistic_ext AS statistics
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = statistics.stxnamespace
          LEFT JOIN pg_catalog.pg_depend AS membership
            ON membership.classid = 'pg_catalog.pg_statistic_ext'::pg_catalog.regclass
            AND membership.objid = statistics.oid AND membership.deptype = 'e'
          LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = membership.refobjid
        `,
        ]
      : []),
  ];
  return {
    text: `
      SELECT
        object.oid,
        object.kind::text AS kind,
        object.schema_name,
        object.object_name,
        object.identity_arguments,
        object.parent_schema,
        object.parent_name,
        object.extension_name,
        object.tablespace_name,
        object.estimated_rows,
        object.return_type
      FROM (
        SELECT namespace.oid::integer AS oid, 'schema' AS kind, NULL::name AS schema_name,
          namespace.nspname AS object_name, NULL::text AS identity_arguments,
          NULL::name AS parent_schema, NULL::name AS parent_name,
          extension.extname AS extension_name, NULL::name AS tablespace_name,
          NULL::real AS estimated_rows, NULL::text AS return_type
        FROM pg_catalog.pg_namespace AS namespace
        LEFT JOIN pg_catalog.pg_depend AS membership
          ON membership.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
          AND membership.objid = namespace.oid AND membership.deptype = 'e'
        LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = membership.refobjid
        UNION ALL
        SELECT class.oid::integer,
          CASE class.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized-view'
            WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index' ELSE 'table' END,
          namespace.nspname, class.relname, NULL::text,
          parent_namespace.nspname, parent.relname,
          extension.extname, tablespace.spcname, class.reltuples, NULL::text
        FROM pg_catalog.pg_class AS class
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
        LEFT JOIN pg_catalog.pg_index AS index_metadata
          ON index_metadata.indexrelid = class.oid
        LEFT JOIN pg_catalog.pg_class AS parent ON parent.oid = index_metadata.indrelid
        LEFT JOIN pg_catalog.pg_namespace AS parent_namespace
          ON parent_namespace.oid = parent.relnamespace
        LEFT JOIN pg_catalog.pg_tablespace AS tablespace ON tablespace.oid = class.reltablespace
        LEFT JOIN pg_catalog.pg_depend AS membership
          ON membership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND membership.objid = class.oid AND membership.deptype = 'e'
        LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = membership.refobjid
        WHERE class.relkind IN ('r', 'p', 'f', 'v', 'm', 'S', 'i')
        UNION ALL
        SELECT constraint_object.oid::integer, 'constraint', namespace.nspname,
          constraint_object.conname, NULL::text, namespace.nspname, parent.relname,
          extension.extname, tablespace.spcname, NULL::real, NULL::text
        FROM pg_catalog.pg_constraint AS constraint_object
        JOIN pg_catalog.pg_class AS parent ON parent.oid = constraint_object.conrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = parent.relnamespace
        LEFT JOIN pg_catalog.pg_class AS backing_index
          ON backing_index.oid = constraint_object.conindid
        LEFT JOIN pg_catalog.pg_tablespace AS tablespace
          ON tablespace.oid = backing_index.reltablespace
        LEFT JOIN pg_catalog.pg_depend AS membership
          ON membership.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
          AND membership.objid = constraint_object.oid AND membership.deptype = 'e'
        LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = membership.refobjid
        WHERE constraint_object.conrelid <> 0
        UNION ALL
        SELECT trigger.oid::integer, 'trigger', namespace.nspname, trigger.tgname,
          NULL::text, namespace.nspname, parent.relname, extension.extname,
          NULL::name, NULL::real, NULL::text
        FROM pg_catalog.pg_trigger AS trigger
        JOIN pg_catalog.pg_class AS parent ON parent.oid = trigger.tgrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = parent.relnamespace
        LEFT JOIN pg_catalog.pg_depend AS membership
          ON membership.classid = 'pg_catalog.pg_trigger'::pg_catalog.regclass
          AND membership.objid = trigger.oid AND membership.deptype = 'e'
        LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = membership.refobjid
        WHERE NOT trigger.tgisinternal
        UNION ALL
        SELECT policy.oid::integer, 'policy', namespace.nspname, policy.polname,
          NULL::text, namespace.nspname, parent.relname, extension.extname,
          NULL::name, NULL::real, NULL::text
        FROM pg_catalog.pg_policy AS policy
        JOIN pg_catalog.pg_class AS parent ON parent.oid = policy.polrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = parent.relnamespace
        LEFT JOIN pg_catalog.pg_depend AS membership
          ON membership.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass
          AND membership.objid = policy.oid AND membership.deptype = 'e'
        LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = membership.refobjid
        UNION ALL
        SELECT type.oid::integer,
          CASE type.typtype WHEN 'd' THEN 'domain' ELSE 'type' END,
          namespace.nspname, type.typname, NULL::text, NULL::name, NULL::name,
          extension.extname, NULL::name, NULL::real, NULL::text
        FROM pg_catalog.pg_type AS type
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type.typnamespace
        LEFT JOIN pg_catalog.pg_depend AS membership
          ON membership.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
          AND membership.objid = type.oid AND membership.deptype = 'e'
        LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = membership.refobjid
        WHERE type.typtype IN ('c', 'd', 'e', 'r') AND type.typelem = 0 AND type.typrelid = 0
        UNION ALL
        SELECT procedure.oid::integer, ${routineKind}, namespace.nspname, procedure.proname,
          pg_catalog.pg_get_function_identity_arguments(procedure.oid),
          NULL::name, NULL::name, extension.extname, NULL::name, NULL::real,
          pg_catalog.format_type(procedure.prorettype, NULL)
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        LEFT JOIN pg_catalog.pg_depend AS membership
          ON membership.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND membership.objid = procedure.oid AND membership.deptype = 'e'
        LEFT JOIN pg_catalog.pg_extension AS extension ON extension.oid = membership.refobjid
        UNION ALL
        SELECT extension.oid::integer, 'extension', NULL::name, extension.extname,
          NULL::text, NULL::name, NULL::name, extension.extname, NULL::name, NULL::real,
          NULL::text
        FROM pg_catalog.pg_extension AS extension
        ${optionalObjects.map((query) => `UNION ALL ${query}`).join('\n')}
      ) AS object
      ORDER BY object.kind, object.schema_name NULLS FIRST, object.object_name,
        object.identity_arguments NULLS FIRST
    `,
  };
}

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
      const encodings = await connection.query<ClientEncodingRow>(CLIENT_ENCODING_QUERY, signal);
      const objectRows = await connection.query<TargetObjectRow>(
        targetObjectsQuery(version),
        signal,
      );
      const columnRows = await connection.query<TargetColumnRow>(
        targetColumnsQuery(version),
        signal,
      );
      const dependencyRows = await connection.query<TargetDependencyRow>(
        TARGET_RELATION_DEPENDENCIES_QUERY,
        signal,
      );
      const currentUser = users.rows[0];
      const encoding = encodings.rows[0]?.client_encoding;
      const databaseName = encodings.rows[0]?.database_name;
      if (currentUser === undefined || encoding === undefined) {
        throw new RestoreTargetCompatibilityError(
          'PostgreSQL target inspection could not resolve the current role.',
        );
      }
      const columnsByRelation = new Map<number, RestoreTargetColumn[]>();
      for (const row of columnRows.rows) {
        const columns = columnsByRelation.get(row.relation_oid) ?? [];
        columns.push({
          name: row.name,
          position: row.position,
          formattedType: row.formatted_type,
          notNull: row.not_null,
          generated: row.generated !== '',
          identity: row.identity_kind,
        });
        columnsByRelation.set(row.relation_oid, columns);
      }
      const objects = objectRows.rows.map((row): RestoreTargetObject => ({
        catalogOid: row.oid,
        kind: row.kind,
        ...(row.schema_name === null ? {} : { schema: row.schema_name }),
        name: row.object_name,
        ...(row.identity_arguments === null ? {} : { identityArguments: row.identity_arguments }),
        ...(row.parent_schema === null ? {} : { parentSchema: row.parent_schema }),
        ...(row.parent_name === null ? {} : { parentName: row.parent_name }),
        ...(row.extension_name === null ? {} : { extensionName: row.extension_name }),
        ...(row.tablespace_name === null ? {} : { tablespace: row.tablespace_name }),
        ...(row.estimated_rows === null ? {} : { estimatedRows: row.estimated_rows }),
        ...(row.return_type === null ? {} : { returnType: row.return_type }),
        ...(columnsByRelation.has(row.oid) ? { columns: columnsByRelation.get(row.oid)! } : {}),
      }));
      const byOid = new Map(
        objects.flatMap((object) =>
          object.catalogOid === undefined ? [] : [[object.catalogOid, object] as const],
        ),
      );
      return {
        version,
        serverCapabilities: detectTargetCapabilities(version),
        driverCapabilities: inspectRestoreDriverCapabilities(connection),
        clientEncoding: encoding,
        ...(databaseName === undefined ? {} : { databaseName }),
        schemas: schemas.rows.map((row) => row.name),
        extensions: extensions.rows.map((row) => row.name),
        roles: roles.rows.map((row) => row.name),
        setRoleTargets: roles.rows
          .filter((row) => row.can_set_role === true || row.name === currentUser.name)
          .map((row) => row.name),
        tablespaces: tablespaces.rows.map((row) => row.name),
        currentUser: {
          name: currentUser.name,
          superuser: currentUser.superuser,
          createRole: currentUser.create_role,
          createDatabase: currentUser.create_database,
        },
        objects,
        objectDependencies: dependencyRows.rows.flatMap((row) => {
          const dependent = byOid.get(row.dependent_oid);
          const referenced = byOid.get(row.referenced_oid);
          return dependent === undefined || referenced === undefined
            ? []
            : [{ dependent, referenced, dependencyType: row.dependency_type }];
        }),
        extensionSchemas: objects
          .filter((object) => object.kind === 'schema' && object.extensionName !== undefined)
          .map((object) => object.name),
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
