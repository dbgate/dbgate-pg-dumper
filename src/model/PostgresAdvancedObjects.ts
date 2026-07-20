/**
 * Normalized contracts for advanced, cluster-scoped, and security-sensitive
 * PostgreSQL objects.
 *
 * Complex object families retain complete catalog metadata rather than
 * pre-rendered SQL where PostgreSQL has no canonical `pg_get_*def` function.
 */

import type { PostgresObjectReference } from './PostgresStructuralObjects.js';

export interface PostgresExtension {
  readonly oid: number;
  readonly name: string;
  readonly schema: string;
  readonly owner: string;
  readonly version: string;
  readonly relocatable: boolean;
  readonly configurationTableOids: readonly number[];
  readonly configurationConditions: readonly (string | null)[];
  readonly dependencies: readonly PostgresObjectReference[];
  readonly comment?: string;
}

export interface PostgresExtensionMember {
  readonly extensionName: string;
  readonly object: PostgresObjectReference;
}

export interface PostgresOption {
  readonly name: string;
  readonly value?: string;
  readonly sensitive: boolean;
}

export interface PostgresForeignDataWrapper {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly handler?: string;
  readonly validator?: string;
  readonly options: readonly PostgresOption[];
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresForeignServer {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly wrapperOid: number;
  readonly wrapperName: string;
  readonly type?: string;
  readonly version?: string;
  readonly options: readonly PostgresOption[];
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresUserMapping {
  readonly oid: number;
  readonly serverOid: number;
  readonly serverName: string;
  readonly userName: string;
  readonly options: readonly PostgresOption[];
  readonly containsSensitiveOptions: boolean;
}

export interface PostgresForeignTableDefinition {
  readonly tableOid: number;
  readonly serverOid: number;
  readonly serverName: string;
  readonly options: readonly PostgresOption[];
  readonly columnOptions: Readonly<Record<string, readonly PostgresOption[]>>;
}

export type PostgresTextSearchObjectKind = 'parser' | 'template' | 'dictionary' | 'configuration';

export interface PostgresTextSearchObject {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner?: string;
  readonly kind: PostgresTextSearchObjectKind;
  readonly parser?: string;
  readonly template?: string;
  readonly options: readonly string[];
  readonly mappings: readonly string[];
  readonly functions: Readonly<Record<string, string>>;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresCompositeTypeAttribute {
  readonly attributeNumber: number;
  readonly name: string;
  readonly formattedType: string;
  readonly collation?: string;
  readonly dropped: boolean;
}

export interface PostgresCompositeType {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly attributes: readonly PostgresCompositeTypeAttribute[];
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresRangeType {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly subtype: string;
  readonly subtypeOperatorClass: string;
  readonly collation?: string;
  readonly canonicalFunction?: string;
  readonly subtypeDifferenceFunction?: string;
  readonly multirangeTypeName?: string;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresBaseType {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly completeDefinition: boolean;
  readonly inputFunction?: string;
  readonly outputFunction?: string;
  readonly receiveFunction?: string;
  readonly sendFunction?: string;
  readonly typeModifierInputFunction?: string;
  readonly typeModifierOutputFunction?: string;
  readonly analyzeFunction?: string;
  readonly internalLength: number;
  readonly passedByValue: boolean;
  readonly alignment: string;
  readonly storage: string;
  readonly category: string;
  readonly preferred: boolean;
  readonly delimiter: string;
  readonly collatable: boolean;
  readonly defaultValue?: string;
  readonly elementType?: string;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresCast {
  readonly oid: number;
  readonly sourceType: string;
  readonly targetType: string;
  readonly function?: string;
  readonly context: 'implicit' | 'assignment' | 'explicit';
  readonly method: 'function' | 'binary' | 'inout';
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresTransform {
  readonly oid: number;
  readonly typeName: string;
  readonly languageName: string;
  readonly fromSqlFunction?: string;
  readonly toSqlFunction?: string;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresOperator {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly leftType?: string;
  readonly rightType?: string;
  readonly function: string;
  readonly commutator?: string;
  readonly negator?: string;
  readonly restrictFunction?: string;
  readonly joinFunction?: string;
  readonly hashes: boolean;
  readonly merges: boolean;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresOperatorFamily {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly accessMethod: string;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresOperatorClassItem {
  readonly kind: 'operator' | 'function';
  readonly strategyOrSupportNumber: number;
  readonly identity: string;
}

export interface PostgresOperatorClass {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly accessMethod: string;
  readonly familySchema: string;
  readonly familyName: string;
  readonly inputType: string;
  readonly storageType?: string;
  readonly isDefault: boolean;
  readonly items: readonly PostgresOperatorClassItem[];
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresConversion {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly sourceEncoding: string;
  readonly targetEncoding: string;
  readonly function: string;
  readonly isDefault: boolean;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresCollation {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly provider: 'libc' | 'icu' | 'builtin' | 'default' | 'unknown';
  readonly locale?: string;
  readonly lcCollate?: string;
  readonly lcCtype?: string;
  readonly icuLocale?: string;
  readonly icuRules?: string;
  readonly deterministic: boolean;
  readonly version?: string;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresEventTrigger {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly event: string;
  readonly tags: readonly string[];
  readonly function: string;
  readonly enabled: 'origin' | 'disabled' | 'replica' | 'always';
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresProceduralLanguage {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly trusted: boolean;
  readonly handler?: string;
  readonly inlineHandler?: string;
  readonly validator?: string;
  readonly systemProvided: boolean;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresPublicationTable {
  readonly table: PostgresObjectReference;
  readonly columns: readonly string[];
  readonly rowFilter?: string;
}

export interface PostgresPublication {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly allTables: boolean;
  readonly publishInsert: boolean;
  readonly publishUpdate: boolean;
  readonly publishDelete: boolean;
  readonly publishTruncate: boolean;
  readonly publishViaPartitionRoot: boolean;
  readonly tables: readonly PostgresPublicationTable[];
  readonly schemas: readonly string[];
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresSubscription {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly enabled: boolean;
  readonly publications: readonly string[];
  readonly slotName?: string;
  readonly synchronousCommit: string;
  readonly binary: boolean;
  readonly streaming: string;
  readonly twoPhase: string;
  readonly failover: boolean;
  readonly connectionInfoPresent: boolean;
}

export interface PostgresTablespace {
  readonly oid: number;
  readonly name: string;
  readonly owner: string;
  readonly location: string;
  readonly options: readonly string[];
}

export interface PostgresRole {
  readonly oid: number;
  readonly name: string;
  readonly superuser: boolean;
  readonly inherit: boolean;
  readonly createRole: boolean;
  readonly createDatabase: boolean;
  readonly canLogin: boolean;
  readonly replication: boolean;
  readonly bypassRowLevelSecurity: boolean;
  readonly connectionLimit: number;
  readonly validUntil?: string;
  readonly configuration: readonly string[];
}

export interface PostgresRoleMembership {
  readonly role: string;
  readonly member: string;
  readonly grantor: string;
  readonly adminOption: boolean;
}

export interface PostgresSecurityLabel {
  readonly provider: string;
  readonly object: PostgresObjectReference;
  readonly label: string;
}

export interface PostgresStatisticsObject {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner: string;
  readonly table: PostgresObjectReference;
  readonly definition: string;
  readonly kinds: readonly string[];
  readonly target?: number;
  readonly dependencies: readonly PostgresObjectReference[];
}

export interface PostgresLargeObject {
  readonly oid: number;
  readonly owner: string;
  readonly acl: readonly string[];
  readonly comment?: string;
  readonly estimatedBytes?: number;
}
