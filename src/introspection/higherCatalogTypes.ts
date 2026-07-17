/**
 * Raw row contracts for higher-level PostgreSQL catalog queries.
 *
 * Version-specific SQL aliases optional fields to stable shapes. The assembler
 * is therefore independent of catalog-column availability and never receives
 * driver-specific objects.
 */

import type { PostgresRow } from '../connection/PostgresConnection.js';

export interface RoleCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly role_name: string;
}

export interface ViewCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly schema_name: string;
  readonly view_name: string;
  readonly relation_kind: string;
  readonly owner_oid: number;
  readonly owner: string;
  readonly definition: string;
  readonly persistence: string;
  readonly tablespace: string | null;
  readonly access_method: string | null;
  readonly storage_parameters: string[] | null;
  readonly populated: boolean;
}

export interface ViewColumnCatalogRow extends PostgresRow {
  readonly relation_oid: number;
  readonly attribute_number: number;
  readonly column_name: string;
  readonly formatted_type: string;
  readonly type_oid: number;
}

export interface MaterializedViewIndexCatalogRow extends PostgresRow {
  readonly view_oid: number;
  readonly index_oid: number;
  readonly schema_name: string;
  readonly index_name: string;
  readonly definition: string;
  readonly valid: boolean;
  readonly ready: boolean;
}

export interface RoutineCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly schema_name: string;
  readonly routine_name: string;
  readonly owner_oid: number;
  readonly owner: string;
  readonly routine_kind: string;
  readonly identity_arguments: string;
  readonly arguments: string;
  readonly result: string;
  readonly language: string;
  readonly source: string;
  readonly definition: string;
  readonly volatility: string;
  readonly strict: boolean;
  readonly security_definer: boolean;
  readonly leakproof: boolean;
  readonly parallel_safety: string;
  readonly estimated_cost: number;
  readonly estimated_rows: number;
  readonly configuration: string[] | null;
  readonly argument_type_oids: number[];
  readonly result_type_oid: number;
  readonly support_function_oid: number;
  readonly support_function_schema: string | null;
  readonly support_function_name: string | null;
  readonly support_function_identity_arguments: string | null;
  readonly transform_type_oids: number[];
}

export interface AggregateCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly schema_name: string;
  readonly aggregate_name: string;
  readonly owner_oid: number;
  readonly owner: string;
  readonly identity_arguments: string;
  readonly arguments: string;
  readonly aggregate_kind: string;
  readonly parallel_safety: string;
  readonly transition_function_oid: number;
  readonly transition_function_name: string | null;
  readonly state_type_oid: number;
  readonly state_type_name: string;
  readonly final_function_oid: number;
  readonly final_function_name: string | null;
  readonly combine_function_oid: number;
  readonly combine_function_name: string | null;
  readonly serialization_function_oid: number;
  readonly serialization_function_name: string | null;
  readonly deserialization_function_oid: number;
  readonly deserialization_function_name: string | null;
  readonly moving_transition_function_oid: number;
  readonly moving_transition_function_name: string | null;
  readonly moving_inverse_function_oid: number;
  readonly moving_inverse_function_name: string | null;
  readonly moving_final_function_oid: number;
  readonly moving_final_function_name: string | null;
  readonly moving_state_type_oid: number;
  readonly moving_state_type_name: string | null;
  readonly initial_condition: string | null;
  readonly moving_initial_condition: string | null;
  readonly sort_operator: string | null;
  readonly transition_space: number;
  readonly moving_transition_space: number;
  readonly direct_argument_count: number;
}

export interface TriggerCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly trigger_name: string;
  readonly table_oid: number;
  readonly table_schema: string;
  readonly table_name: string;
  readonly function_oid: number;
  readonly function_schema: string | null;
  readonly function_name: string | null;
  readonly function_identity_arguments: string | null;
  readonly definition: string;
  readonly enabled: string;
  readonly trigger_type: number;
  readonly when_expression: string | null;
  readonly constraint_oid: number;
  readonly deferrable: boolean;
  readonly initially_deferred: boolean;
  readonly referenced_relation_oid: number;
  readonly referenced_relation_schema: string | null;
  readonly referenced_relation_name: string | null;
  readonly old_transition_table: string | null;
  readonly new_transition_table: string | null;
  readonly parent_trigger_oid: number;
  readonly internal: boolean;
}

export interface RuleCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly rule_name: string;
  readonly relation_oid: number;
  readonly relation_schema: string;
  readonly relation_name: string;
  readonly definition: string;
  readonly enabled: string;
  readonly event_type: string;
  readonly instead: boolean;
}

export interface PolicyCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly policy_name: string;
  readonly table_oid: number;
  readonly table_schema: string;
  readonly table_name: string;
  readonly command: string;
  readonly permissive: boolean;
  readonly roles: string[];
  readonly using_expression: string | null;
  readonly check_expression: string | null;
}

export interface CommentCatalogRow extends PostgresRow {
  readonly catalog_kind: string;
  readonly object_oid: number;
  readonly object_sub_id: number;
  readonly description: string;
}

export interface AclCatalogRow extends PostgresRow {
  readonly object_kind: string;
  readonly object_oid: number;
  readonly grantor: string | null;
  readonly grantee: string | null;
  readonly privilege_type: string | null;
  readonly grantable: boolean | null;
  readonly raw_acl: string[] | null;
}

export interface DefaultPrivilegeCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly owner_oid: number;
  readonly owner: string;
  readonly schema_name: string | null;
  readonly object_type: string;
  readonly grantor: string | null;
  readonly grantee: string | null;
  readonly privilege_type: string | null;
  readonly grantable: boolean | null;
  readonly raw_acl: string[] | null;
}

export interface DependencyCatalogRow extends PostgresRow {
  readonly source_kind: string;
  readonly source_oid: number;
  readonly referenced_class: string;
  readonly referenced_oid: number;
  readonly referenced_sub_id: number;
  readonly referenced_schema: string | null;
  readonly referenced_name: string | null;
  readonly referenced_identity_arguments: string | null;
  readonly referenced_relation_kind: string | null;
  readonly dependency_type: string;
}
