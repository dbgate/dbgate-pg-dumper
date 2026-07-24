/**
 * Immutable metadata required to read one relation without further catalog
 * queries. Descriptors live in archive data entries and are format-neutral.
 */

import type {
  PostgresColumnTypeKind,
  PostgresIdentityMode,
  PostgresPersistence,
  PostgresTableKind,
} from '../model/PostgresDatabase.js';

export type DataExportMode = 'rows';
export type DataStreamingStrategy = 'auto' | 'adapter-cursor' | 'sql-cursor';
/**
 * Describes the representation requested from PostgreSQL before values cross
 * the driver boundary. Canonical text is the production dump path because it
 * delegates every type's formatting to PostgreSQL's own output function.
 */
export type DataValueReadStrategy = 'canonical-text';
export type DataExportFormatter =
  | 'boolean'
  | 'integer'
  | 'numeric'
  | 'text'
  | 'binary'
  | 'json'
  | 'array'
  | 'temporal'
  | 'network'
  | 'bit-string'
  | 'range'
  | 'composite'
  | 'other';

export interface ColumnExportDescriptor {
  readonly ordinalPosition: number;
  readonly attributeNumber: number;
  readonly name: string;
  readonly quotedName: string;
  readonly formattedType: string;
  readonly typeOid: number;
  readonly binaryCompatible: boolean;
  readonly nullable: boolean;
  readonly generated: boolean;
  readonly identity?: PostgresIdentityMode;
  readonly dropped: false;
  readonly formatter: DataExportFormatter;
  readonly typeCategory?: PostgresColumnTypeKind;
}

export interface PrimaryKeyExportDescriptor {
  readonly name: string;
  readonly columns: readonly string[];
}

export interface ReplicaIdentityExportDescriptor {
  readonly mode: 'default' | 'nothing' | 'full' | 'index';
  readonly indexName?: string;
  readonly columns: readonly string[];
}

export interface PartitionExportDescriptor {
  readonly kind: PostgresTableKind;
  readonly parent?: string;
  readonly bound?: string;
  readonly partitionKey?: string;
}

export interface TableDataExportDescriptor {
  readonly kind: 'table';
  readonly relationOid: number;
  readonly schema: string;
  readonly name: string;
  readonly estimatedRowCount: number;
  readonly persistence: PostgresPersistence;
  readonly primaryKey?: PrimaryKeyExportDescriptor;
  readonly replicaIdentity: ReplicaIdentityExportDescriptor;
  readonly partition: PartitionExportDescriptor;
  readonly identityColumns: readonly string[];
  readonly generatedColumns: readonly string[];
  readonly columns: readonly ColumnExportDescriptor[];
  readonly exportMode: DataExportMode;
  readonly streamingStrategy: DataStreamingStrategy;
  readonly valueReadStrategy: DataValueReadStrategy;
  readonly rowLevelSecurity: boolean;
  readonly forceRowLevelSecurity: boolean;
  readonly defaultDataPolicy: 'include' | 'omit-foreign';
}

export interface MaterializedViewDataExportDescriptor {
  readonly kind: 'materialized-view';
  readonly relationOid: number;
  readonly schema: string;
  readonly name: string;
  readonly populated: boolean;
}

export interface SequenceStateExportDescriptor {
  readonly kind: 'sequence-state';
  readonly relationOid: number;
  readonly schema?: string;
  readonly name: string;
  readonly currentValue?: string;
  readonly isCalled?: boolean;
}

/** Metadata for streaming pg_largeobject pages without materializing an LO. */
export interface LargeObjectDataExportDescriptor {
  readonly kind: 'large-object';
  readonly objectOid: number;
  readonly estimatedBytes?: number;
}

export type ArchiveDataExportDescriptor =
  | TableDataExportDescriptor
  | MaterializedViewDataExportDescriptor
  | SequenceStateExportDescriptor
  | LargeObjectDataExportDescriptor;
