/**
 * Normalized structural objects required by future schema rendering.
 *
 * These models deliberately contain PostgreSQL identity and source metadata,
 * but no raw catalog rows. Dependency references are preliminary edges for the
 * later graph-planning phase; they do not imply final creation order yet.
 */

export type PostgresObjectKind =
  | 'database'
  | 'schema'
  | 'table'
  | 'column'
  | 'sequence'
  | 'enum'
  | 'domain'
  | 'constraint'
  | 'index'
  | 'view'
  | 'materialized-view'
  | 'function'
  | 'procedure'
  | 'aggregate'
  | 'trigger'
  | 'rule'
  | 'policy'
  | 'type';

export interface PostgresObjectReference {
  readonly kind: PostgresObjectKind;
  readonly oid: number;
  readonly schema?: string;
  readonly name: string;
  readonly subName?: string;
}

export interface PostgresStructuralObject {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly owner?: string;
  /** Reserved until comment introspection is implemented. */
  readonly comment?: string;
  readonly dependencies: readonly PostgresObjectReference[];
}

export type PostgresSequenceOwnership = 'standalone' | 'serial' | 'identity';

export interface PostgresSequence extends PostgresStructuralObject {
  readonly dataType: string;
  readonly startValue: string;
  readonly increment: string;
  readonly minimumValue: string;
  readonly maximumValue: string;
  readonly cacheSize: string;
  readonly cycle: boolean;
  readonly currentValue?: string;
  readonly isCalled?: boolean;
  readonly ownership: PostgresSequenceOwnership;
  readonly ownedBy?: PostgresObjectReference;
}

export interface PostgresEnumLabel {
  readonly oid: number;
  readonly label: string;
  readonly sortOrder: number;
}

export interface PostgresEnumType extends PostgresStructuralObject {
  readonly labels: readonly PostgresEnumLabel[];
}

export interface PostgresDomain extends PostgresStructuralObject {
  readonly baseTypeOid: number;
  readonly formattedBaseType: string;
  readonly nullable: boolean;
  readonly defaultExpression?: string;
  readonly collation?: string;
  readonly constraints: readonly PostgresCheckConstraint[];
}

export type PostgresConstraintKind = 'primary-key' | 'unique' | 'check' | 'foreign-key';

export interface PostgresConstraintBase extends PostgresStructuralObject {
  readonly kind: PostgresConstraintKind;
  readonly validated: boolean;
  readonly parentConstraintOid?: number;
}

export interface PostgresKeyConstraint extends PostgresConstraintBase {
  readonly kind: 'primary-key' | 'unique';
  readonly table: PostgresObjectReference;
  readonly columns: readonly PostgresObjectReference[];
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
  readonly backingIndexOid: number;
  readonly nullsNotDistinct: boolean;
}

export interface PostgresCheckConstraint extends PostgresConstraintBase {
  readonly kind: 'check';
  readonly table?: PostgresObjectReference;
  readonly domain?: PostgresObjectReference;
  readonly expression: string;
  readonly definition: string;
  readonly noInherit: boolean;
  readonly locallyDefined: boolean;
  readonly inheritanceCount: number;
}

export type PostgresForeignKeyMatch = 'simple' | 'full' | 'partial';
export type PostgresForeignKeyAction =
  'no-action' | 'restrict' | 'cascade' | 'set-null' | 'set-default';

export interface PostgresForeignKeyConstraint extends PostgresConstraintBase {
  readonly kind: 'foreign-key';
  readonly sourceTable: PostgresObjectReference;
  readonly targetTable: PostgresObjectReference;
  readonly sourceColumns: readonly PostgresObjectReference[];
  readonly targetColumns: readonly PostgresObjectReference[];
  readonly match: PostgresForeignKeyMatch;
  readonly onUpdate: PostgresForeignKeyAction;
  readonly onDelete: PostgresForeignKeyAction;
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
}

export type PostgresConstraint =
  PostgresKeyConstraint | PostgresCheckConstraint | PostgresForeignKeyConstraint;

export interface PostgresIndexElement {
  readonly position: number;
  readonly key: boolean;
  readonly attributeNumber?: number;
  readonly column?: PostgresObjectReference;
  readonly expression?: string;
  readonly operatorClass?: string;
  readonly collation?: string;
  readonly direction?: 'ascending' | 'descending';
  readonly nulls?: 'first' | 'last';
}

export interface PostgresIndex extends PostgresStructuralObject {
  readonly table: PostgresObjectReference;
  readonly accessMethod: string;
  readonly unique: boolean;
  readonly primary: boolean;
  readonly exclusion: boolean;
  readonly immediate: boolean;
  readonly nullsNotDistinct: boolean;
  readonly valid: boolean;
  readonly ready: boolean;
  readonly live: boolean;
  readonly exportable: boolean;
  readonly clustered: boolean;
  readonly replicaIdentity: boolean;
  readonly tablespace?: string;
  readonly storageParameters: readonly string[];
  readonly predicate?: string;
  readonly expressions?: string;
  readonly definition: string;
  readonly elements: readonly PostgresIndexElement[];
  readonly parentIndexOid?: number;
}

export type PostgresPartitionStrategy = 'range' | 'list' | 'hash';

export interface PostgresPartitionDefinition {
  readonly strategy: PostgresPartitionStrategy;
  readonly keyDefinition: string;
  readonly keyAttributeNumbers: readonly number[];
  readonly defaultPartitionOid?: number;
}

export interface PostgresPartitionBound {
  readonly expression: string;
  readonly default: boolean;
}
