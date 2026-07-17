/**
 * Pure relationship assembly for structural catalog objects.
 *
 * The assembler resolves OIDs and attribute numbers against the initial table
 * model, emits diagnostics for unresolved or malformed metadata, and returns a
 * new immutable database model enriched with types, sequences, constraints,
 * indexes, partition definitions, and preliminary dependency references.
 */

import type {
  PostgresColumn,
  PostgresDatabase,
  PostgresSchema,
  PostgresTable,
} from '../model/PostgresDatabase.js';
import type {
  PostgresCheckConstraint,
  PostgresConstraint,
  PostgresDomain,
  PostgresEnumType,
  PostgresForeignKeyAction,
  PostgresForeignKeyMatch,
  PostgresIndex,
  PostgresIndexElement,
  PostgresKeyConstraint,
  PostgresObjectReference,
  PostgresPartitionDefinition,
  PostgresPartitionStrategy,
  PostgresSequence,
} from '../model/PostgresStructuralObjects.js';
import type { NormalizedDumpSelection } from '../selection/Selection.js';
import { isSchemaSelected } from '../selection/Selection.js';
import { IntrospectionDiagnostics } from './diagnostics.js';
import type { IntrospectionDiagnostic } from './diagnostics.js';
import type {
  ConstraintCatalogRow,
  EnumLabelCatalogRow,
  IndexCatalogRow,
  PartitionCatalogRow,
  SequenceCatalogRow,
  TypeCatalogRow,
} from './structuralCatalogTypes.js';

export interface StructuralCatalogSnapshot {
  readonly types: readonly TypeCatalogRow[];
  readonly enumLabels: readonly EnumLabelCatalogRow[];
  readonly sequences: readonly SequenceCatalogRow[];
  readonly constraints: readonly ConstraintCatalogRow[];
  readonly indexes: readonly IndexCatalogRow[];
  readonly partitions: readonly PartitionCatalogRow[];
}

export interface StructuralAssemblyResult {
  readonly database: PostgresDatabase;
  readonly diagnostics: readonly IntrospectionDiagnostic[];
}

interface ModelLookup {
  readonly tables: ReadonlyMap<number, PostgresTable>;
  readonly columns: ReadonlyMap<string, PostgresColumn>;
  readonly types: ReadonlyMap<number, PostgresEnumType | PostgresDomain>;
}

function attributeKey(tableOid: number, attributeNumber: number): string {
  return `${tableOid}:${attributeNumber}`;
}

function tableReference(table: PostgresTable): PostgresObjectReference {
  return {
    kind: 'table',
    oid: table.oid,
    schema: table.schema,
    name: table.name,
  };
}

function columnReference(column: PostgresColumn, table: PostgresTable): PostgresObjectReference {
  return {
    kind: 'column',
    oid: table.oid,
    schema: table.schema,
    name: table.name,
    subName: column.name,
  };
}

export class StructuralAssembler {
  assemble(
    database: PostgresDatabase,
    snapshot: StructuralCatalogSnapshot,
    selection: NormalizedDumpSelection,
  ): StructuralAssemblyResult {
    const diagnostics = new IntrospectionDiagnostics();
    const tables = new Map(
      database.schemas.flatMap((schema) =>
        schema.tables.map((table) => [table.oid, table] as const),
      ),
    );
    const columns = new Map<string, PostgresColumn>();
    for (const table of tables.values()) {
      for (const column of table.columns) {
        columns.set(attributeKey(table.oid, column.attributeNumber), column);
      }
      for (const parent of table.parents) {
        if (!tables.has(parent.oid)) {
          diagnostics.add({
            code: 'unresolved-partition-parent',
            severity: 'warning',
            message: 'A partition parent was excluded or missing from the catalog snapshot.',
            objectOid: table.oid,
            objectIdentity: `${table.schema}.${table.name}`,
          });
        }
      }
    }

    const { enumTypes, domains, typeMap } = this.assembleTypes(
      snapshot.types.filter((row) => isSchemaSelected(row.schema_name, selection)),
      snapshot.enumLabels,
    );
    const lookup: ModelLookup = { tables, columns, types: typeMap };
    const constraints = this.assembleConstraints(snapshot.constraints, lookup, diagnostics);
    const domainConstraints = new Map<number, PostgresCheckConstraint[]>();
    for (const constraint of constraints) {
      if (constraint.kind === 'check' && constraint.domain !== undefined) {
        const items = domainConstraints.get(constraint.domain.oid) ?? [];
        items.push(constraint);
        domainConstraints.set(constraint.domain.oid, items);
      }
    }
    const completedDomains = domains.map((domain) => ({
      ...domain,
      constraints: domainConstraints.get(domain.oid) ?? [],
    }));
    const completedTypeMap = new Map<number, PostgresEnumType | PostgresDomain>([
      ...enumTypes.map((value) => [value.oid, value] as const),
      ...completedDomains.map((value) => [value.oid, value] as const),
    ]);
    const enrichedLookup: ModelLookup = { tables, columns, types: completedTypeMap };

    const sequences = this.assembleSequences(
      snapshot.sequences.filter((row) => isSchemaSelected(row.schema_name, selection)),
      enrichedLookup,
      diagnostics,
    );
    const indexes = this.assembleIndexes(snapshot.indexes, enrichedLookup, diagnostics);
    const partitions = this.assemblePartitions(snapshot.partitions);
    const enrichedTables = this.enrichTables(tables, completedTypeMap, partitions);
    const enrichedTableMap = new Map(enrichedTables.map((table) => [table.oid, table]));

    const schemas = database.schemas.map((schema) =>
      this.enrichSchema(schema, enrichedTableMap, sequences, enumTypes, completedDomains),
    );

    return {
      database: {
        ...database,
        schemas,
        constraints,
        indexes,
      },
      diagnostics: diagnostics.getAll(),
    };
  }

  private assembleTypes(
    rows: readonly TypeCatalogRow[],
    labelRows: readonly EnumLabelCatalogRow[],
  ): {
    readonly enumTypes: readonly PostgresEnumType[];
    readonly domains: readonly PostgresDomain[];
    readonly typeMap: ReadonlyMap<number, PostgresEnumType | PostgresDomain>;
  } {
    const labels = new Map<number, EnumLabelCatalogRow[]>();
    for (const label of labelRows) {
      const items = labels.get(label.type_oid) ?? [];
      items.push(label);
      labels.set(label.type_oid, items);
    }

    const enumTypes: PostgresEnumType[] = [];
    const domains: PostgresDomain[] = [];
    for (const row of rows) {
      if (row.type_kind === 'e') {
        enumTypes.push({
          oid: row.oid,
          schema: row.schema_name,
          name: row.type_name,
          owner: row.owner,
          dependencies: [],
          labels: (labels.get(row.oid) ?? [])
            .sort((left, right) => left.sort_order - right.sort_order)
            .map((label) => ({
              oid: label.label_oid,
              label: label.label,
              sortOrder: label.sort_order,
            })),
        });
      } else if (row.type_kind === 'd' && row.formatted_base_type !== null) {
        const collation =
          row.collation_schema === null || row.collation_name === null
            ? undefined
            : `${row.collation_schema}.${row.collation_name}`;
        domains.push({
          oid: row.oid,
          schema: row.schema_name,
          name: row.type_name,
          owner: row.owner,
          dependencies: [],
          baseTypeOid: row.base_type_oid,
          formattedBaseType: row.formatted_base_type,
          nullable: !row.not_null,
          ...(row.default_expression === null ? {} : { defaultExpression: row.default_expression }),
          ...(collation === undefined ? {} : { collation }),
          constraints: [],
        });
      }
    }
    return {
      enumTypes,
      domains,
      typeMap: new Map<number, PostgresEnumType | PostgresDomain>([
        ...enumTypes.map((value) => [value.oid, value] as const),
        ...domains.map((value) => [value.oid, value] as const),
      ]),
    };
  }

  private assembleSequences(
    rows: readonly SequenceCatalogRow[],
    lookup: ModelLookup,
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresSequence[] {
    return rows.map((row) => {
      let ownedBy: PostgresObjectReference | undefined;
      if (row.owned_table_oid !== null && row.owned_attribute_number !== null) {
        const table = lookup.tables.get(row.owned_table_oid);
        const column = lookup.columns.get(
          attributeKey(row.owned_table_oid, row.owned_attribute_number),
        );
        if (table === undefined || column === undefined) {
          diagnostics.add({
            code: 'orphaned-sequence',
            severity: 'warning',
            message: 'A sequence ownership dependency references a missing table column.',
            objectOid: row.oid,
            objectIdentity: `${row.schema_name}.${row.sequence_name}`,
          });
        } else {
          ownedBy = columnReference(column, table);
        }
      }

      return {
        oid: row.oid,
        schema: row.schema_name,
        name: row.sequence_name,
        owner: row.owner,
        dataType: row.data_type,
        startValue: row.start_value,
        increment: row.increment,
        minimumValue: row.minimum_value,
        maximumValue: row.maximum_value,
        cacheSize: row.cache_size,
        cycle: row.cycle,
        ...(row.current_value === null ? {} : { currentValue: row.current_value }),
        ...(row.is_called === null ? {} : { isCalled: row.is_called }),
        ownership:
          row.dependency_type === 'i'
            ? 'identity'
            : row.dependency_type === 'a'
              ? 'serial'
              : 'standalone',
        ...(ownedBy === undefined ? {} : { ownedBy }),
        dependencies: ownedBy === undefined ? [] : [ownedBy],
      };
    });
  }

  private assembleConstraints(
    rows: readonly ConstraintCatalogRow[],
    lookup: ModelLookup,
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresConstraint[] {
    const constraints: PostgresConstraint[] = [];
    for (const row of rows) {
      if (!row.validated) {
        diagnostics.add({
          code: 'unvalidated-constraint',
          severity: 'warning',
          message: 'An unvalidated constraint was detected.',
          objectOid: row.oid,
          objectIdentity: `${row.schema_name}.${row.constraint_name}`,
        });
      }

      if (row.constraint_type === 'p' || row.constraint_type === 'u') {
        const table = lookup.tables.get(row.table_oid);
        if (table === undefined) {
          this.missingReference(row, diagnostics, 'constraint table');
          continue;
        }
        const columns = this.resolveColumns(
          row,
          row.table_oid,
          row.column_numbers,
          lookup,
          diagnostics,
        );
        const value: PostgresKeyConstraint = {
          oid: row.oid,
          schema: row.schema_name,
          name: row.constraint_name,
          kind: row.constraint_type === 'p' ? 'primary-key' : 'unique',
          validated: row.validated,
          table: tableReference(table),
          columns,
          deferrable: row.deferrable,
          initiallyDeferred: row.initially_deferred,
          backingIndexOid: row.backing_index_oid,
          nullsNotDistinct: row.nulls_not_distinct,
          ...(row.parent_constraint_oid === 0
            ? {}
            : { parentConstraintOid: row.parent_constraint_oid }),
          dependencies: [tableReference(table), ...columns],
        };
        constraints.push(value);
        continue;
      }

      if (row.constraint_type === 'f') {
        const source = lookup.tables.get(row.table_oid);
        const target = lookup.tables.get(row.referenced_table_oid);
        if (source === undefined || target === undefined) {
          this.missingReference(row, diagnostics, 'foreign-key table');
          continue;
        }
        const sourceColumns = this.resolveColumns(
          row,
          row.table_oid,
          row.column_numbers,
          lookup,
          diagnostics,
        );
        const targetColumns = this.resolveColumns(
          row,
          row.referenced_table_oid,
          row.referenced_column_numbers,
          lookup,
          diagnostics,
        );
        if (sourceColumns.length !== targetColumns.length) {
          diagnostics.add({
            code: 'malformed-constraint-columns',
            severity: 'warning',
            message: 'Foreign-key source and target column counts do not match.',
            objectOid: row.oid,
            objectIdentity: `${row.schema_name}.${row.constraint_name}`,
          });
        }
        constraints.push({
          oid: row.oid,
          schema: row.schema_name,
          name: row.constraint_name,
          kind: 'foreign-key',
          validated: row.validated,
          sourceTable: tableReference(source),
          targetTable: tableReference(target),
          sourceColumns,
          targetColumns,
          match: this.mapMatch(row.match_type),
          onUpdate: this.mapAction(row.update_action),
          onDelete: this.mapAction(row.delete_action),
          deferrable: row.deferrable,
          initiallyDeferred: row.initially_deferred,
          ...(row.parent_constraint_oid === 0
            ? {}
            : { parentConstraintOid: row.parent_constraint_oid }),
          dependencies: [
            tableReference(source),
            tableReference(target),
            ...sourceColumns,
            ...targetColumns,
          ],
        });
        continue;
      }

      if (row.constraint_type === 'c' && row.expression !== null) {
        const table = lookup.tables.get(row.table_oid);
        const domain = lookup.types.get(row.domain_oid);
        if (table === undefined && (domain === undefined || !('baseTypeOid' in domain))) {
          this.missingReference(row, diagnostics, 'check-constraint owner');
          continue;
        }
        const ownerReference =
          table === undefined
            ? {
                kind: 'domain' as const,
                oid: domain!.oid,
                schema: domain!.schema,
                name: domain!.name,
              }
            : tableReference(table);
        constraints.push({
          oid: row.oid,
          schema: row.schema_name,
          name: row.constraint_name,
          kind: 'check',
          validated: row.validated,
          expression: row.expression,
          definition: row.definition,
          noInherit: row.no_inherit,
          locallyDefined: row.locally_defined,
          inheritanceCount: row.inheritance_count,
          ...(table === undefined ? { domain: ownerReference } : { table: ownerReference }),
          ...(row.parent_constraint_oid === 0
            ? {}
            : { parentConstraintOid: row.parent_constraint_oid }),
          dependencies: [ownerReference],
        });
      }
    }
    return constraints;
  }

  private resolveColumns(
    row: ConstraintCatalogRow,
    tableOid: number,
    attributeNumbers: readonly number[] | null,
    lookup: ModelLookup,
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresObjectReference[] {
    if (attributeNumbers === null) {
      diagnostics.add({
        code: 'malformed-constraint-columns',
        severity: 'warning',
        message: 'A column-based constraint has no catalog column array.',
        objectOid: row.oid,
        objectIdentity: `${row.schema_name}.${row.constraint_name}`,
      });
      return [];
    }
    const table = lookup.tables.get(tableOid);
    if (table === undefined) return [];
    return attributeNumbers.flatMap((attributeNumber) => {
      const column = lookup.columns.get(attributeKey(tableOid, attributeNumber));
      if (column === undefined) {
        diagnostics.add({
          code: 'missing-reference',
          severity: 'warning',
          message: 'A constraint references a missing table column.',
          objectOid: row.oid,
          objectIdentity: `${row.schema_name}.${row.constraint_name}`,
        });
        return [];
      }
      return [columnReference(column, table)];
    });
  }

  private assembleIndexes(
    rows: readonly IndexCatalogRow[],
    lookup: ModelLookup,
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresIndex[] {
    return rows.flatMap((row) => {
      const table = lookup.tables.get(row.table_oid);
      if (table === undefined) {
        diagnostics.add({
          code: 'missing-reference',
          severity: 'warning',
          message: 'An index references a missing table.',
          objectOid: row.oid,
          objectIdentity: `${row.schema_name}.${row.index_name}`,
        });
        return [];
      }
      const exportable = row.valid && row.ready && row.live;
      if (!exportable) {
        diagnostics.add({
          code: 'invalid-index',
          severity: 'warning',
          message: 'An invalid, unfinished, or dropping index was detected.',
          objectOid: row.oid,
          objectIdentity: `${row.schema_name}.${row.index_name}`,
        });
      }
      const elements: PostgresIndexElement[] = row.attribute_numbers.map(
        (attributeNumber, index) => {
          const key = index < row.key_attributes;
          const option = row.options[index] ?? 0;
          const column = lookup.columns.get(attributeKey(row.table_oid, attributeNumber));
          const reference =
            attributeNumber === 0 || column === undefined
              ? undefined
              : columnReference(column, table);
          return {
            position: index + 1,
            key,
            ...(attributeNumber === 0 ? {} : { attributeNumber }),
            ...(reference === undefined ? {} : { column: reference }),
            ...(attributeNumber !== 0
              ? {}
              : { expression: row.element_definitions[index] ?? row.expressions ?? '' }),
            ...(row.operator_classes[index] == null
              ? {}
              : { operatorClass: row.operator_classes[index] }),
            ...(row.collations[index] == null ? {} : { collation: row.collations[index] }),
            ...(key && row.access_method === 'btree'
              ? { direction: (option & 1) === 1 ? 'descending' : 'ascending' }
              : {}),
            ...(key && row.access_method === 'btree'
              ? { nulls: (option & 2) === 2 ? 'first' : 'last' }
              : {}),
          };
        },
      );
      const dependencyColumns = elements.flatMap((element) =>
        element.column === undefined ? [] : [element.column],
      );
      return [
        {
          oid: row.oid,
          schema: row.schema_name,
          name: row.index_name,
          owner: row.owner,
          table: tableReference(table),
          accessMethod: row.access_method,
          unique: row.unique_index,
          primary: row.primary_index,
          exclusion: row.exclusion_index,
          immediate: row.immediate,
          nullsNotDistinct: row.nulls_not_distinct,
          valid: row.valid,
          ready: row.ready,
          live: row.live,
          exportable,
          clustered: row.clustered,
          replicaIdentity: row.replica_identity,
          ...(row.tablespace === null ? {} : { tablespace: row.tablespace }),
          storageParameters: row.storage_parameters ?? [],
          ...(row.predicate === null ? {} : { predicate: row.predicate }),
          ...(row.expressions === null ? {} : { expressions: row.expressions }),
          definition: row.definition,
          elements,
          ...(row.parent_index_oid === 0 ? {} : { parentIndexOid: row.parent_index_oid }),
          dependencies: [tableReference(table), ...dependencyColumns],
        },
      ];
    });
  }

  private assemblePartitions(
    rows: readonly PartitionCatalogRow[],
  ): ReadonlyMap<number, PostgresPartitionDefinition> {
    return new Map(
      rows.map((row) => [
        row.table_oid,
        {
          strategy: this.mapPartitionStrategy(row.strategy),
          keyDefinition: row.key_definition,
          keyAttributeNumbers: row.key_attribute_numbers,
          ...(row.default_partition_oid === 0
            ? {}
            : { defaultPartitionOid: row.default_partition_oid }),
        },
      ]),
    );
  }

  private enrichTables(
    tables: ReadonlyMap<number, PostgresTable>,
    types: ReadonlyMap<number, PostgresEnumType | PostgresDomain>,
    partitions: ReadonlyMap<number, PostgresPartitionDefinition>,
  ): readonly PostgresTable[] {
    return [...tables.values()].map((table) => ({
      ...table,
      ...(partitions.has(table.oid) ? { partition: partitions.get(table.oid)! } : {}),
      ...(table.partitionBound === undefined
        ? {}
        : {
            bound: {
              expression: table.partitionBound,
              default: table.partitionBound.trim().toUpperCase() === 'DEFAULT',
            },
          }),
      columns: table.columns.map((column) => {
        const type = types.get(column.typeOid);
        return {
          ...column,
          ...(type === undefined
            ? {}
            : {
                typeDependency: {
                  kind: 'baseTypeOid' in type ? ('domain' as const) : ('enum' as const),
                  oid: type.oid,
                  schema: type.schema,
                  name: type.name,
                },
              }),
        };
      }),
    }));
  }

  private enrichSchema(
    schema: PostgresSchema,
    tables: ReadonlyMap<number, PostgresTable>,
    sequences: readonly PostgresSequence[],
    enumTypes: readonly PostgresEnumType[],
    domains: readonly PostgresDomain[],
  ): PostgresSchema {
    return {
      ...schema,
      tables: schema.tables.map((table) => tables.get(table.oid) ?? table),
      sequences: sequences.filter((value) => value.schema === schema.name),
      enumTypes: enumTypes.filter((value) => value.schema === schema.name),
      domains: domains.filter((value) => value.schema === schema.name),
    };
  }

  private mapAction(value: string): PostgresForeignKeyAction {
    if (value === 'r') return 'restrict';
    if (value === 'c') return 'cascade';
    if (value === 'n') return 'set-null';
    if (value === 'd') return 'set-default';
    return 'no-action';
  }

  private mapMatch(value: string): PostgresForeignKeyMatch {
    if (value === 'f') return 'full';
    if (value === 'p') return 'partial';
    return 'simple';
  }

  private mapPartitionStrategy(value: string): PostgresPartitionStrategy {
    if (value === 'l') return 'list';
    if (value === 'h') return 'hash';
    return 'range';
  }

  private missingReference(
    row: ConstraintCatalogRow,
    diagnostics: IntrospectionDiagnostics,
    subject: string,
  ): void {
    diagnostics.add({
      code: 'missing-reference',
      severity: 'warning',
      message: `A ${subject} reference could not be resolved.`,
      objectOid: row.oid,
      objectIdentity: `${row.schema_name}.${row.constraint_name}`,
    });
  }
}
