/**
 * SQL-format-independent dump archive contracts.
 *
 * Archive entries are immutable planning records. They identify what a future
 * renderer or data exporter should do, but deliberately contain no pre-rendered
 * SQL and no mutable graph implementation details.
 */

import type { PostgresObjectReference } from '../model/PostgresStructuralObjects.js';
import type { ArchiveDataExportDescriptor } from '../data/DataExportDescriptor.js';
export type { ArchiveDataExportDescriptor } from '../data/DataExportDescriptor.js';

export type DumpSection = 'pre-data' | 'data' | 'post-data';

export type ArchiveObjectType =
  | 'database'
  | 'extension'
  | 'schema'
  | 'enum'
  | 'domain'
  | 'table'
  | 'column'
  | 'sequence'
  | 'sequence-ownership'
  | 'sequence-state'
  | 'constraint'
  | 'foreign-key'
  | 'index'
  | 'view'
  | 'materialized-view'
  | 'table-data'
  | 'materialized-view-data'
  | 'function'
  | 'procedure'
  | 'aggregate'
  | 'trigger'
  | 'rule'
  | 'policy'
  | 'comment'
  | 'ownership'
  | 'acl'
  | 'default-privilege'
  | 'large-object'
  | 'large-object-data'
  | 'large-object-metadata'
  | 'foreign-data-wrapper'
  | 'foreign-server'
  | 'user-mapping'
  | 'text-search-parser'
  | 'text-search-template'
  | 'text-search-dictionary'
  | 'text-search-configuration'
  | 'composite-type'
  | 'range-type'
  | 'base-type'
  | 'cast'
  | 'transform'
  | 'operator'
  | 'operator-family'
  | 'operator-class'
  | 'conversion'
  | 'collation'
  | 'event-trigger'
  | 'procedural-language'
  | 'publication'
  | 'subscription'
  | 'tablespace'
  | 'role'
  | 'role-membership'
  | 'security-label'
  | 'statistics';

export type ArchiveDependencyStrength = 'hard' | 'preference';

export type ArchiveDependencySource =
  | 'catalog'
  | 'schema-membership'
  | 'parent-object'
  | 'type-reference'
  | 'sequence-ownership'
  | 'partition-parent'
  | 'table-object'
  | 'routine-reference'
  | 'metadata-target'
  | 'data-owner'
  | 'restore-safety'
  | 'extension-membership';

export interface ArchiveDependency {
  readonly dumpId: string;
  readonly strength: ArchiveDependencyStrength;
  readonly source: ArchiveDependencySource;
}

export type ArchiveSelectionReason =
  | 'explicit'
  | 'dependency'
  | 'section-excluded'
  | 'mode-excluded'
  | 'filter-excluded'
  | 'extension-member-excluded';

export interface ArchiveSelectionState {
  readonly selected: boolean;
  readonly reason: ArchiveSelectionReason;
  readonly requiredByDumpIds: readonly string[];
}

export type ArchiveDiagnosticSeverity = 'warning' | 'error';

export type ArchiveDiagnosticCode =
  | 'unresolved-dependency'
  | 'duplicate-archive-identity'
  | 'dump-id-collision'
  | 'invalid-section-dependency'
  | 'dependency-cycle'
  | 'dropped-ordering-preference'
  | 'automatically-included-dependency'
  | 'strict-selection-dependency'
  | 'excluded-extension-member'
  | 'orphaned-metadata'
  | 'selected-data-without-definition'
  | 'materialized-view-data-without-definition'
  | 'sequence-state-without-definition';

export interface ArchiveCycleMember {
  readonly dumpId: string;
  readonly identity: string;
  readonly objectType: ArchiveObjectType;
}

export interface ArchiveCycleEdge {
  readonly fromDumpId: string;
  readonly toDumpId: string;
  readonly strength: ArchiveDependencyStrength;
  readonly source: ArchiveDependencySource;
}

export interface ArchiveDiagnostic {
  readonly code: ArchiveDiagnosticCode;
  readonly severity: ArchiveDiagnosticSeverity;
  readonly message: string;
  readonly dumpId?: string;
  readonly relatedDumpIds?: readonly string[];
  readonly identity?: string;
  readonly cycleMembers?: readonly ArchiveCycleMember[];
  readonly cycleEdges?: readonly ArchiveCycleEdge[];
}

export interface ArchiveExtensionMembership {
  readonly extensionDumpId: string;
  readonly emitIndependently: boolean;
}

export interface ArchiveEntry {
  readonly dumpId: string;
  readonly archiveIdentity: string;
  readonly catalogOid?: number;
  readonly objectType: ArchiveObjectType;
  readonly schema?: string;
  readonly name: string;
  readonly specificIdentity: string;
  readonly parent?: PostgresObjectReference;
  readonly owner?: string;
  readonly section: DumpSection;
  readonly dependencyDumpIds: readonly string[];
  readonly dependencies: readonly ArchiveDependency[];
  readonly selection: ArchiveSelectionState;
  readonly createMetadata?: Readonly<Record<string, unknown>>;
  readonly dropMetadata?: Readonly<Record<string, unknown>>;
  readonly commentMetadata?: Readonly<Record<string, unknown>>;
  readonly aclMetadata?: Readonly<Record<string, unknown>>;
  readonly dataExport?: ArchiveDataExportDescriptor;
  readonly extensionMembership?: ArchiveExtensionMembership;
  readonly sourceObject: unknown;
  readonly diagnostics: readonly ArchiveDiagnostic[];
}

export interface DumpArchiveInspection {
  readonly valid: boolean;
  readonly entries: readonly ArchiveEntry[];
  readonly orderedEntries: readonly ArchiveEntry[];
  readonly orderedDumpIds: readonly string[];
  readonly diagnostics: readonly ArchiveDiagnostic[];
}

export interface ArchiveExtension {
  readonly oid?: number;
  readonly name: string;
  readonly schema?: string;
  readonly owner?: string;
  readonly version?: string;
  readonly relocatable?: boolean;
  readonly configurationTableOids?: readonly number[];
  readonly configurationConditions?: readonly (string | null)[];
}

export interface ArchiveExtensionMember {
  readonly extensionName: string;
  readonly object: PostgresObjectReference;
}

export interface ArchiveBuildOptions {
  readonly extensions?: readonly ArchiveExtension[];
  readonly extensionMembers?: readonly ArchiveExtensionMember[];
  readonly expandExtensionMembers?: boolean;
  readonly includeLargeObjects?: boolean;
  readonly includeUserMappings?: boolean;
  readonly includeEventTriggers?: boolean;
  readonly includeSubscriptions?: boolean;
  readonly includeRoles?: boolean;
  readonly includeSecurityLabels?: boolean;
}

export type ArchiveDumpMode = 'full' | 'schema-only' | 'data-only';

export interface ArchiveSelectionOptions {
  readonly mode?: ArchiveDumpMode;
  readonly sections?: readonly DumpSection[];
  readonly includeSchemas?: readonly string[];
  readonly excludeSchemas?: readonly string[];
  readonly includeTables?: readonly string[];
  readonly excludeTables?: readonly string[];
  readonly includeTableChildren?: boolean;
  readonly excludeTableChildren?: boolean;
  readonly includeDependencies?: boolean;
  readonly strictSelection?: boolean;
}

export interface InspectDumpArchiveOptions extends ArchiveBuildOptions {
  readonly selection?: ArchiveSelectionOptions;
}
