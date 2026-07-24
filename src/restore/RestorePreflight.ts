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
import type {
  RestoreDiagnostic,
  RestoreMappingResult,
  RestoreOptions,
  RestorePhase,
} from './RestoreTypes.js';

const EXECUTABLE_SQL_OBJECT_TYPES = new Set<RestoreArchiveEntry['objectType']>(['schema', 'table']);

export interface RestorePreflightSummary {
  readonly archiveEntryCount: number;
  readonly executableEntryCount: number;
  readonly skippedEntryCount: number;
  readonly estimatedRows?: number;
  readonly estimatedDataBytes?: number;
}

export interface RestorePreflightReport {
  readonly archiveMetadata: RestoreArchiveMetadata;
  readonly target: RestoreTargetSnapshot;
  readonly diagnostics: readonly RestoreDiagnostic[];
  readonly roleMappings: readonly RestoreMappingResult[];
  readonly schemaMappings: readonly RestoreMappingResult[];
  readonly tablespaceMappings: readonly RestoreMappingResult[];
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
    (entry.objectType === 'comment' && options.commentsMode === 'skip') ||
    (entry.objectType === 'ownership' && options.ownershipMode === 'skip') ||
    ((entry.objectType === 'acl' || entry.objectType === 'default-privilege') &&
      options.privilegesMode === 'skip') ||
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

function resolveMappings(
  available: ReadonlySet<string>,
  mappings: readonly {
    readonly source: string;
    readonly action: 'map' | 'omit';
    readonly target?: string;
  }[],
): readonly RestoreMappingResult[] {
  return mappings.map((mapping): RestoreMappingResult => {
    if (mapping.action === 'omit') {
      return { status: 'omitted', source: mapping.source };
    }
    if (mapping.target === undefined || !available.has(mapping.target)) {
      return { status: 'unresolved', source: mapping.source };
    }
    return mapping.source === mapping.target
      ? { status: 'unchanged', source: mapping.source, target: mapping.target }
      : { status: 'mapped', source: mapping.source, target: mapping.target };
  });
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
    if (options.cleanMode !== 'none' || options.existingObjectPolicy !== 'fail') {
      diagnostics.push(
        diagnostic(
          'dangerous-operation',
          'error',
          'preflight',
          'Cleanup and alternative existing-object policies are not implemented.',
          undefined,
          'Use cleanMode "none" and existingObjectPolicy "fail".',
        ),
      );
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
    for (const role of metadata.requiredRoles.filter((name) => !target.roles.includes(name))) {
      diagnostics.push({
        ...diagnostic(
          'required-role-missing',
          options.ownershipMode === 'preserve' ? 'error' : 'warning',
          'preflight',
          'A role referenced by the archive is not available on the restore target.',
        ),
        safeDetails: { role },
      });
    }
    for (const tablespace of metadata.requiredTablespaces.filter(
      (name) => !target.tablespaces.includes(name),
    )) {
      diagnostics.push({
        ...diagnostic(
          'required-tablespace-missing',
          'error',
          'preflight',
          'A required tablespace is not available on the restore target.',
        ),
        safeDetails: { tablespace },
      });
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

    const roleMappings = resolveMappings(
      new Set(target.roles),
      options.roleMappings.map((item) => ({
        source: item.sourceRole,
        action: item.action,
        ...(item.targetRole === undefined ? {} : { target: item.targetRole }),
      })),
    );
    const schemaMappings = resolveMappings(
      new Set(target.schemas),
      options.schemaMappings.map((item) => ({
        source: item.sourceSchema,
        action: item.action,
        ...(item.targetSchema === undefined ? {} : { target: item.targetSchema }),
      })),
    );
    const tablespaceMappings = resolveMappings(
      new Set(target.tablespaces),
      options.tablespaceMappings.map((item) => ({
        source: item.sourceTablespace,
        action: item.action,
        ...(item.targetTablespace === undefined ? {} : { target: item.targetTablespace }),
      })),
    );
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
    if ([...roleMappings, ...tablespaceMappings].some((mapping) => mapping.status === 'mapped')) {
      diagnostics.push(
        diagnostic(
          'mapping-not-implemented',
          'error',
          'preflight',
          'Renderer-aware object remapping is reserved but not implemented.',
        ),
      );
    }

    const skippedEntryCount = entries.filter((entry) => entrySkipped(entry, options)).length;
    return {
      archiveMetadata: metadata,
      target,
      diagnostics,
      roleMappings,
      schemaMappings,
      tablespaceMappings,
      summary: {
        archiveEntryCount: entries.length,
        executableEntryCount: entries.length - skippedEntryCount,
        skippedEntryCount,
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
