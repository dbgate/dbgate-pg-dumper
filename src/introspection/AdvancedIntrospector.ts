/**
 * Loads advanced and cluster-scoped catalogs without making the core schema
 * assembler aware of their version and privilege differences.
 *
 * Catalogs that are unavailable to the current role produce structured
 * diagnostics and an empty collection. Secret-bearing option values are
 * already redacted by the SQL layer before they reach this service.
 */

import type {
  PostgresConnection,
  PostgresQuery,
  PostgresRow,
} from '../connection/PostgresConnection.js';
import type {
  PostgresEventTrigger,
  PostgresExtensionMember,
  PostgresForeignTableDefinition,
  PostgresOption,
  PostgresPublication,
} from '../model/PostgresAdvancedObjects.js';
import type { PostgresDatabase } from '../model/PostgresDatabase.js';
import type { PostgresObjectReference } from '../model/PostgresStructuralObjects.js';
import { isSensitiveOptionName } from '../security/SensitiveValuePolicy.js';
import type { SourceCapabilities } from '../version/SourceCapabilities.js';
import {
  EVENT_TRIGGERS_QUERY,
  EXTENSIONS_QUERY,
  EXTENSION_MEMBERS_QUERY,
  FOREIGN_DATA_WRAPPERS_QUERY,
  FOREIGN_SERVERS_QUERY,
  FOREIGN_TABLES_QUERY,
  LANGUAGES_QUERY,
  LARGE_OBJECTS_QUERY,
  REPLICATION_ORIGINS_QUERY,
  ROLE_MEMBERSHIPS_QUERY,
  TABLESPACES_QUERY,
  USER_MAPPINGS_QUERY,
  createAdvancedRolesQuery,
  createPublicationSchemasQuery,
  createPublicationTablesQuery,
  createPublicationsQuery,
  createStatisticsQuery,
  createSubscriptionsQuery,
} from './advancedCatalogQueries.js';
import type {
  AdvancedRoleCatalogRow,
  EventTriggerCatalogRow,
  ExtensionCatalogRow,
  ExtensionMemberCatalogRow,
  ForeignDataWrapperCatalogRow,
  ForeignServerCatalogRow,
  ForeignTableCatalogRow,
  LanguageCatalogRow,
  LargeObjectCatalogRow,
  PublicationCatalogRow,
  PublicationSchemaCatalogRow,
  PublicationTableCatalogRow,
  RoleMembershipCatalogRow,
  StatisticsCatalogRow,
  SubscriptionCatalogRow,
  TablespaceCatalogRow,
  UserMappingCatalogRow,
} from './advancedCatalogTypes.js';
import type { IntrospectionDiagnostic } from './diagnostics.js';

interface AdvancedIntrospectionResult {
  readonly database: PostgresDatabase;
  readonly diagnostics: readonly IntrospectionDiagnostic[];
}

function options(values: readonly string[] | null): readonly PostgresOption[] {
  return (values ?? []).map((item) => {
    const separator = item.indexOf('=');
    const name = separator < 0 ? item : item.slice(0, separator);
    const value = separator < 0 ? undefined : item.slice(separator + 1);
    const sensitive = isSensitiveOptionName(name) || value === '[REDACTED]';
    return {
      name,
      ...(value === undefined ? {} : { value }),
      sensitive,
    };
  });
}

function enabled(value: string): PostgresEventTrigger['enabled'] {
  if (value === 'D') return 'disabled';
  if (value === 'R') return 'replica';
  if (value === 'A') return 'always';
  return 'origin';
}

function relationKind(value: string | null): PostgresObjectReference['kind'] {
  if (value === 'S') return 'sequence';
  if (value === 'v') return 'view';
  if (value === 'm') return 'materialized-view';
  if (value === 'i' || value === 'I') return 'index';
  return 'table';
}

function extensionMemberReference(
  row: ExtensionMemberCatalogRow,
): PostgresObjectReference | undefined {
  if (row.object_name === null) return undefined;
  const catalog = row.referenced_class.replace(/^pg_catalog\./u, '');
  const base = {
    oid: row.object_oid,
    ...(row.schema_name === null ? {} : { schema: row.schema_name }),
    name: row.object_name,
  };
  if (catalog === 'pg_class') {
    return { kind: relationKind(row.relation_kind), ...base };
  }
  if (catalog === 'pg_proc') {
    return {
      kind: 'function',
      ...base,
      ...(row.identity_arguments === null ? {} : { subName: row.identity_arguments }),
    };
  }
  if (catalog === 'pg_type') return { kind: 'type', ...base };
  if (catalog === 'pg_constraint') return { kind: 'constraint', ...base };
  if (catalog === 'pg_namespace') return { kind: 'schema', ...base };
  if (catalog === 'pg_language') {
    return { kind: 'procedural-language', ...base };
  }
  if (catalog === 'pg_foreign_data_wrapper') {
    return { kind: 'foreign-data-wrapper', ...base };
  }
  if (catalog === 'pg_foreign_server') {
    return { kind: 'foreign-server', ...base };
  }
  return undefined;
}

export class AdvancedCatalogIntrospector {
  async introspect(
    connection: PostgresConnection,
    database: PostgresDatabase,
    capabilities: SourceCapabilities,
    signal?: AbortSignal,
  ): Promise<AdvancedIntrospectionResult> {
    const diagnostics: IntrospectionDiagnostic[] = [];
    const query = <Row extends PostgresRow>(
      request: PostgresQuery | undefined,
      subject: string,
    ): Promise<readonly Row[]> =>
      request === undefined
        ? Promise.resolve([])
        : this.optionalQuery<Row>(connection, request, subject, diagnostics, signal);

    // One introspection operation deliberately owns one physical connection.
    // Execute optional catalogs sequentially: node-postgres does not support
    // concurrent queries on a Client, and a failed concurrent query can abort
    // the transaction before the other optional queries have completed.
    const extensionRows = await query<ExtensionCatalogRow>(EXTENSIONS_QUERY, 'extensions');
    const extensionMemberRows = await query<ExtensionMemberCatalogRow>(
      EXTENSION_MEMBERS_QUERY,
      'extension members',
    );
    const wrapperRows = await query<ForeignDataWrapperCatalogRow>(
      FOREIGN_DATA_WRAPPERS_QUERY,
      'foreign-data wrappers',
    );
    const serverRows = await query<ForeignServerCatalogRow>(
      FOREIGN_SERVERS_QUERY,
      'foreign servers',
    );
    const mappingRows = await query<UserMappingCatalogRow>(USER_MAPPINGS_QUERY, 'user mappings');
    const foreignTableRows = await query<ForeignTableCatalogRow>(
      FOREIGN_TABLES_QUERY,
      'foreign tables',
    );
    const eventTriggerRows = await query<EventTriggerCatalogRow>(
      EVENT_TRIGGERS_QUERY,
      'event triggers',
    );
    const languageRows = await query<LanguageCatalogRow>(LANGUAGES_QUERY, 'procedural languages');
    const publicationRows = await query<PublicationCatalogRow>(
      createPublicationsQuery(capabilities),
      'publications',
    );
    const publicationTableRows = await query<PublicationTableCatalogRow>(
      createPublicationTablesQuery(capabilities),
      'publication tables',
    );
    const publicationSchemaRows = await query<PublicationSchemaCatalogRow>(
      createPublicationSchemasQuery(capabilities),
      'publication schemas',
    );
    const subscriptionRows = await query<SubscriptionCatalogRow>(
      createSubscriptionsQuery(capabilities),
      'subscriptions',
    );
    const tablespaceRows = await query<TablespaceCatalogRow>(TABLESPACES_QUERY, 'tablespaces');
    const roleRows = await query<AdvancedRoleCatalogRow>(
      createAdvancedRolesQuery(capabilities),
      'roles',
    );
    const membershipRows = await query<RoleMembershipCatalogRow>(
      ROLE_MEMBERSHIPS_QUERY,
      'role memberships',
    );
    const statisticsRows = await query<StatisticsCatalogRow>(
      createStatisticsQuery(capabilities),
      'extended statistics',
    );
    const largeObjectRows = await query<LargeObjectCatalogRow>(
      LARGE_OBJECTS_QUERY,
      'large objects',
    );
    const replicationOriginRows = await query<{ readonly count: number }>(
      REPLICATION_ORIGINS_QUERY,
      'replication origins',
    );

    const extensionMembers: PostgresExtensionMember[] = [];
    for (const row of extensionMemberRows) {
      const object = extensionMemberReference(row);
      const extensionSchema = extensionRows.find(
        (extension) => extension.extension_name === row.extension_name,
      )?.schema_name;
      const extensionIsInModel = database.schemas.some((schema) => schema.name === extensionSchema);
      if (object === undefined && extensionIsInModel) {
        diagnostics.push({
          code: 'unresolved-extension-member',
          severity: 'warning',
          message: 'An extension member uses an unsupported or unresolved catalog identity.',
          objectOid: row.object_oid,
          objectIdentity: row.extension_name,
        });
      } else if (object !== undefined) {
        extensionMembers.push({ extensionName: row.extension_name, object });
      }
    }

    const foreignTables = this.foreignTables(foreignTableRows);
    const publications = this.publications(
      publicationRows,
      publicationTableRows,
      publicationSchemaRows,
    );
    if (subscriptionRows.length > 0) {
      diagnostics.push({
        code: 'dangerous-object-omitted',
        severity: 'warning',
        message:
          'Subscriptions exist but are omitted by default because they contain sensitive replication configuration.',
      });
    }
    const replicationOriginCount = replicationOriginRows[0]?.count ?? 0;
    if (replicationOriginCount > 0) {
      diagnostics.push({
        code: 'runtime-state-omitted',
        severity: 'warning',
        message: 'Replication origins were detected and omitted as runtime replication state.',
      });
    }

    return {
      database: {
        ...database,
        extensions: extensionRows.map((row) => ({
          oid: row.oid,
          name: row.extension_name,
          schema: row.schema_name,
          owner: row.owner,
          version: row.version,
          relocatable: row.relocatable,
          configurationTableOids: row.configuration_table_oids ?? [],
          configurationConditions: row.configuration_conditions ?? [],
          dependencies: [
            {
              kind: 'schema',
              oid: 0,
              schema: row.schema_name,
              name: row.schema_name,
            },
          ],
          ...(row.comment === null ? {} : { comment: row.comment }),
        })),
        extensionMembers,
        foreignDataWrappers: wrapperRows.map((row) => ({
          oid: row.oid,
          name: row.wrapper_name,
          owner: row.owner,
          ...(row.handler === null ? {} : { handler: row.handler }),
          ...(row.validator === null ? {} : { validator: row.validator }),
          options: options(row.options),
          dependencies: [],
        })),
        foreignServers: serverRows.map((row) => ({
          oid: row.oid,
          name: row.server_name,
          owner: row.owner,
          wrapperOid: row.wrapper_oid,
          wrapperName: row.wrapper_name,
          ...(row.server_type === null ? {} : { type: row.server_type }),
          ...(row.server_version === null ? {} : { version: row.server_version }),
          options: options(row.options),
          dependencies: [
            {
              kind: 'foreign-data-wrapper',
              oid: row.wrapper_oid,
              name: row.wrapper_name,
            },
          ],
        })),
        userMappings: mappingRows.map((row) => {
          const mappedOptions = options(row.options);
          return {
            oid: row.oid,
            serverOid: row.server_oid,
            serverName: row.server_name,
            userName: row.user_name,
            options: mappedOptions,
            containsSensitiveOptions: mappedOptions.some((option) => option.sensitive),
          };
        }),
        foreignTables,
        eventTriggers: eventTriggerRows.map((row) => ({
          oid: row.oid,
          name: row.trigger_name,
          owner: row.owner,
          event: row.event,
          tags: row.tags ?? [],
          function: row.function_name,
          enabled: enabled(row.enabled),
          dependencies: [
            {
              kind: 'function',
              oid: row.function_oid,
              name: row.function_name,
            },
          ],
        })),
        proceduralLanguages: languageRows.map((row) => ({
          oid: row.oid,
          name: row.language_name,
          owner: row.owner,
          trusted: row.trusted,
          ...(row.handler === null ? {} : { handler: row.handler }),
          ...(row.inline_handler === null ? {} : { inlineHandler: row.inline_handler }),
          ...(row.validator === null ? {} : { validator: row.validator }),
          systemProvided: row.system_provided,
          dependencies: [],
        })),
        publications,
        subscriptions: subscriptionRows.map((row) => ({
          oid: row.oid,
          name: row.subscription_name,
          owner: row.owner,
          enabled: row.enabled,
          publications: row.publications,
          ...(row.slot_name === null ? {} : { slotName: row.slot_name }),
          synchronousCommit: row.synchronous_commit,
          binary: row.binary_mode,
          streaming: row.streaming_mode,
          twoPhase: row.two_phase_mode,
          failover: row.failover,
          connectionInfoPresent: row.connection_info_present,
        })),
        tablespaces: tablespaceRows.map((row) => ({
          oid: row.oid,
          name: row.tablespace_name,
          owner: row.owner,
          location: row.location,
          options: row.options ?? [],
        })),
        roles: roleRows.map((row) => ({
          oid: row.oid,
          name: row.role_name,
          superuser: row.superuser,
          inherit: row.inherit,
          createRole: row.create_role,
          createDatabase: row.create_database,
          canLogin: row.can_login,
          replication: row.replication,
          bypassRowLevelSecurity: row.bypass_rls,
          connectionLimit: row.connection_limit,
          ...(row.valid_until === null ? {} : { validUntil: row.valid_until }),
          configuration: row.configuration ?? [],
        })),
        roleMemberships: membershipRows.map((row) => ({
          role: row.role_name,
          member: row.member_name,
          grantor: row.grantor_name,
          adminOption: row.admin_option,
        })),
        statistics: statisticsRows.map((row) => ({
          oid: row.oid,
          schema: row.schema_name,
          name: row.statistics_name,
          owner: row.owner,
          table: {
            kind: 'table',
            oid: row.table_oid,
            schema: row.table_schema,
            name: row.table_name,
          },
          definition: row.definition,
          kinds: row.kinds,
          ...(row.target === null ? {} : { target: row.target }),
          dependencies: [
            {
              kind: 'table',
              oid: row.table_oid,
              schema: row.table_schema,
              name: row.table_name,
            },
          ],
        })),
        largeObjects: largeObjectRows.map((row) => ({
          oid: row.oid,
          owner: row.owner,
          acl: row.acl ?? [],
          ...(row.comment === null ? {} : { comment: row.comment }),
          ...(row.estimated_bytes === null ? {} : { estimatedBytes: Number(row.estimated_bytes) }),
        })),
        replicationOriginCount,
      },
      diagnostics,
    };
  }

  private foreignTables(
    rows: readonly ForeignTableCatalogRow[],
  ): readonly PostgresForeignTableDefinition[] {
    const grouped = new Map<number, PostgresForeignTableDefinition>();
    for (const row of rows) {
      const existing = grouped.get(row.table_oid);
      const columnOptions =
        row.column_name === null
          ? (existing?.columnOptions ?? {})
          : {
              ...(existing?.columnOptions ?? {}),
              [row.column_name]: options(row.column_options),
            };
      grouped.set(row.table_oid, {
        tableOid: row.table_oid,
        serverOid: row.server_oid,
        serverName: row.server_name,
        options: options(row.options),
        columnOptions,
      });
    }
    return [...grouped.values()];
  }

  private publications(
    rows: readonly PublicationCatalogRow[],
    tableRows: readonly PublicationTableCatalogRow[],
    schemaRows: readonly PublicationSchemaCatalogRow[],
  ): readonly PostgresPublication[] {
    return rows.map((row) => ({
      oid: row.oid,
      name: row.publication_name,
      owner: row.owner,
      allTables: row.all_tables,
      publishInsert: row.publish_insert,
      publishUpdate: row.publish_update,
      publishDelete: row.publish_delete,
      publishTruncate: row.publish_truncate,
      publishViaPartitionRoot: row.publish_via_partition_root,
      tables: tableRows
        .filter((table) => table.publication_oid === row.oid)
        .map((table) => ({
          table: {
            kind: 'table',
            oid: table.table_oid,
            schema: table.table_schema,
            name: table.table_name,
          },
          columns: table.columns ?? [],
          ...(table.row_filter === null ? {} : { rowFilter: table.row_filter }),
        })),
      schemas: schemaRows
        .filter((schema) => schema.publication_oid === row.oid)
        .map((schema) => schema.schema_name),
      dependencies: tableRows
        .filter((table) => table.publication_oid === row.oid)
        .map((table) => ({
          kind: 'table' as const,
          oid: table.table_oid,
          schema: table.table_schema,
          name: table.table_name,
        })),
    }));
  }

  private async optionalQuery<Row extends PostgresRow>(
    connection: PostgresConnection,
    query: PostgresQuery,
    subject: string,
    diagnostics: IntrospectionDiagnostic[],
    signal?: AbortSignal,
  ): Promise<readonly Row[]> {
    const transactionStatus = await connection.getTransactionStatus(signal);
    const useSavepoint = transactionStatus !== 'idle';
    try {
      if (useSavepoint) {
        await connection.query({ text: 'SAVEPOINT dbgate_advanced_catalog' }, signal);
      }
      const rows = (await connection.query<Row>(query, signal)).rows;
      if (useSavepoint) {
        await connection.query({ text: 'RELEASE SAVEPOINT dbgate_advanced_catalog' }, signal);
      }
      return rows;
    } catch {
      if (useSavepoint) {
        await connection.query({ text: 'ROLLBACK TO SAVEPOINT dbgate_advanced_catalog' }, signal);
        await connection.query({ text: 'RELEASE SAVEPOINT dbgate_advanced_catalog' }, signal);
      }
      diagnostics.push({
        code: 'advanced-catalog-unavailable',
        severity: 'warning',
        message: `Advanced PostgreSQL ${subject} metadata is unavailable and was omitted.`,
      });
      return [];
    }
  }
}
