import { dumpSectionPriority } from '../archive/SectionRules.js';
import type {
  RestoreArchiveEntry,
  RestoreArchiveMetadata,
  RestoreDataOperation,
  RestoreTargetVersionConstraint,
} from './RestoreArchive.js';
import {
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  RESTORE_ARCHIVE_FORMAT,
  RESTORE_ARCHIVE_FORMAT_VERSION,
} from './RestoreArchive.js';
import type { RestoreTargetSnapshot } from './RestoreTarget.js';
import { restorePhaseForEntry, restorePhasePriority } from './RestorePlan.js';
import { resolveRestoreRole } from './RestoreFinalization.js';
import {
  mapRestoreArchiveEntry,
  resolveRestoreSchema,
  resolveRestoreTablespace,
  restoreTargetIdentity,
  type ResolvedRestoreSchema,
  type ResolvedRestoreTablespace,
} from './RestoreMapping.js';
import {
  detectExternalDependencyBlocks,
  detectRestoreConflicts,
  type RestoreDestructiveImpactReport,
  type RestoreExistingObjectConflict,
} from './RestoreConflicts.js';
import { conflictSupportsSafeReplacement } from './RestoreClean.js';
import type {
  RestoreDiagnostic,
  RestoreMappingResult,
  RestoreOptions,
  RestorePhase,
} from './RestoreTypes.js';
import { validateSequenceState } from './SequenceStateRestore.js';

const EXECUTABLE_SQL_OBJECT_TYPES = new Set<RestoreArchiveEntry['objectType']>([
  'extension',
  'schema',
  'enum',
  'domain',
  'sequence',
  'sequence-ownership',
  'table',
  'column',
  'function',
  'procedure',
  'aggregate',
  'view',
  'materialized-view',
  'constraint',
  'foreign-key',
  'index',
  'trigger',
  'rule',
  'policy',
  'event-trigger',
  'ownership',
  'comment',
  'acl',
  'default-privilege',
]);

export interface RestorePreflightSummary {
  readonly archiveEntryCount: number;
  readonly executableEntryCount: number;
  readonly skippedEntryCount: number;
  readonly estimatedRows?: number;
  readonly estimatedDataBytes?: number;
  readonly preservedRoleCount: number;
  readonly mappedRoleCount: number;
  readonly currentUserRoleCount: number;
  readonly omittedRoleCount: number;
  readonly unresolvedRoleCount: number;
  readonly conflictsDetectedCount: number;
  readonly externalDependencyBlockCount: number;
  readonly schemasRemappedCount: number;
  readonly tablespacesRemappedCount: number;
}

export interface RestorePreflightReport {
  readonly archiveMetadata: RestoreArchiveMetadata;
  readonly target: RestoreTargetSnapshot;
  readonly diagnostics: readonly RestoreDiagnostic[];
  readonly roleMappings: readonly RestoreMappingResult[];
  readonly schemaMappings: readonly RestoreMappingResult[];
  readonly tablespaceMappings: readonly RestoreMappingResult[];
  readonly resolvedSchemas: readonly ResolvedRestoreSchema[];
  readonly resolvedTablespaces: readonly ResolvedRestoreTablespace[];
  readonly conflicts: readonly RestoreExistingObjectConflict[];
  readonly destructiveImpact: RestoreDestructiveImpactReport;
  readonly summary: RestorePreflightSummary;
  readonly canProceed: boolean;
}

function diagnostic(
  code: RestoreDiagnostic['code'],
  severity: RestoreDiagnostic['severity'],
  phase: RestorePhase,
  message: string,
  entry?: RestoreArchiveEntry,
  remediation?: string,
): RestoreDiagnostic {
  return {
    code,
    severity,
    phase,
    message,
    ...(entry === undefined ? {} : { archiveEntryId: entry.entryId }),
    ...(entry?.objectIdentity === undefined ? {} : { objectIdentity: entry.objectIdentity }),
    ...(remediation === undefined ? {} : { remediation }),
  };
}

function versionAllowed(
  versionNumber: number,
  constraint: RestoreTargetVersionConstraint | undefined,
): boolean {
  if (constraint?.minimum !== undefined && versionNumber < constraint.minimum) return false;
  if (constraint?.maximumExclusive !== undefined && versionNumber >= constraint.maximumExclusive) {
    return false;
  }
  return true;
}

function entrySkipped(entry: RestoreArchiveEntry, options: RestoreOptions): boolean {
  return (
    (entry.objectType === 'comment' &&
      (options.commentsMode === 'skip' || options.commentsMode === 'omit')) ||
    (entry.objectType === 'ownership' &&
      (options.ownershipMode === 'skip' || options.ownershipMode === 'omit')) ||
    ((entry.objectType === 'acl' || entry.objectType === 'default-privilege') &&
      (options.privilegesMode === 'skip' || options.privilegesMode === 'omit')) ||
    (entry.operation.kind === 'table-data' &&
      entry.operation.tableKind === 'foreign' &&
      entry.operation.foreignTableDataRequired !== true &&
      options.foreignTableDataMode === 'skip')
  );
}

function canonicalCopyFormat(operation: RestoreDataOperation): boolean {
  const format = operation.copyText;
  return (
    format !== undefined &&
    format.encoding === CANONICAL_RESTORE_COPY_TEXT_FORMAT.encoding &&
    format.delimiter === CANONICAL_RESTORE_COPY_TEXT_FORMAT.delimiter &&
    format.nullMarker === CANONICAL_RESTORE_COPY_TEXT_FORMAT.nullMarker &&
    format.escapeBehavior === CANONICAL_RESTORE_COPY_TEXT_FORMAT.escapeBehavior &&
    format.lineEnding === CANONICAL_RESTORE_COPY_TEXT_FORMAT.lineEnding &&
    format.finalNewline === CANONICAL_RESTORE_COPY_TEXT_FORMAT.finalNewline &&
    format.onePhysicalLinePerRow === true &&
    (format.endMarker === 'absent' || format.endMarker === 'psql')
  );
}

function archiveSchemas(entries: readonly RestoreArchiveEntry[]): readonly string[] {
  const schemas = new Set<string>();
  for (const entry of entries) {
    const operation = entry.operation;
    if (operation.kind === 'table-data') schemas.add(operation.table.schema);
    else if (operation.kind === 'sequence-state') {
      schemas.add(operation.schema);
      if (operation.ownedBy !== undefined) schemas.add(operation.ownedBy.schema);
    } else if (
      operation.kind === 'ownership' ||
      operation.kind === 'comment' ||
      operation.kind === 'acl'
    ) {
      if (operation.target.kind === 'schema') schemas.add(operation.target.name);
      if (operation.target.schema !== undefined) schemas.add(operation.target.schema);
      if (operation.target.parent?.schema !== undefined)
        schemas.add(operation.target.parent.schema);
    } else if (operation.kind === 'default-privilege') {
      if (operation.schema !== undefined) schemas.add(operation.schema);
    } else {
      if (operation.target?.kind === 'schema') schemas.add(operation.target.name);
      if (operation.target?.schema !== undefined) schemas.add(operation.target.schema);
      for (const reference of operation.opaqueSchemaReferences ?? []) schemas.add(reference.schema);
      for (const fragment of operation.structuredFragments ?? []) {
        if (fragment.kind === 'identifier' && fragment.schemaPart !== undefined) {
          const schema = fragment.parts[fragment.schemaPart];
          if (schema !== undefined) schemas.add(schema);
        }
      }
    }
  }
  return [...schemas].sort();
}

function archiveTablespaces(
  metadata: RestoreArchiveMetadata,
  entries: readonly RestoreArchiveEntry[],
): readonly string[] {
  const values = new Set(metadata.requiredTablespaces);
  for (const entry of entries) {
    if (entry.operation.kind !== 'sql') continue;
    if (entry.operation.tablespace !== undefined) values.add(entry.operation.tablespace);
    for (const fragment of entry.operation.structuredFragments ?? []) {
      if (fragment.kind === 'tablespace' || fragment.kind === 'tablespace-clause') {
        values.add(fragment.name);
      }
    }
  }
  return [...values].sort();
}

export class RestorePreflightAnalyzer {
  analyze(
    metadata: RestoreArchiveMetadata,
    entries: readonly RestoreArchiveEntry[],
    target: RestoreTargetSnapshot,
    options: RestoreOptions,
  ): RestorePreflightReport {
    const diagnostics: RestoreDiagnostic[] = [];
    const ids = new Map<string, RestoreArchiveEntry>();
    const identities = new Set<string>();
    const partitionDataSets = new Map<string, Set<RestoreDataOperation['partitionBehavior']>>();
    const directIndexIdentities = new Set<string>();
    const constraintIndexIdentities = new Set<string>();
    const mappingContext = {
      options,
      availableSchemas: new Set(target.schemas),
      availableTablespaces: new Set(target.tablespaces),
      protectedSchemas: new Set(target.extensionSchemas ?? []),
    };
    const resolvedSchemas = archiveSchemas(entries).map((schema) =>
      resolveRestoreSchema(schema, mappingContext),
    );
    const resolvedTablespaces = archiveTablespaces(metadata, entries).map((tablespace) =>
      resolveRestoreTablespace(tablespace, mappingContext),
    );
    const mappedEntries = entries.flatMap((entry) => {
      const mapped = mapRestoreArchiveEntry(entry, mappingContext);
      return mapped === undefined ? [] : [mapped];
    });
    const conflicts = detectRestoreConflicts(
      entries,
      target,
      mappingContext,
      options.existingObjectPolicy,
    );
    const discoveredExternalDependencyBlocks = detectExternalDependencyBlocks(conflicts, target);
    const selectedParentIdentities = new Set(
      conflicts.map((conflict) => `${conflict.target.schema ?? ''}\0${conflict.target.name}`),
    );
    const externalDependencyBlocks =
      options.cleanScope === 'selected-and-owned-dependents'
        ? discoveredExternalDependencyBlocks.filter((block) => {
            const dependent = block.dependency.dependent;
            return (
              dependent.parentName === undefined ||
              !selectedParentIdentities.has(
                `${dependent.parentSchema ?? dependent.schema ?? ''}\0${dependent.parentName}`,
              )
            );
          })
        : discoveredExternalDependencyBlocks;

    if (
      metadata.format !== RESTORE_ARCHIVE_FORMAT ||
      metadata.formatVersion !== RESTORE_ARCHIVE_FORMAT_VERSION
    ) {
      diagnostics.push(
        diagnostic(
          'archive-invalid',
          'fatal',
          'archive-validation',
          'The structured archive format or version is not supported.',
        ),
      );
    }
    if (!versionAllowed(target.version.number, metadata.targetVersionConstraint)) {
      diagnostics.push(
        diagnostic(
          'target-version-incompatible',
          'fatal',
          'preflight',
          'The PostgreSQL target version is outside the archive compatibility range.',
        ),
      );
    }

    for (const item of metadata.diagnostics) {
      diagnostics.push({
        code: 'archive-invalid',
        severity: item.severity === 'error' ? 'error' : item.severity,
        phase: 'archive-validation',
        message: item.message,
        ...(item.archiveEntryId === undefined ? {} : { archiveEntryId: item.archiveEntryId }),
        ...(item.objectIdentity === undefined ? {} : { objectIdentity: item.objectIdentity }),
        safeDetails: { sourceCode: item.code },
      });
    }

    for (const entry of entries) {
      if (entry.entryId.length === 0 || ids.has(entry.entryId)) {
        diagnostics.push(
          diagnostic(
            'archive-invalid',
            'fatal',
            'archive-validation',
            'Archive entry IDs must be non-empty and unique.',
            entry,
          ),
        );
      } else {
        ids.set(entry.entryId, entry);
      }
      if (entry.archiveIdentity.length === 0 || identities.has(entry.archiveIdentity)) {
        diagnostics.push(
          diagnostic(
            'archive-invalid',
            'fatal',
            'archive-validation',
            'Archive object identities must be non-empty and unique.',
            entry,
          ),
        );
      } else {
        identities.add(entry.archiveIdentity);
      }
    }

    for (const entry of entries) {
      for (const dependencyId of entry.dependencyEntryIds) {
        const dependency = ids.get(dependencyId);
        if (dependency === undefined) {
          diagnostics.push(
            diagnostic(
              'archive-dependency-missing',
              'fatal',
              'archive-validation',
              'An archive entry references a dependency that is not present.',
              entry,
            ),
          );
        } else if (dumpSectionPriority(entry.section) < dumpSectionPriority(dependency.section)) {
          diagnostics.push(
            diagnostic(
              'archive-invalid',
              'fatal',
              'archive-validation',
              'An earlier restore section depends on a later section.',
              entry,
            ),
          );
        } else if (
          restorePhasePriority(restorePhaseForEntry(entry)) <
          restorePhasePriority(restorePhaseForEntry(dependency))
        ) {
          diagnostics.push(
            diagnostic(
              'archive-invalid',
              'fatal',
              'archive-validation',
              'An earlier restore phase depends on a later finalization phase.',
              entry,
            ),
          );
        }
      }
      if (!versionAllowed(target.version.number, entry.operation.targetVersionConstraint)) {
        diagnostics.push(
          diagnostic(
            'target-version-incompatible',
            'error',
            'preflight',
            'The target version does not support this archive operation.',
            entry,
          ),
        );
      }
      if (
        (entry.operation.kind === 'acl' || entry.operation.kind === 'default-privilege') &&
        entry.operation.privilege.trim().toUpperCase() === 'MAINTAIN' &&
        target.version.major < 17
      ) {
        diagnostics.push(
          diagnostic(
            'target-version-incompatible',
            'error',
            'preflight',
            'The MAINTAIN privilege requires PostgreSQL 17 or newer.',
            entry,
          ),
        );
      }
      if (entry.operation.kind === 'table-data') {
        const operation = entry.operation;
        if (!target.driverCapabilities.copyFromStdin) {
          diagnostics.push(
            diagnostic(
              'unsupported-operation',
              'error',
              'preflight',
              'The selected PostgreSQL driver does not support COPY FROM STDIN.',
              entry,
              'Use the pg adapter with the optional pg-copy-streams dependency.',
            ),
          );
        }
        if (operation.format !== 'copy-text' || !canonicalCopyFormat(operation)) {
          diagnostics.push(
            diagnostic(
              'unsupported-operation',
              'error',
              'preflight',
              'Only the canonical UTF-8 PostgreSQL COPY text format is supported.',
              entry,
            ),
          );
        }
        if (target.clientEncoding.replaceAll('-', '').toUpperCase() !== 'UTF8') {
          diagnostics.push(
            diagnostic(
              'target-version-incompatible',
              'error',
              'preflight',
              'The PostgreSQL client encoding must be UTF8 for this archive payload.',
              entry,
            ),
          );
        }
        if (operation.columns.length === 0 && operation.allowZeroColumns !== true) {
          diagnostics.push(
            diagnostic(
              'archive-invalid',
              'error',
              'archive-validation',
              'A table-data entry has no target columns.',
              entry,
            ),
          );
        }
        if (
          operation.generatedColumns?.some((column) => operation.columns.includes(column)) === true
        ) {
          diagnostics.push(
            diagnostic(
              'archive-invalid',
              'error',
              'archive-validation',
              'Generated stored columns must not be included in COPY input.',
              entry,
            ),
          );
        }
        const includedIdentityCount =
          operation.identityColumns?.filter((column) => operation.columns.includes(column.name))
            .length ?? 0;
        const identityColumnCount = operation.identityColumns?.length ?? 0;
        if (
          (operation.identityBehavior === 'generate' && includedIdentityCount > 0) ||
          (operation.identityBehavior === 'preserve' &&
            identityColumnCount > 0 &&
            includedIdentityCount !== identityColumnCount)
        ) {
          diagnostics.push(
            diagnostic(
              'archive-invalid',
              'error',
              'archive-validation',
              'Identity-column metadata is inconsistent with the ordered COPY column list.',
              entry,
            ),
          );
        }
        if (
          operation.tableKind === 'partitioned-root' &&
          operation.partitionBehavior !== 'route-partitions'
        ) {
          diagnostics.push(
            diagnostic(
              'archive-invalid',
              'error',
              'archive-validation',
              'A partitioned root must explicitly route COPY rows to partitions.',
              entry,
            ),
          );
        }
        if (
          operation.tableKind === 'partition-leaf' &&
          operation.partitionBehavior !== 'target-table'
        ) {
          diagnostics.push(
            diagnostic(
              'archive-invalid',
              'error',
              'archive-validation',
              'A physical leaf partition must be copied directly.',
              entry,
            ),
          );
        }
        if (operation.partitionDataSetId !== undefined) {
          const behaviors = partitionDataSets.get(operation.partitionDataSetId) ?? new Set();
          behaviors.add(operation.partitionBehavior);
          partitionDataSets.set(operation.partitionDataSetId, behaviors);
        }
        if (
          operation.tableKind === 'foreign' &&
          operation.foreignTableDataRequired === true &&
          options.foreignTableDataMode === 'skip'
        ) {
          diagnostics.push(
            diagnostic(
              'unsupported-operation',
              'error',
              'preflight',
              'The archive requires foreign-table data but foreign-table loading is disabled.',
              entry,
            ),
          );
        }
        if (operation.checksum !== undefined && !/^[\da-f]{64}$/iu.test(operation.checksum.value)) {
          diagnostics.push(
            diagnostic(
              'archive-invalid',
              'error',
              'archive-validation',
              'A COPY SHA-256 checksum must contain exactly 64 hexadecimal characters.',
              entry,
            ),
          );
        }
      }
      if (entry.operation.kind === 'sequence-state') {
        const operation = entry.operation;
        try {
          validateSequenceState(operation);
        } catch {
          diagnostics.push(
            diagnostic(
              'archive-invalid',
              'error',
              'archive-validation',
              'The sequence-state entry contains invalid or out-of-range metadata.',
              entry,
            ),
          );
        }
        const definition = entry.dependencyEntryIds
          .map((dependencyId) => ids.get(dependencyId))
          .find(
            (dependency) =>
              dependency?.objectType === 'sequence' ||
              (operation.ownership === 'identity' && dependency?.objectType === 'table'),
          );
        if (definition === undefined) {
          diagnostics.push(
            diagnostic(
              'archive-dependency-missing',
              'error',
              'archive-validation',
              'A sequence-state entry must depend on its sequence definition.',
              entry,
            ),
          );
        }
        if (operation.ownership === 'identity' && !target.serverCapabilities.identityColumns) {
          diagnostics.push(
            diagnostic(
              'target-version-incompatible',
              'error',
              'preflight',
              'The target PostgreSQL version does not support identity sequences.',
              entry,
            ),
          );
        }
        if (operation.ownedBy !== undefined) {
          const ownedBy = operation.ownedBy;
          const relatedData = entries.find(
            (candidate) =>
              candidate.operation.kind === 'table-data' &&
              candidate.operation.table.schema === ownedBy.schema &&
              candidate.operation.table.table === ownedBy.table,
          );
          if (
            relatedData !== undefined &&
            !entry.dependencyEntryIds.includes(relatedData.entryId)
          ) {
            diagnostics.push(
              diagnostic(
                'archive-dependency-missing',
                'error',
                'archive-validation',
                'Owned sequence state must depend on its related table-data entry.',
                entry,
              ),
            );
          }
        }
      }
      if (
        entry.operation.kind === 'sql' &&
        !entrySkipped(entry, options) &&
        !EXECUTABLE_SQL_OBJECT_TYPES.has(entry.objectType)
      ) {
        diagnostics.push(
          diagnostic(
            'unsupported-operation',
            'error',
            'preflight',
            'This object type is not executable by the native restore skeleton.',
            entry,
          ),
        );
      }
      if (entry.operation.kind === 'sql' && entry.operation.containsSensitiveFragments === true) {
        diagnostics.push(
          diagnostic(
            'secret-rejected',
            'error',
            'preflight',
            'Trusted SQL containing sensitive fragments cannot be persisted in a restore plan.',
            entry,
            'Resolve secrets at execution time through a future secure operation type.',
          ),
        );
      }
      if (entry.operation.kind === 'sql') {
        const directIndex =
          entry.operation.createdIndexIdentity ??
          (entry.objectType === 'index' ? entry.objectIdentity : undefined);
        if (directIndex !== undefined) {
          if (directIndexIdentities.has(directIndex)) {
            diagnostics.push(
              diagnostic(
                'archive-invalid',
                'error',
                'archive-validation',
                'The restore archive plans to create the same index more than once.',
                entry,
              ),
            );
          }
          directIndexIdentities.add(directIndex);
        }
        if (entry.operation.constraintBackingIndexIdentity !== undefined) {
          constraintIndexIdentities.add(entry.operation.constraintBackingIndexIdentity);
        }
      }
      if (
        options.transactionMode === 'single' &&
        entry.operation.transactionRequirement === 'forbidden'
      ) {
        diagnostics.push(
          diagnostic(
            'transaction-incompatible',
            'error',
            'preflight',
            'Single-transaction restore contains an operation forbidden in a transaction.',
            entry,
          ),
        );
      }
      if (
        options.transactionMode === 'none' &&
        entry.operation.transactionRequirement === 'required'
      ) {
        diagnostics.push(
          diagnostic(
            'transaction-incompatible',
            'error',
            'preflight',
            'Transaction-free restore contains an operation requiring a transaction.',
            entry,
          ),
        );
      }
    }

    if ([...partitionDataSets.values()].some((behaviors) => behaviors.size > 1)) {
      diagnostics.push(
        diagnostic(
          'archive-invalid',
          'error',
          'archive-validation',
          'The archive mixes root-routed and physical-partition rows for one data set.',
        ),
      );
    }
    if ([...constraintIndexIdentities].some((identity) => directIndexIdentities.has(identity))) {
      diagnostics.push(
        diagnostic(
          'archive-invalid',
          'error',
          'archive-validation',
          'An index backing a constraint is also planned as a standalone index.',
        ),
      );
    }
    if (entries.some((entry) => entry.operation.kind === 'table-data')) {
      diagnostics.push(
        diagnostic(
          'restore-strategy',
          'info',
          'preflight',
          'Table data is restored before triggers, rules, row-level-security policies, ownership, comments, and privileges.',
        ),
      );
    }

    if (this.hasDependencyCycle(entries)) {
      diagnostics.push(
        diagnostic(
          'archive-dependency-cycle',
          'fatal',
          'archive-validation',
          'The structured restore archive contains a dependency cycle.',
        ),
      );
    }
    for (const resolution of resolvedSchemas) {
      if (resolution.kind === 'unresolved') {
        diagnostics.push({
          ...diagnostic(
            resolution.reason.includes('System')
              ? 'unsafe-system-schema-mapping'
              : 'schema-mapping-unresolved',
            'error',
            'preflight',
            resolution.reason,
          ),
          safeDetails: { schema: resolution.sourceSchema },
        });
      }
    }
    const mappedCreationTargets = mappedEntries.flatMap((entry) => {
      if (
        entry.operation.kind !== 'sql' ||
        entry.operation.target === undefined ||
        entry.operation.createsTarget === false
      ) {
        return [];
      }
      return [{ entry, identity: restoreTargetIdentity(entry.operation.target) }];
    });
    const targetCollisions = new Map<string, RestoreArchiveEntry[]>();
    for (const item of mappedCreationTargets) {
      const values = targetCollisions.get(item.identity) ?? [];
      values.push(item.entry);
      targetCollisions.set(item.identity, values);
    }
    for (const [identity, values] of targetCollisions) {
      if (values.length < 2) continue;
      diagnostics.push({
        ...diagnostic(
          'schema-mapping-collision',
          'error',
          'preflight',
          'Multiple selected archive objects resolve to the same mapped target identity.',
        ),
        safeDetails: { identity, count: values.length },
      });
    }
    const plannedSchemas = new Set(
      mappedEntries.flatMap((entry) =>
        entry.operation.kind === 'sql' &&
        entry.operation.target?.kind === 'schema' &&
        entry.operation.createsTarget !== false
          ? [entry.operation.target.name]
          : [],
      ),
    );
    for (const resolution of resolvedSchemas) {
      if (
        resolution.kind === 'mapped' &&
        'targetSchema' in resolution &&
        !target.schemas.includes(resolution.targetSchema) &&
        !plannedSchemas.has(resolution.targetSchema)
      ) {
        diagnostics.push({
          ...diagnostic(
            'schema-mapping-unresolved',
            'error',
            'preflight',
            'The resolved target schema neither exists nor has a selected create operation.',
          ),
          safeDetails: {
            sourceSchema: resolution.sourceSchema,
            targetSchema: resolution.targetSchema,
          },
        });
      }
    }
    for (const entry of entries) {
      if (entry.operation.kind !== 'sql') continue;
      const targetSchema =
        entry.operation.target?.kind === 'schema'
          ? entry.operation.target.name
          : entry.operation.target?.schema;
      if (targetSchema !== undefined) {
        const resolution = resolveRestoreSchema(targetSchema, mappingContext);
        if (resolution.kind === 'mapped' && entry.operation.structuredFragments === undefined) {
          diagnostics.push(
            diagnostic(
              'schema-mapping-unresolved',
              'error',
              'preflight',
              'A remapped SQL target has no renderer-authored structured identifier fragments.',
              entry,
            ),
          );
        }
      }
      if (
        entry.operation.tablespace !== undefined &&
        entry.operation.structuredFragments === undefined
      ) {
        const resolution = resolveRestoreTablespace(entry.operation.tablespace, mappingContext);
        if (resolution.kind !== 'preserved') {
          diagnostics.push(
            diagnostic(
              'tablespace-unavailable',
              'error',
              'preflight',
              'A remapped or omitted tablespace clause requires structured SQL fragments.',
              entry,
            ),
          );
        }
      }
      for (const reference of entry.operation.opaqueSchemaReferences ?? []) {
        const resolution = resolveRestoreSchema(reference.schema, mappingContext);
        if (resolution.kind !== 'mapped') continue;
        diagnostics.push({
          ...diagnostic(
            'opaque-schema-reference',
            options.opaqueSchemaReferencePolicy === 'error' ? 'error' : 'warning',
            'preflight',
            'Opaque SQL text references a remapped schema and is preserved unchanged.',
            entry,
          ),
          safeDetails: {
            sourceSchema: reference.schema,
            targetSchema: resolution.targetSchema,
            context: reference.context,
          },
        });
      }
    }
    for (const resolution of resolvedTablespaces) {
      if (resolution.kind === 'unresolved') {
        diagnostics.push({
          ...diagnostic('tablespace-unavailable', 'error', 'preflight', resolution.reason),
          safeDetails: { tablespace: resolution.sourceTablespace },
        });
      } else if (resolution.kind === 'omitted' || resolution.kind === 'default-target') {
        diagnostics.push({
          ...diagnostic('tablespace-omitted', 'warning', 'preflight', resolution.reason),
          safeDetails: { tablespace: resolution.sourceTablespace },
        });
      }
    }
    for (const conflict of conflicts) {
      const severity =
        options.existingObjectPolicy === 'fail' ||
        conflict.compatibility === 'incompatible' ||
        conflict.classification === 'extension-managed'
          ? 'error'
          : 'warning';
      diagnostics.push({
        ...diagnostic(
          'existing-object-conflict',
          severity,
          'conflict-scan',
          'A selected archive object conflicts with an existing mapped target object.',
        ),
        archiveEntryId: conflict.archiveEntryId,
        objectIdentity: conflict.mappedTargetIdentity,
        safeDetails: {
          targetKind: conflict.targetObjectKind,
          existingKind: conflict.existingObjectKind,
          classification: conflict.classification,
          policy: conflict.policy,
        },
        remediation: conflict.suggestedRemediation,
      });
      if (options.existingObjectPolicy === 'replace-safe') {
        const source = entries.find((entry) => entry.entryId === conflict.archiveEntryId);
        const replacementDeclared =
          source?.operation.kind === 'sql' &&
          source.operation.replaceStrategy !== undefined &&
          (source.operation.replaceStrategy === 'drop-and-recreate' ||
            source.operation.replacementSql !== undefined);
        const shape =
          source?.operation.kind === 'sql' ? source.operation.replacementTargetShape : undefined;
        const viewCompatible =
          conflict.target.kind !== 'view' ||
          (shape?.columns !== undefined &&
            conflict.existing.columns !== undefined &&
            shape.columns.length === conflict.existing.columns.length &&
            shape.columns.every(
              (column, index) =>
                column.name === conflict.existing.columns?.[index]?.name &&
                column.formattedType === conflict.existing.columns[index]?.formattedType,
            ));
        const routineCompatible =
          (conflict.target.kind !== 'function' && conflict.target.kind !== 'procedure') ||
          (shape?.returnType !== undefined && shape.returnType === conflict.existing.returnType);
        if (
          !conflictSupportsSafeReplacement(conflict) ||
          !replacementDeclared ||
          !viewCompatible ||
          !routineCompatible
        ) {
          diagnostics.push(
            diagnostic(
              'unsafe-replacement',
              'error',
              'preflight',
              'The conflict has no declared semantically safe replacement strategy.',
              source,
              'Use clean mode or provide an explicitly supported replacement operation.',
            ),
          );
        }
      }
    }
    const cleanRequested =
      options.cleanMode !== 'none' ||
      options.existingObjectPolicy === 'clean' ||
      options.existingObjectPolicy === 'clean-selected';
    if (cleanRequested) {
      for (const block of externalDependencyBlocks) {
        diagnostics.push({
          ...diagnostic(
            'external-dependent-object',
            'error',
            'preflight',
            'An unselected target object depends on an object selected for clean.',
          ),
          archiveEntryId: block.conflictArchiveEntryId,
          safeDetails: {
            referenced: block.referencedIdentity,
            dependent: block.dependentIdentity,
          },
          remediation: 'Include the dependent object explicitly or preserve the selected target.',
        });
      }
      if (options.transactionMode !== 'single') {
        diagnostics.push(
          diagnostic(
            'destructive-partial-state-risk',
            'warning',
            'preflight',
            'A failure after the clean transaction may leave destructive partial state.',
          ),
        );
      }
    }
    if (options.rowSecurityMode !== 'normal' && options.transactionMode === 'none') {
      diagnostics.push(
        diagnostic(
          'transaction-incompatible',
          'error',
          'preflight',
          'Replica-role restore mode requires an automatic transaction.',
        ),
      );
    } else if (options.rowSecurityMode !== 'normal' && !target.currentUser.superuser) {
      diagnostics.push(
        diagnostic(
          'privilege-required',
          'warning',
          'preflight',
          'Replica-role restore mode requires permission to set session_replication_role.',
        ),
      );
    }

    for (const extension of metadata.requiredExtensions.filter(
      (name) => !target.extensions.includes(name),
    )) {
      diagnostics.push({
        ...diagnostic(
          'required-extension-missing',
          'error',
          'preflight',
          'A required extension is not installed on the restore target.',
        ),
        safeDetails: { extension },
      });
    }
    const referencedRoles = new Set(metadata.requiredRoles);
    for (const entry of entries) {
      const operation = entry.operation;
      if (
        operation.kind === 'ownership' &&
        options.ownershipMode !== 'skip' &&
        options.ownershipMode !== 'omit' &&
        options.ownershipMode !== 'current-user'
      ) {
        referencedRoles.add(operation.owner);
      }
      if (
        operation.kind === 'acl' &&
        options.privilegesMode !== 'skip' &&
        options.privilegesMode !== 'omit'
      ) {
        referencedRoles.add(operation.grantee);
        if (operation.grantor !== undefined) referencedRoles.add(operation.grantor);
      }
      if (
        operation.kind === 'default-privilege' &&
        options.privilegesMode !== 'skip' &&
        options.privilegesMode !== 'omit'
      ) {
        referencedRoles.add(operation.owner);
        referencedRoles.add(operation.grantee);
        if (operation.grantor !== undefined) referencedRoles.add(operation.grantor);
      }
    }
    const roleResolutions = [...referencedRoles].map((role) =>
      resolveRestoreRole(role, {
        target,
        mappings: options.roleMappings,
        missingRolePolicy: options.missingRolePolicy,
      }),
    );
    for (const resolution of roleResolutions.filter((item) => item.status === 'unresolved')) {
      diagnostics.push({
        ...diagnostic(
          'required-role-missing',
          'error',
          'preflight',
          'A role referenced by the archive is not available on the restore target.',
        ),
        safeDetails: { role: resolution.sourceRole },
      });
    }
    for (const resolution of roleResolutions.filter((item) => item.status === 'omitted')) {
      diagnostics.push({
        ...diagnostic(
          'required-role-missing',
          'warning',
          'preflight',
          'A role reference will be omitted by the configured restore policy.',
        ),
        safeDetails: { role: resolution.sourceRole },
      });
    }
    if (
      options.ownershipMode !== 'skip' &&
      options.ownershipMode !== 'omit' &&
      options.ownershipMode !== 'current-user' &&
      !target.currentUser.superuser
    ) {
      const setRoleTargets = new Set(target.setRoleTargets ?? [target.currentUser.name]);
      for (const entry of entries.filter((item) => item.operation.kind === 'ownership')) {
        const operation = entry.operation;
        if (operation.kind !== 'ownership') continue;
        const resolution = resolveRestoreRole(operation.owner, {
          target,
          mappings: options.roleMappings,
          missingRolePolicy: options.missingRolePolicy,
        });
        if (
          'targetRole' in resolution &&
          resolution.targetRole !== target.currentUser.name &&
          !setRoleTargets.has(resolution.targetRole)
        ) {
          diagnostics.push({
            ...diagnostic(
              'privilege-required',
              'error',
              'preflight',
              'The current session cannot transfer ownership to the resolved target role.',
              entry,
            ),
            safeDetails: { role: resolution.targetRole },
          });
        }
      }
    }
    if (options.grantorPolicy === 'preserve-when-possible' && !target.currentUser.superuser) {
      const setRoleTargets = new Set(target.setRoleTargets ?? [target.currentUser.name]);
      for (const resolution of roleResolutions) {
        if (
          'targetRole' in resolution &&
          resolution.status !== 'public' &&
          resolution.targetRole !== target.currentUser.name &&
          !setRoleTargets.has(resolution.targetRole)
        ) {
          const usedAsGrantor = entries.some((entry) => {
            const operation = entry.operation;
            return (
              (operation.kind === 'acl' || operation.kind === 'default-privilege') &&
              (operation.grantor === resolution.sourceRole ||
                (operation.kind === 'default-privilege' &&
                  operation.grantor === undefined &&
                  operation.owner === resolution.sourceRole))
            );
          });
          if (!usedAsGrantor) continue;
          diagnostics.push({
            ...diagnostic(
              'privilege-required',
              options.privilegesMode === 'best-effort' ? 'warning' : 'error',
              'preflight',
              'The current session cannot assume an archived grantor role.',
            ),
            safeDetails: { role: resolution.targetRole },
          });
        }
      }
    }
    if (options.grantorPolicy === 'error') {
      for (const entry of entries) {
        const operation = entry.operation;
        if (
          (operation.kind === 'acl' || operation.kind === 'default-privilege') &&
          operation.grantor !== undefined
        ) {
          const resolution = resolveRestoreRole(operation.grantor, {
            target,
            mappings: options.roleMappings,
            missingRolePolicy: options.missingRolePolicy,
          });
          if ('targetRole' in resolution && resolution.targetRole !== target.currentUser.name) {
            diagnostics.push({
              ...diagnostic(
                'privilege-required',
                'error',
                'preflight',
                'Archived grantor semantics require a different execution role.',
                entry,
              ),
              safeDetails: { role: resolution.targetRole },
            });
          }
        }
      }
    }
    for (const privilege of metadata.requiredPrivileges) {
      diagnostics.push({
        ...diagnostic(
          'privilege-required',
          'warning',
          'preflight',
          'The archive declares a PostgreSQL privilege requirement.',
        ),
        safeDetails: { privilege },
      });
    }

    const roleMappings = options.roleMappings.map((item): RestoreMappingResult => {
      const resolution = resolveRestoreRole(item.sourceRole, {
        target,
        mappings: options.roleMappings,
        missingRolePolicy: options.missingRolePolicy,
      });
      if (resolution.status === 'omitted') return { status: 'omitted', source: item.sourceRole };
      if (resolution.status === 'unresolved') {
        return { status: 'unresolved', source: item.sourceRole };
      }
      if (!('targetRole' in resolution)) {
        return { status: 'unresolved', source: item.sourceRole };
      }
      return resolution.sourceRole === resolution.targetRole
        ? { status: 'unchanged', source: resolution.sourceRole, target: resolution.targetRole }
        : { status: 'mapped', source: resolution.sourceRole, target: resolution.targetRole };
    });
    const schemaMappings = resolvedSchemas.map((item): RestoreMappingResult => {
      if (item.kind === 'omitted') return { status: 'omitted', source: item.sourceSchema };
      if (item.kind === 'unresolved') return { status: 'unresolved', source: item.sourceSchema };
      if (!('targetSchema' in item)) return { status: 'unresolved', source: item.sourceSchema };
      return item.kind === 'mapped'
        ? { status: 'mapped', source: item.sourceSchema, target: item.targetSchema }
        : { status: 'unchanged', source: item.sourceSchema, target: item.targetSchema };
    });
    const tablespaceMappings = resolvedTablespaces.map((item): RestoreMappingResult => {
      if (item.kind === 'omitted' || item.kind === 'default-target') {
        return { status: 'omitted', source: item.sourceTablespace };
      }
      if (item.kind === 'unresolved') {
        return { status: 'unresolved', source: item.sourceTablespace };
      }
      if (!('targetTablespace' in item)) {
        return { status: 'unresolved', source: item.sourceTablespace };
      }
      return item.kind === 'mapped'
        ? {
            status: 'mapped',
            source: item.sourceTablespace,
            target: item.targetTablespace,
          }
        : {
            status: 'unchanged',
            source: item.sourceTablespace,
            target: item.targetTablespace,
          };
    });
    const mappings = [...roleMappings, ...schemaMappings, ...tablespaceMappings];
    if (mappings.some((mapping) => mapping.status === 'unresolved')) {
      diagnostics.push(
        diagnostic(
          'mapping-unresolved',
          'error',
          'preflight',
          'One or more restore mappings do not resolve to target objects.',
        ),
      );
    }
    const skippedEntryCount = entries.filter((entry) => entrySkipped(entry, options)).length;
    const objectsToDrop =
      cleanRequested && externalDependencyBlocks.length === 0
        ? conflicts.map((conflict) => conflict.target)
        : [];
    const objectsToReplace =
      options.existingObjectPolicy === 'replace-safe'
        ? conflicts.filter(conflictSupportsSafeReplacement).map((conflict) => conflict.target)
        : [];
    const conflictTableKeys = new Set(
      conflicts
        .filter((conflict) => conflict.target.kind === 'table')
        .map((conflict) => restoreTargetIdentity(conflict.target)),
    );
    const mappedDataTargets = mappedEntries.flatMap((entry) =>
      entry.operation.kind === 'table-data'
        ? [
            {
              entry,
              target: {
                kind: 'table' as const,
                schema: entry.operation.table.schema,
                name: entry.operation.table.table,
              },
            },
          ]
        : [],
    );
    const existingDataTargets = mappedDataTargets.filter((item) =>
      conflictTableKeys.has(restoreTargetIdentity(item.target)),
    );
    for (const item of existingDataTargets) {
      const existing = target.objects?.find(
        (object) =>
          object.kind === 'table' &&
          object.schema === item.target.schema &&
          object.name === item.target.name,
      );
      const operation = item.entry.operation;
      if (
        existing === undefined ||
        operation.kind !== 'table-data' ||
        existing.columns === undefined
      ) {
        continue;
      }
      const writableColumns = existing.columns
        .filter((column) => !column.generated)
        .map((column) => column.name);
      const compatible =
        operation.columns.length <= writableColumns.length &&
        operation.columns.every((column, index) => writableColumns[index] === column);
      if (!compatible) {
        diagnostics.push(
          diagnostic(
            'incompatible-existing-table',
            'error',
            'preflight',
            'The existing target table column order is incompatible with COPY metadata.',
            item.entry,
          ),
        );
      }
    }
    if (existingDataTargets.length > 0 && !cleanRequested) {
      if (options.existingTableDataPolicy === 'append') {
        diagnostics.push(
          diagnostic(
            'append-semantics',
            'warning',
            'preflight',
            'COPY data will be appended; uniqueness, duplicates, and round-trip equivalence are not guaranteed.',
          ),
        );
      } else if (options.existingTableDataPolicy === 'fail-if-not-empty') {
        diagnostics.push(
          diagnostic(
            'non-empty-table',
            'warning',
            'preflight',
            'Existing table emptiness will be asserted immediately before COPY.',
          ),
        );
      }
    }
    const tablesToTruncate =
      options.existingTableDataPolicy === 'truncate' && !cleanRequested
        ? existingDataTargets.map((item) => item.target)
        : [];
    if (tablesToTruncate.length > 0) {
      for (const block of externalDependencyBlocks.filter(
        (item) => item.dependency.dependencyType === 'foreign-key',
      )) {
        diagnostics.push({
          ...diagnostic(
            'truncate-blocked',
            'error',
            'preflight',
            'TRUNCATE is blocked by an external foreign-key referencing table.',
          ),
          archiveEntryId: block.conflictArchiveEntryId,
          safeDetails: {
            referenced: block.referencedIdentity,
            dependent: block.dependentIdentity,
          },
        });
      }
    }
    const tablesToAppend =
      options.existingTableDataPolicy === 'append' && !cleanRequested
        ? existingDataTargets.map((item) => item.target)
        : [];
    for (const entry of mappedEntries.filter((item) => item.operation.kind === 'sequence-state')) {
      const operation = entry.operation;
      if (operation.kind !== 'sequence-state') continue;
      const exists = target.objects?.some(
        (object) =>
          object.kind === 'sequence' &&
          object.schema === operation.schema &&
          object.name === operation.sequence,
      );
      if (exists !== true || cleanRequested) continue;
      if (
        options.existingSequenceStatePolicy === 'error' ||
        options.existingSequenceStatePolicy === 'advance-to-safe-value'
      ) {
        diagnostics.push(
          diagnostic(
            'sequence-state-conflict',
            'error',
            'preflight',
            options.existingSequenceStatePolicy === 'advance-to-safe-value'
              ? 'Safe automatic sequence advancement is not available for arbitrary sequence semantics.'
              : 'Archive sequence state conflicts with an existing target sequence.',
            entry,
          ),
        );
      }
    }
    const destructiveImpact: RestoreDestructiveImpactReport = {
      conflicts,
      objectsToDrop,
      objectsToReplace,
      tablesToTruncate,
      tablesToAppend,
      ownershipChanges: mappedEntries
        .filter((entry) => entry.operation.kind === 'ownership')
        .map((entry) => entry.objectIdentity ?? entry.archiveIdentity),
      aclChanges: mappedEntries
        .filter(
          (entry) => entry.operation.kind === 'acl' || entry.operation.kind === 'default-privilege',
        )
        .map((entry) => entry.objectIdentity ?? entry.archiveIdentity),
      externalDependencyBlocks,
      schemaMappings: resolvedSchemas.flatMap((item) =>
        item.kind === 'mapped'
          ? [{ sourceSchema: item.sourceSchema, targetSchema: item.targetSchema }]
          : [],
      ),
      tablespaceMappings: resolvedTablespaces.map((item) => ({
        sourceTablespace: item.sourceTablespace,
        ...('targetTablespace' in item ? { targetTablespace: item.targetTablespace } : {}),
        omitted: item.kind === 'omitted' || item.kind === 'default-target',
      })),
      rollbackGuarantee:
        options.transactionMode === 'single'
          ? 'single-transaction'
          : options.transactionMode === 'none'
            ? 'none'
            : 'phase-scoped',
    };
    return {
      archiveMetadata: metadata,
      target,
      diagnostics,
      roleMappings,
      schemaMappings,
      tablespaceMappings,
      resolvedSchemas,
      resolvedTablespaces,
      conflicts,
      destructiveImpact,
      summary: {
        archiveEntryCount: entries.length,
        executableEntryCount: entries.length - skippedEntryCount,
        skippedEntryCount,
        preservedRoleCount: roleResolutions.filter((item) => item.status === 'preserved').length,
        mappedRoleCount: roleResolutions.filter((item) => item.status === 'mapped').length,
        currentUserRoleCount: roleResolutions.filter((item) => item.status === 'current-user')
          .length,
        omittedRoleCount: roleResolutions.filter((item) => item.status === 'omitted').length,
        unresolvedRoleCount: roleResolutions.filter((item) => item.status === 'unresolved').length,
        conflictsDetectedCount: conflicts.length,
        externalDependencyBlockCount: externalDependencyBlocks.length,
        schemasRemappedCount: resolvedSchemas.filter((item) => item.kind === 'mapped').length,
        tablespacesRemappedCount: resolvedTablespaces.filter((item) => item.kind === 'mapped')
          .length,
        ...(metadata.estimatedRows === undefined ? {} : { estimatedRows: metadata.estimatedRows }),
        ...(metadata.estimatedDataBytes === undefined
          ? {}
          : { estimatedDataBytes: metadata.estimatedDataBytes }),
      },
      canProceed: !diagnostics.some(
        (item) => item.severity === 'error' || item.severity === 'fatal',
      ),
    };
  }

  private hasDependencyCycle(entries: readonly RestoreArchiveEntry[]): boolean {
    const entriesById = new Map(entries.map((entry) => [entry.entryId, entry]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (entryId: string): boolean => {
      if (visiting.has(entryId)) return true;
      if (visited.has(entryId)) return false;
      visiting.add(entryId);
      for (const dependencyId of entriesById.get(entryId)?.dependencyEntryIds ?? []) {
        if (entriesById.has(dependencyId) && visit(dependencyId)) return true;
      }
      visiting.delete(entryId);
      visited.add(entryId);
      return false;
    };
    return entries.some((entry) => visit(entry.entryId));
  }
}
