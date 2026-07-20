/**
 * Initial PostgreSQL catalog introspection.
 *
 * This service loads database metadata, selected schemas, tables, inheritance
 * relationships, and columns. Catalog SQL remains in `catalogQueries`; this
 * class handles execution, filtering, consistency checks, and model assembly.
 */

import type {
  PostgresConnection,
  PostgresQuery,
  PostgresRow,
} from '../connection/PostgresConnection.js';
import type {
  PostgresDatabase,
  PostgresSchema,
  PostgresTable,
  PostgresTableReference,
} from '../model/PostgresDatabase.js';
import {
  isSchemaSelected,
  isTableSelected,
  type NormalizedDumpSelection,
} from '../selection/Selection.js';
import { InconsistentCatalogError, IntrospectionQueryError } from '../utils/errors.js';
import type { SourceCapabilities } from '../version/SourceCapabilities.js';
import { quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import {
  DATABASE_QUERY,
  SCHEMAS_QUERY,
  createColumnsQuery,
  createTablesQuery,
} from './catalogQueries.js';
import {
  mapColumnCatalogRow,
  mapPersistence,
  mapReplicaIdentity,
  mapTableKind,
  type CatalogColumn,
  type ColumnCatalogRow,
  type DatabaseCatalogRow,
  type SchemaCatalogRow,
  type TableCatalogRow,
} from './catalogTypes.js';
import type { IntrospectionDiagnostic } from './diagnostics.js';
import { HigherLevelAssembler } from './HigherLevelAssembler.js';
import {
  COMMENTS_QUERY,
  DEFAULT_PRIVILEGES_QUERY,
  ROLES_QUERY,
  createAclQuery,
  createAggregatesQuery,
  createDependenciesQuery,
  createMaterializedViewIndexesQuery,
  createPoliciesQuery,
  createRoutinesQuery,
  createRulesQuery,
  createTriggersQuery,
  createViewColumnsQuery,
  createViewsQuery,
} from './higherCatalogQueries.js';
import type {
  AclCatalogRow,
  AggregateCatalogRow,
  CommentCatalogRow,
  DefaultPrivilegeCatalogRow,
  DependencyCatalogRow,
  MaterializedViewIndexCatalogRow,
  PolicyCatalogRow,
  RoleCatalogRow,
  RoutineCatalogRow,
  RuleCatalogRow,
  TriggerCatalogRow,
  ViewCatalogRow,
  ViewColumnCatalogRow,
} from './higherCatalogTypes.js';
import { StructuralAssembler } from './StructuralAssembler.js';
import {
  TYPES_QUERY,
  createConstraintsQuery,
  createEnumLabelsQuery,
  createIndexesQuery,
  createPartitionsQuery,
  createSequencesQuery,
} from './structuralCatalogQueries.js';
import type {
  ConstraintCatalogRow,
  EnumLabelCatalogRow,
  IndexCatalogRow,
  PartitionCatalogRow,
  SequenceCatalogRow,
  TypeCatalogRow,
} from './structuralCatalogTypes.js';
import { AdvancedCatalogIntrospector } from './AdvancedIntrospector.js';

interface MutableTable {
  readonly base: Omit<PostgresTable, 'parents' | 'children' | 'columns' | 'dependencies'>;
  readonly parents: PostgresTableReference[];
}

export interface CatalogIntrospectionResult {
  readonly database: PostgresDatabase;
  readonly diagnostics: readonly IntrospectionDiagnostic[];
}

/** Loads the currently supported subset of PostgreSQL's schema model. */
export class PostgresCatalogIntrospector {
  async introspect(
    connection: PostgresConnection,
    capabilities: SourceCapabilities,
    selection: NormalizedDumpSelection,
    signal?: AbortSignal,
  ): Promise<CatalogIntrospectionResult> {
    const databaseRows = await this.query<DatabaseCatalogRow>(
      connection,
      DATABASE_QUERY,
      'database metadata',
      signal,
    );
    const schemaRows = await this.query<SchemaCatalogRow>(
      connection,
      SCHEMAS_QUERY,
      'schemas',
      signal,
    );
    const tableRows = await this.query<TableCatalogRow>(
      connection,
      createTablesQuery(capabilities),
      'tables',
      signal,
    );

    const database = databaseRows[0];
    if (database === undefined) {
      throw new InconsistentCatalogError('Current database metadata was not found.');
    }

    const selectedSchemas = schemaRows.filter((row) => isSchemaSelected(row.name, selection));
    const selectedSchemaNames = new Set(selectedSchemas.map((row) => row.name));
    const typeRows = (
      await this.query<TypeCatalogRow>(connection, TYPES_QUERY, 'enum and domain types', signal)
    ).filter((row) => selectedSchemaNames.has(row.schema_name));
    const enumTypeOids = typeRows.filter((row) => row.type_kind === 'e').map((row) => row.oid);
    const enumLabels =
      enumTypeOids.length === 0
        ? []
        : await this.query<EnumLabelCatalogRow>(
            connection,
            createEnumLabelsQuery(enumTypeOids),
            'enum labels',
            signal,
          );
    const selectedTableRows = tableRows.filter(
      (row) =>
        selectedSchemaNames.has(row.schema_name) &&
        isTableSelected(row.schema_name, row.table_name, selection),
    );
    const tables = this.collectTables(selectedTableRows);
    const tableOids = [...tables.keys()];
    const columnRows =
      tableOids.length === 0
        ? []
        : await this.query<ColumnCatalogRow>(
            connection,
            createColumnsQuery(capabilities, tableOids),
            'columns',
            signal,
          );
    const columns = columnRows.map(mapColumnCatalogRow);
    const baseDatabase: PostgresDatabase = {
      oid: database.oid,
      name: database.name,
      owner: database.owner,
      encoding: database.encoding,
      collation: database.collation,
      characterType: database.character_type,
      tablespace: database.tablespace,
      connectionLimit: database.connection_limit,
      allowConnections: database.allow_connections,
      template: database.is_template,
      configuration: database.configuration ?? [],
      schemas: this.assembleSchemas(selectedSchemas, tables, columns),
      constraints: [],
      indexes: [],
      views: [],
      materializedViews: [],
      functions: [],
      procedures: [],
      aggregates: [],
      triggers: [],
      rules: [],
      policies: [],
      comments: [],
      ownerships: [],
      accessControls: [],
      defaultPrivileges: [],
    };
    const rawSequenceRows = await this.query<SequenceCatalogRow>(
      connection,
      createSequencesQuery(capabilities),
      'sequences',
      signal,
    );
    /*
     * `pg_sequences` does not expose is_called, and PostgreSQL 9.6 has no
     * pg_sequence catalog. The sequence relation itself is the only portable,
     * exact source for both fields. Read selected sequences inside the same
     * repeatable-read snapshot as table data.
     */
    const sequenceStateDiagnostics: IntrospectionDiagnostic[] = [];
    const sequenceRows: SequenceCatalogRow[] = [];
    for (const row of rawSequenceRows) {
      if (!selectedSchemaNames.has(row.schema_name)) continue;
      try {
        const identity = quoteQualifiedIdentifier([row.schema_name, row.sequence_name], {
          quoteAllIdentifiers: true,
        });
        const state = await connection.query<{
          readonly current_value: string;
          readonly is_called: boolean;
        }>(
          {
            text: `SELECT last_value::pg_catalog.text AS current_value, is_called FROM ${identity}`,
          },
          signal,
        );
        const value = state.rows[0];
        sequenceRows.push({
          ...row,
          current_value: value?.current_value ?? null,
          is_called: value?.is_called ?? null,
        });
      } catch {
        sequenceRows.push(row);
        sequenceStateDiagnostics.push({
          code: 'unsupported-catalog-metadata',
          severity: 'warning',
          message: 'Exact sequence state could not be read and will be omitted.',
          objectOid: row.oid,
          objectIdentity: `${row.schema_name}.${row.sequence_name}`,
        });
      }
    }
    const domainOids = typeRows.filter((row) => row.type_kind === 'd').map((row) => row.oid);
    const constraintRows = await this.query<ConstraintCatalogRow>(
      connection,
      createConstraintsQuery(capabilities, tableOids, domainOids),
      'constraints',
      signal,
    );
    const indexRows =
      tableOids.length === 0
        ? []
        : await this.query<IndexCatalogRow>(
            connection,
            createIndexesQuery(capabilities, tableOids),
            'indexes',
            signal,
          );
    const partitionQuery = createPartitionsQuery(capabilities, tableOids);
    const partitionRows =
      partitionQuery === undefined
        ? []
        : await this.query<PartitionCatalogRow>(
            connection,
            partitionQuery,
            'partition definitions',
            signal,
          );

    const assembled = new StructuralAssembler().assemble(
      baseDatabase,
      {
        types: typeRows,
        enumLabels,
        sequences: sequenceRows,
        constraints: constraintRows,
        indexes: indexRows,
        partitions: partitionRows,
      },
      selection,
    );
    const roleRows = await this.query<RoleCatalogRow>(connection, ROLES_QUERY, 'roles', signal);
    const viewRows = await this.query<ViewCatalogRow>(
      connection,
      createViewsQuery(capabilities),
      'views and materialized views',
      signal,
    );
    const selectedViewRows = viewRows.filter((row) => selectedSchemaNames.has(row.schema_name));
    const viewOids = selectedViewRows.map((row) => row.oid);
    const materializedViewOids = selectedViewRows
      .filter((row) => row.relation_kind === 'm')
      .map((row) => row.oid);
    const viewColumnRows =
      viewOids.length === 0
        ? []
        : await this.query<ViewColumnCatalogRow>(
            connection,
            createViewColumnsQuery(viewOids),
            'view columns',
            signal,
          );
    const materializedViewIndexRows =
      materializedViewOids.length === 0
        ? []
        : await this.query<MaterializedViewIndexCatalogRow>(
            connection,
            createMaterializedViewIndexesQuery(materializedViewOids),
            'materialized-view indexes',
            signal,
          );
    const routineRows = await this.query<RoutineCatalogRow>(
      connection,
      createRoutinesQuery(capabilities),
      'functions and procedures',
      signal,
    );
    const aggregateRows = await this.query<AggregateCatalogRow>(
      connection,
      createAggregatesQuery(capabilities),
      'aggregates',
      signal,
    );
    const selectedRoutineOids = [
      ...routineRows
        .filter((row) => selectedSchemaNames.has(row.schema_name))
        .map((row) => row.oid),
      ...aggregateRows
        .filter((row) => selectedSchemaNames.has(row.schema_name))
        .map((row) => row.oid),
    ];
    const relationOids = [...tableOids, ...viewOids];
    const triggerRows =
      relationOids.length === 0
        ? []
        : await this.query<TriggerCatalogRow>(
            connection,
            createTriggersQuery(capabilities, relationOids),
            'triggers',
            signal,
          );
    const ruleRows =
      relationOids.length === 0
        ? []
        : await this.query<RuleCatalogRow>(
            connection,
            createRulesQuery(relationOids),
            'rewrite rules',
            signal,
          );
    const policyRows =
      tableOids.length === 0
        ? []
        : await this.query<PolicyCatalogRow>(
            connection,
            createPoliciesQuery(capabilities, tableOids),
            'row-level security policies',
            signal,
          );
    const commentRows = await this.query<CommentCatalogRow>(
      connection,
      COMMENTS_QUERY,
      'comments',
      signal,
    );
    const aclRows = await this.query<AclCatalogRow>(
      connection,
      createAclQuery(capabilities),
      'access-control lists',
      signal,
    );
    const defaultPrivilegeRows = await this.query<DefaultPrivilegeCatalogRow>(
      connection,
      DEFAULT_PRIVILEGES_QUERY,
      'default privileges',
      signal,
    );
    const dependencyRows = await this.query<DependencyCatalogRow>(
      connection,
      createDependenciesQuery(
        relationOids,
        selectedRoutineOids,
        triggerRows.map((row) => row.oid),
        policyRows.map((row) => row.oid),
      ),
      'higher-level dependencies',
      signal,
    );
    const higher = new HigherLevelAssembler().assemble(
      assembled.database,
      {
        roles: roleRows,
        views: selectedViewRows,
        viewColumns: viewColumnRows,
        materializedViewIndexes: materializedViewIndexRows,
        routines: routineRows,
        aggregates: aggregateRows,
        triggers: triggerRows,
        rules: ruleRows,
        policies: policyRows,
        comments: commentRows,
        acls: aclRows,
        defaultPrivileges: defaultPrivilegeRows,
        dependencies: dependencyRows,
      },
      selection,
      capabilities,
    );

    const advanced = await new AdvancedCatalogIntrospector().introspect(
      connection,
      higher.database,
      capabilities,
      signal,
    );
    const diagnostics: IntrospectionDiagnostic[] = [
      ...assembled.diagnostics,
      ...higher.diagnostics,
      ...sequenceStateDiagnostics,
      ...advanced.diagnostics,
    ];
    return { database: advanced.database, diagnostics };
  }

  private async query<Row extends PostgresRow>(
    connection: PostgresConnection,
    query: PostgresQuery,
    subject: string,
    signal?: AbortSignal,
  ): Promise<readonly Row[]> {
    try {
      return (await connection.query<Row>(query, signal)).rows;
    } catch (cause) {
      throw new IntrospectionQueryError(`Failed to introspect PostgreSQL ${subject}.`, { cause });
    }
  }

  private collectTables(rows: readonly TableCatalogRow[]): ReadonlyMap<number, MutableTable> {
    const tables = new Map<number, MutableTable>();

    for (const row of rows) {
      let table = tables.get(row.oid);
      if (table === undefined) {
        table = {
          base: {
            oid: row.oid,
            schema: row.schema_name,
            name: row.table_name,
            kind: mapTableKind(row.relkind, row.is_partition),
            persistence: mapPersistence(row.relpersistence),
            owner: row.owner,
            ...(row.tablespace === null ? {} : { tablespace: row.tablespace }),
            ...(row.access_method === null ? {} : { accessMethod: row.access_method }),
            rowLevelSecurity: row.row_security,
            forceRowLevelSecurity: row.force_row_security,
            estimatedRowCount: row.estimated_row_count,
            replicaIdentity: mapReplicaIdentity(row.replica_identity),
            ...(row.partition_bound === null ? {} : { partitionBound: row.partition_bound }),
          },
          parents: [],
        };
        tables.set(row.oid, table);
      }

      if (
        row.parent_oid !== null &&
        row.parent_schema !== null &&
        row.parent_name !== null &&
        !table.parents.some((parent) => parent.oid === row.parent_oid)
      ) {
        table.parents.push({
          oid: row.parent_oid,
          schema: row.parent_schema,
          name: row.parent_name,
        });
      }
    }
    return tables;
  }

  private assembleSchemas(
    schemaRows: readonly SchemaCatalogRow[],
    mutableTables: ReadonlyMap<number, MutableTable>,
    catalogColumns: readonly CatalogColumn[],
  ): readonly PostgresSchema[] {
    const columnsByTable = new Map<number, CatalogColumn[]>();
    for (const column of catalogColumns) {
      const columns = columnsByTable.get(column.tableOid) ?? [];
      columns.push(column);
      columnsByTable.set(column.tableOid, columns);
    }

    const childrenByParent = new Map<number, PostgresTableReference[]>();
    for (const table of mutableTables.values()) {
      const reference = {
        oid: table.base.oid,
        schema: table.base.schema,
        name: table.base.name,
      };
      for (const parent of table.parents) {
        if (!mutableTables.has(parent.oid)) continue;
        const children = childrenByParent.get(parent.oid) ?? [];
        children.push(reference);
        childrenByParent.set(parent.oid, children);
      }
    }

    const tablesBySchema = new Map<string, PostgresTable[]>();
    for (const table of mutableTables.values()) {
      const physicalColumns = columnsByTable.get(table.base.oid) ?? [];
      const visibleColumns = physicalColumns.flatMap((column) =>
        column.isDropped || column.column === undefined ? [] : [column.column],
      );
      const assembled: PostgresTable = {
        ...table.base,
        parents: table.parents,
        children: childrenByParent.get(table.base.oid) ?? [],
        dependencies: table.parents.map((parent) => ({
          kind: 'table',
          oid: parent.oid,
          schema: parent.schema,
          name: parent.name,
        })),
        columns: visibleColumns,
      };
      const schemaTables = tablesBySchema.get(table.base.schema) ?? [];
      schemaTables.push(assembled);
      tablesBySchema.set(table.base.schema, schemaTables);
    }

    return schemaRows.map((schema) => ({
      oid: schema.oid,
      name: schema.name,
      owner: schema.owner,
      tables: (tablesBySchema.get(schema.name) ?? []).sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      sequences: [],
      enumTypes: [],
      domains: [],
    }));
  }
}
