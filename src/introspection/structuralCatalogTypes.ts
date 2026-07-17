/**
 * Raw row contracts for structural catalog queries.
 *
 * PostgreSQL arrays are returned as JavaScript arrays by node-postgres adapters;
 * other adapters must provide equivalent typed values. Mapping into normalized
 * models occurs in `StructuralAssembler`.
 */

import type { PostgresRow } from '../connection/PostgresConnection.js';

export interface TypeCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly schema_name: string;
  readonly type_name: string;
  readonly type_kind: string;
  readonly owner: string;
  readonly base_type_oid: number;
  readonly formatted_base_type: string | null;
  readonly not_null: boolean;
  readonly default_expression: string | null;
  readonly collation_schema: string | null;
  readonly collation_name: string | null;
}

export interface EnumLabelCatalogRow extends PostgresRow {
  readonly type_oid: number;
  readonly label_oid: number;
  readonly label: string;
  readonly sort_order: number;
}

export interface SequenceCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly schema_name: string;
  readonly sequence_name: string;
  readonly owner: string;
  readonly data_type: string;
  readonly start_value: string;
  readonly increment: string;
  readonly minimum_value: string;
  readonly maximum_value: string;
  readonly cache_size: string;
  readonly cycle: boolean;
  readonly current_value: string | null;
  readonly is_called: boolean | null;
  readonly dependency_type: string | null;
  readonly owned_table_oid: number | null;
  readonly owned_table_schema: string | null;
  readonly owned_table_name: string | null;
  readonly owned_attribute_number: number | null;
  readonly owned_column_name: string | null;
}

export interface ConstraintCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly constraint_name: string;
  readonly schema_name: string;
  readonly constraint_type: string;
  readonly table_oid: number;
  readonly domain_oid: number;
  readonly referenced_table_oid: number;
  readonly column_numbers: number[] | null;
  readonly referenced_column_numbers: number[] | null;
  readonly deferrable: boolean;
  readonly initially_deferred: boolean;
  readonly validated: boolean;
  readonly backing_index_oid: number;
  readonly parent_constraint_oid: number;
  readonly match_type: string;
  readonly update_action: string;
  readonly delete_action: string;
  readonly locally_defined: boolean;
  readonly inheritance_count: number;
  readonly no_inherit: boolean;
  readonly expression: string | null;
  readonly definition: string;
  readonly nulls_not_distinct: boolean;
}

export interface IndexCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly schema_name: string;
  readonly index_name: string;
  readonly owner: string;
  readonly table_oid: number;
  readonly access_method: string;
  readonly unique_index: boolean;
  readonly primary_index: boolean;
  readonly exclusion_index: boolean;
  readonly immediate: boolean;
  readonly nulls_not_distinct: boolean;
  readonly valid: boolean;
  readonly ready: boolean;
  readonly live: boolean;
  readonly clustered: boolean;
  readonly replica_identity: boolean;
  readonly tablespace: string | null;
  readonly storage_parameters: string[] | null;
  readonly predicate: string | null;
  readonly expressions: string | null;
  readonly definition: string;
  readonly total_attributes: number;
  readonly key_attributes: number;
  readonly attribute_numbers: number[];
  readonly element_definitions: string[];
  readonly operator_classes: (string | null)[];
  readonly collations: (string | null)[];
  readonly options: number[];
  readonly parent_index_oid: number;
}

export interface PartitionCatalogRow extends PostgresRow {
  readonly table_oid: number;
  readonly strategy: string;
  readonly key_definition: string;
  readonly key_attribute_numbers: number[];
  readonly default_partition_oid: number;
}
