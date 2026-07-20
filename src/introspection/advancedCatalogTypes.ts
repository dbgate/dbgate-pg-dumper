/** Stable raw row contracts for advanced PostgreSQL catalogs. */

import type { PostgresRow } from '../connection/PostgresConnection.js';

export interface ExtensionCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly extension_name: string;
  readonly schema_name: string;
  readonly owner: string;
  readonly version: string;
  readonly relocatable: boolean;
  readonly configuration_table_oids: number[] | null;
  readonly configuration_conditions: (string | null)[] | null;
  readonly comment: string | null;
}

export interface ExtensionMemberCatalogRow extends PostgresRow {
  readonly extension_name: string;
  readonly referenced_class: string;
  readonly object_oid: number;
  readonly object_sub_id: number;
  readonly schema_name: string | null;
  readonly object_name: string | null;
  readonly identity_arguments: string | null;
  readonly relation_kind: string | null;
}

export interface ForeignDataWrapperCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly wrapper_name: string;
  readonly owner: string;
  readonly handler: string | null;
  readonly validator: string | null;
  readonly options: string[] | null;
}

export interface ForeignServerCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly server_name: string;
  readonly owner: string;
  readonly wrapper_oid: number;
  readonly wrapper_name: string;
  readonly server_type: string | null;
  readonly server_version: string | null;
  readonly options: string[] | null;
}

export interface UserMappingCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly server_oid: number;
  readonly server_name: string;
  readonly user_name: string;
  readonly options: string[] | null;
}

export interface ForeignTableCatalogRow extends PostgresRow {
  readonly table_oid: number;
  readonly server_oid: number;
  readonly server_name: string;
  readonly options: string[] | null;
  readonly column_name: string | null;
  readonly column_options: string[] | null;
}

export interface EventTriggerCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly trigger_name: string;
  readonly owner: string;
  readonly event: string;
  readonly tags: string[] | null;
  readonly function_oid: number;
  readonly function_name: string;
  readonly enabled: string;
}

export interface LanguageCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly language_name: string;
  readonly owner: string;
  readonly trusted: boolean;
  readonly handler: string | null;
  readonly inline_handler: string | null;
  readonly validator: string | null;
  readonly system_provided: boolean;
}

export interface PublicationCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly publication_name: string;
  readonly owner: string;
  readonly all_tables: boolean;
  readonly publish_insert: boolean;
  readonly publish_update: boolean;
  readonly publish_delete: boolean;
  readonly publish_truncate: boolean;
  readonly publish_via_partition_root: boolean;
}

export interface PublicationTableCatalogRow extends PostgresRow {
  readonly publication_oid: number;
  readonly table_oid: number;
  readonly table_schema: string;
  readonly table_name: string;
  readonly columns: string[] | null;
  readonly row_filter: string | null;
}

export interface PublicationSchemaCatalogRow extends PostgresRow {
  readonly publication_oid: number;
  readonly schema_name: string;
}

export interface SubscriptionCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly subscription_name: string;
  readonly owner: string;
  readonly enabled: boolean;
  readonly publications: string[];
  readonly slot_name: string | null;
  readonly synchronous_commit: string;
  readonly binary_mode: boolean;
  readonly streaming_mode: string;
  readonly two_phase_mode: string;
  readonly failover: boolean;
  readonly connection_info_present: boolean;
}

export interface TablespaceCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly tablespace_name: string;
  readonly owner: string;
  readonly location: string;
  readonly options: string[] | null;
}

export interface AdvancedRoleCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly role_name: string;
  readonly superuser: boolean;
  readonly inherit: boolean;
  readonly create_role: boolean;
  readonly create_database: boolean;
  readonly can_login: boolean;
  readonly replication: boolean;
  readonly bypass_rls: boolean;
  readonly connection_limit: number;
  readonly valid_until: string | null;
  readonly configuration: string[] | null;
}

export interface RoleMembershipCatalogRow extends PostgresRow {
  readonly role_name: string;
  readonly member_name: string;
  readonly grantor_name: string;
  readonly admin_option: boolean;
}

export interface StatisticsCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly schema_name: string;
  readonly statistics_name: string;
  readonly owner: string;
  readonly table_oid: number;
  readonly table_schema: string;
  readonly table_name: string;
  readonly definition: string;
  readonly kinds: string[];
  readonly target: number | null;
}

export interface LargeObjectCatalogRow extends PostgresRow {
  readonly oid: number;
  readonly owner: string;
  readonly acl: string[] | null;
  readonly comment: string | null;
  readonly estimated_bytes: string | number | null;
}

export interface GenericAdvancedObjectCatalogRow extends PostgresRow {
  readonly object_kind: string;
  readonly oid: number;
  readonly schema_name: string | null;
  readonly object_name: string;
  readonly owner: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | string;
}
