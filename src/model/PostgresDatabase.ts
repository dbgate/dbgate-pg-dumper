/**
 * Independent PostgreSQL database, schema, table, and column model.
 *
 * These values are normalized from `pg_catalog` and contain no DbGate or driver
 * types. The model captures structural properties needed by future DDL
 * renderers. Higher-level objects and security metadata are normalized into
 * separate collections while data export remains a later phase.
 */

import type {
  PostgresConstraint,
  PostgresDomain,
  PostgresEnumType,
  PostgresIndex,
  PostgresObjectReference,
  PostgresPartitionBound,
  PostgresPartitionDefinition,
  PostgresSequence,
} from './PostgresStructuralObjects.js';
import type {
  PostgresAccessControlEntry,
  PostgresAggregate,
  PostgresComment,
  PostgresDefaultPrivilege,
  PostgresFunction,
  PostgresMaterializedView,
  PostgresOwnership,
  PostgresPolicy,
  PostgresProcedure,
  PostgresRule,
  PostgresTrigger,
  PostgresView,
} from './PostgresHigherLevelObjects.js';
import type {
  PostgresBaseType,
  PostgresCast,
  PostgresCollation,
  PostgresCompositeType,
  PostgresConversion,
  PostgresEventTrigger,
  PostgresExtension,
  PostgresExtensionMember,
  PostgresForeignDataWrapper,
  PostgresForeignServer,
  PostgresForeignTableDefinition,
  PostgresLargeObject,
  PostgresOperator,
  PostgresOperatorClass,
  PostgresOperatorFamily,
  PostgresProceduralLanguage,
  PostgresPublication,
  PostgresRangeType,
  PostgresRole,
  PostgresRoleMembership,
  PostgresSecurityLabel,
  PostgresStatisticsObject,
  PostgresSubscription,
  PostgresTablespace,
  PostgresTextSearchObject,
  PostgresTransform,
  PostgresUserMapping,
} from './PostgresAdvancedObjects.js';

export interface PostgresDatabase {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly encoding: string;
  readonly collation: string;
  readonly characterType: string;
  readonly localeProvider?: string;
  readonly icuLocale?: string;
  readonly tablespace?: string;
  readonly connectionLimit?: number;
  readonly allowConnections?: boolean;
  readonly template?: boolean;
  readonly configuration?: readonly string[];
  readonly schemas: readonly PostgresSchema[];
  readonly constraints: readonly PostgresConstraint[];
  readonly indexes: readonly PostgresIndex[];
  readonly views: readonly PostgresView[];
  readonly materializedViews: readonly PostgresMaterializedView[];
  readonly functions: readonly PostgresFunction[];
  readonly procedures: readonly PostgresProcedure[];
  readonly aggregates: readonly PostgresAggregate[];
  readonly triggers: readonly PostgresTrigger[];
  readonly rules: readonly PostgresRule[];
  readonly policies: readonly PostgresPolicy[];
  readonly comments: readonly PostgresComment[];
  readonly ownerships: readonly PostgresOwnership[];
  readonly accessControls: readonly PostgresAccessControlEntry[];
  readonly defaultPrivileges: readonly PostgresDefaultPrivilege[];
  readonly extensions?: readonly PostgresExtension[];
  readonly extensionMembers?: readonly PostgresExtensionMember[];
  readonly foreignDataWrappers?: readonly PostgresForeignDataWrapper[];
  readonly foreignServers?: readonly PostgresForeignServer[];
  readonly userMappings?: readonly PostgresUserMapping[];
  readonly foreignTables?: readonly PostgresForeignTableDefinition[];
  readonly textSearchObjects?: readonly PostgresTextSearchObject[];
  readonly compositeTypes?: readonly PostgresCompositeType[];
  readonly rangeTypes?: readonly PostgresRangeType[];
  readonly baseTypes?: readonly PostgresBaseType[];
  readonly casts?: readonly PostgresCast[];
  readonly transforms?: readonly PostgresTransform[];
  readonly operators?: readonly PostgresOperator[];
  readonly operatorFamilies?: readonly PostgresOperatorFamily[];
  readonly operatorClasses?: readonly PostgresOperatorClass[];
  readonly conversions?: readonly PostgresConversion[];
  readonly collations?: readonly PostgresCollation[];
  readonly eventTriggers?: readonly PostgresEventTrigger[];
  readonly proceduralLanguages?: readonly PostgresProceduralLanguage[];
  readonly publications?: readonly PostgresPublication[];
  readonly subscriptions?: readonly PostgresSubscription[];
  readonly tablespaces?: readonly PostgresTablespace[];
  readonly roles?: readonly PostgresRole[];
  readonly roleMemberships?: readonly PostgresRoleMembership[];
  readonly securityLabels?: readonly PostgresSecurityLabel[];
  readonly statistics?: readonly PostgresStatisticsObject[];
  readonly largeObjects?: readonly PostgresLargeObject[];
  readonly replicationOriginCount?: number;
}

export interface PostgresSchema {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly tables: readonly PostgresTable[];
  readonly sequences: readonly PostgresSequence[];
  readonly enumTypes: readonly PostgresEnumType[];
  readonly domains: readonly PostgresDomain[];
}

export type PostgresTableKind = 'ordinary' | 'partitioned' | 'partition' | 'foreign';
export type PostgresPersistence = 'permanent' | 'unlogged' | 'temporary';
export type PostgresIdentityMode = 'always' | 'by-default';
export type PostgresStorageMode = 'plain' | 'external' | 'extended' | 'main';
export type PostgresReplicaIdentity = 'default' | 'nothing' | 'full' | 'index';
export type PostgresColumnTypeKind =
  'base' | 'composite' | 'domain' | 'enum' | 'pseudo' | 'range' | 'multirange' | 'unknown';

export interface PostgresTableReference {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
}

export interface PostgresTable {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly kind: PostgresTableKind;
  readonly persistence: PostgresPersistence;
  readonly owner: string;
  /** Reserved until comment introspection is implemented. */
  readonly comment?: string;
  readonly dependencies: readonly PostgresObjectReference[];
  readonly tablespace?: string;
  readonly accessMethod?: string;
  readonly rowLevelSecurity: boolean;
  readonly forceRowLevelSecurity: boolean;
  /** Approximate planner statistic from `pg_class.reltuples`. */
  readonly estimatedRowCount: number;
  readonly replicaIdentity: PostgresReplicaIdentity;
  readonly partitionBound?: string;
  readonly partition?: PostgresPartitionDefinition;
  readonly bound?: PostgresPartitionBound;
  readonly parents: readonly PostgresTableReference[];
  readonly children: readonly PostgresTableReference[];
  readonly columns: readonly PostgresColumn[];
}

export interface PostgresColumn {
  readonly tableOid: number;
  readonly attributeNumber: number;
  readonly ordinalPosition: number;
  readonly name: string;
  readonly formattedType: string;
  readonly typeOid: number;
  readonly typeModifier: number;
  readonly typeKind?: PostgresColumnTypeKind;
  readonly nullable: boolean;
  readonly defaultExpression?: string;
  readonly identity?: PostgresIdentityMode;
  readonly generatedExpression?: string;
  readonly collation?: string;
  readonly compression?: string;
  readonly storage: PostgresStorageMode;
  readonly typeDependency?: PostgresObjectReference;
}
