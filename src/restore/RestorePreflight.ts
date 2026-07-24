import { dumpSectionPriority } from '../archive/SectionRules.js';
import type {
  RestoreArchiveEntry,
  RestoreArchiveMetadata,
  RestoreTargetVersionConstraint,
} from './RestoreArchive.js';
import { RESTORE_ARCHIVE_FORMAT, RESTORE_ARCHIVE_FORMAT_VERSION } from './RestoreArchive.js';
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
      options.privilegesMode === 'skip')
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
        diagnostics.push(
          diagnostic(
            'unsupported-operation',
            'error',
            'preflight',
            'Native table-data restore is not implemented in this architecture milestone.',
            entry,
            'Use a schema-only structured archive until COPY FROM STDIN support is added.',
          ),
        );
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
    if (options.rowSecurityMode !== 'normal') {
      diagnostics.push(
        diagnostic(
          'privilege-required',
          'error',
          'preflight',
          'Replica-role restore mode is not implemented and may require elevated privileges.',
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
    if (mappings.some((mapping) => mapping.status === 'mapped')) {
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
