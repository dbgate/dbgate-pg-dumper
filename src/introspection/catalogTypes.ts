/**
 * Raw catalog row shapes and pure mapping helpers.
 *
 * Keeping these conversions separate from query execution makes version-aware
 * SQL and normalization independently testable. Dropped attributes remain in
 * `CatalogColumn` until table assembly, preserving physical attribute numbers.
 */

import type { PostgresRow } from '../connection/PostgresConnection.js';
import type {
  PostgresColumn,
  PostgresColumnTypeKind,
  PostgresIdentityMode,
  PostgresPersistence,
  PostgresReplicaIdentity,
  PostgresStorageMode,
  PostgresTableKind,
} from '../model/PostgresDatabase.js';

export interface DatabaseCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly encoding: string;
  readonly collation: string;
  readonly character_type: string;
  readonly tablespace: string;
  readonly connection_limit: number;
  readonly allow_connections: boolean;
  readonly is_template: boolean;
  readonly configuration: readonly string[] | null;
}

export function formatCatalogQualifiedName(schema: string, name: string): string {
  const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  return `${quote(schema)}.${quote(name)}`;
}

export interface SchemaCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
}

export interface TableCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly schema_name: string;
  readonly table_name: string;
  readonly relkind: string;
  readonly relpersistence: string;
  readonly owner: string;
  readonly tablespace: string | null;
  readonly access_method: string | null;
  readonly access_method_is_default?: boolean;
  readonly row_security: boolean;
  readonly force_row_security: boolean;
  readonly estimated_row_count: number;
  readonly replica_identity: string;
  readonly is_partition: boolean;
  readonly partition_bound: string | null;
  readonly parent_oid: number | null;
  readonly parent_schema: string | null;
  readonly parent_name: string | null;
}

export interface ColumnCatalogRow extends PostgresRow {
  readonly table_oid: number;
  readonly attribute_number: number;
  readonly column_name: string;
  readonly formatted_type: string;
  readonly type_oid: number;
  readonly type_modifier: number;
  readonly type_kind: string;
  readonly not_null: boolean;
  readonly default_expression: string | null;
  readonly identity_mode: string;
  readonly generated_mode: string;
  readonly collation_schema: string | null;
  readonly collation_name: string | null;
  readonly collation_is_default?: boolean;
  readonly compression: string | null;
  readonly storage_mode: string;
  readonly default_storage_mode?: string;
  readonly is_dropped: boolean;
}

export interface CatalogColumn {
  readonly tableOid: number;
  readonly attributeNumber: number;
  readonly isDropped: boolean;
  readonly column?: PostgresColumn;
}

export function mapPersistence(value: string): PostgresPersistence {
  if (value === 'u') return 'unlogged';
  if (value === 't') return 'temporary';
  return 'permanent';
}

export function mapTableKind(relkind: string, isPartition: boolean): PostgresTableKind {
  if (isPartition) return 'partition';
  if (relkind === 'p') return 'partitioned';
  if (relkind === 'f') return 'foreign';
  return 'ordinary';
}

export function mapReplicaIdentity(value: string): PostgresReplicaIdentity {
  if (value === 'n') return 'nothing';
  if (value === 'f') return 'full';
  if (value === 'i') return 'index';
  return 'default';
}

function mapIdentity(value: string): PostgresIdentityMode | undefined {
  if (value === 'a') return 'always';
  if (value === 'd') return 'by-default';
  return undefined;
}

function mapStorage(value: string): PostgresStorageMode {
  if (value === 'p') return 'plain';
  if (value === 'e') return 'external';
  if (value === 'm') return 'main';
  return 'extended';
}

function mapColumnTypeKind(value: string): PostgresColumnTypeKind {
  if (value === 'b') return 'base';
  if (value === 'c') return 'composite';
  if (value === 'd') return 'domain';
  if (value === 'e') return 'enum';
  if (value === 'p') return 'pseudo';
  if (value === 'r') return 'range';
  if (value === 'm') return 'multirange';
  return 'unknown';
}

export function mapColumnCatalogRow(row: ColumnCatalogRow): CatalogColumn {
  if (row.is_dropped) {
    return {
      tableOid: row.table_oid,
      attributeNumber: row.attribute_number,
      isDropped: true,
    };
  }

  const identity = mapIdentity(row.identity_mode);
  const isGenerated = row.generated_mode !== '';
  const collation =
    row.collation_schema === null || row.collation_name === null
      ? undefined
      : formatCatalogQualifiedName(row.collation_schema, row.collation_name);

  return {
    tableOid: row.table_oid,
    attributeNumber: row.attribute_number,
    isDropped: false,
    column: {
      tableOid: row.table_oid,
      attributeNumber: row.attribute_number,
      ordinalPosition: row.attribute_number,
      name: row.column_name,
      formattedType: row.formatted_type,
      typeOid: row.type_oid,
      typeModifier: row.type_modifier,
      typeKind: mapColumnTypeKind(row.type_kind),
      nullable: !row.not_null,
      ...(row.default_expression === null || isGenerated
        ? {}
        : { defaultExpression: row.default_expression }),
      ...(identity === undefined ? {} : { identity }),
      ...(!isGenerated || row.default_expression === null
        ? {}
        : { generatedExpression: row.default_expression }),
      ...(collation === undefined ? {} : { collation }),
      ...(collation !== undefined && row.collation_is_default === true
        ? { collationIsDefault: true }
        : {}),
      ...(row.compression === null || row.compression === ''
        ? {}
        : { compression: row.compression }),
      storage: mapStorage(row.storage_mode),
      ...(row.default_storage_mode !== undefined && row.storage_mode === row.default_storage_mode
        ? { storageIsDefault: true }
        : {}),
    },
  };
}
