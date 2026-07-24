import type { PostgresObjectKind } from '../model/PostgresStructuralObjects.js';
import type { RestoreArchiveEntry, RestoreObjectTarget } from './RestoreArchive.js';
import {
  restoreEntryTarget,
  restoreTargetIdentity,
  type RestoreMappingContext,
  mapRestoreArchiveEntry,
} from './RestoreMapping.js';
import type {
  RestoreTargetDependency,
  RestoreTargetObject,
  RestoreTargetSnapshot,
} from './RestoreTarget.js';
import type { RestoreExistingObjectPolicy } from './RestoreTypes.js';

export type RestoreConflictClassification =
  | 'exact-kind'
  | 'incompatible-kind'
  | 'routine-overload'
  | 'schema'
  | 'extension-managed'
  | 'dependent-object';

export interface RestoreExistingObjectConflict {
  readonly archiveEntryId: string;
  readonly sourceObjectIdentity: string;
  readonly mappedTargetIdentity: string;
  readonly targetObjectKind: PostgresObjectKind;
  readonly existingObjectKind: PostgresObjectKind;
  readonly classification: RestoreConflictClassification;
  readonly compatibility: 'compatible' | 'incompatible' | 'unknown';
  readonly policy: RestoreExistingObjectPolicy;
  readonly target: RestoreObjectTarget;
  readonly existing: RestoreTargetObject;
  readonly suggestedRemediation: string;
}

export interface RestoreExternalDependencyBlock {
  readonly conflictArchiveEntryId: string;
  readonly referencedIdentity: string;
  readonly dependentIdentity: string;
  readonly dependency: RestoreTargetDependency;
}

export interface RestoreDestructiveImpactReport {
  readonly conflicts: readonly RestoreExistingObjectConflict[];
  readonly objectsToDrop: readonly RestoreObjectTarget[];
  readonly objectsToReplace: readonly RestoreObjectTarget[];
  readonly tablesToTruncate: readonly RestoreObjectTarget[];
  readonly tablesToAppend: readonly RestoreObjectTarget[];
  readonly ownershipChanges: readonly string[];
  readonly aclChanges: readonly string[];
  readonly externalDependencyBlocks: readonly RestoreExternalDependencyBlock[];
  readonly schemaMappings: readonly {
    sourceSchema: string;
    targetSchema: string;
  }[];
  readonly tablespaceMappings: readonly {
    sourceTablespace: string;
    targetTablespace?: string;
    omitted: boolean;
  }[];
  readonly rollbackGuarantee: 'single-transaction' | 'phase-scoped' | 'none';
}

function sameRoutineIdentity(target: RestoreObjectTarget, existing: RestoreTargetObject): boolean {
  return (
    target.schema === existing.schema &&
    target.name === existing.name &&
    (target.identityArguments ?? '') === (existing.identityArguments ?? '')
  );
}

function namespaceMatches(target: RestoreObjectTarget, existing: RestoreTargetObject): boolean {
  if (target.kind === 'schema') return existing.kind === 'schema' && target.name === existing.name;
  if (target.kind === 'function' || target.kind === 'procedure' || target.kind === 'aggregate') {
    return sameRoutineIdentity(target, existing);
  }
  return target.schema === existing.schema && target.name === existing.name;
}

function isCreationEntry(entry: RestoreArchiveEntry): boolean {
  return entry.operation.kind === 'sql' && entry.operation.target !== undefined
    ? entry.operation.createsTarget !== false
    : false;
}

export function detectRestoreConflicts(
  entries: readonly RestoreArchiveEntry[],
  target: RestoreTargetSnapshot,
  mapping: RestoreMappingContext,
  policy: RestoreExistingObjectPolicy,
): readonly RestoreExistingObjectConflict[] {
  const existingObjects = target.objects ?? [];
  const conflicts: RestoreExistingObjectConflict[] = [];
  for (const sourceEntry of entries.filter(isCreationEntry)) {
    const entry = mapRestoreArchiveEntry(sourceEntry, mapping);
    if (entry === undefined) continue;
    const mappedTarget = restoreEntryTarget(entry);
    const sourceTarget = restoreEntryTarget(sourceEntry);
    if (mappedTarget === undefined || sourceTarget === undefined) continue;
    const existing = existingObjects.find((candidate) => namespaceMatches(mappedTarget, candidate));
    if (existing === undefined) continue;
    const exact = existing.kind === mappedTarget.kind;
    const extensionManaged = existing.extensionName !== undefined && existing.kind !== 'extension';
    const routineKind =
      mappedTarget.kind === 'function' ||
      mappedTarget.kind === 'procedure' ||
      mappedTarget.kind === 'aggregate';
    const classification: RestoreConflictClassification = extensionManaged
      ? 'extension-managed'
      : mappedTarget.kind === 'schema'
        ? 'schema'
        : exact
          ? 'exact-kind'
          : routineKind
            ? 'routine-overload'
            : 'incompatible-kind';
    conflicts.push({
      archiveEntryId: entry.entryId,
      sourceObjectIdentity: restoreTargetIdentity(sourceTarget),
      mappedTargetIdentity: restoreTargetIdentity(mappedTarget),
      targetObjectKind: mappedTarget.kind,
      existingObjectKind: existing.kind,
      classification,
      compatibility: exact ? 'compatible' : 'incompatible',
      policy,
      target: mappedTarget,
      existing,
      suggestedRemediation:
        policy === 'fail'
          ? 'Choose skip, clean, or an explicitly supported replace-safe strategy.'
          : extensionManaged
            ? 'Clean or replace the owning extension as a unit.'
            : 'Inspect the mapped target and selected dependency scope.',
    });
  }
  return conflicts;
}

export function detectExternalDependencyBlocks(
  conflicts: readonly RestoreExistingObjectConflict[],
  target: RestoreTargetSnapshot,
): readonly RestoreExternalDependencyBlock[] {
  const conflictByExistingOid = new Map(
    conflicts.flatMap((conflict) =>
      conflict.existing.catalogOid === undefined
        ? []
        : [[conflict.existing.catalogOid, conflict] as const],
    ),
  );
  const selectedExistingOids = new Set(conflictByExistingOid.keys());
  const blocks: RestoreExternalDependencyBlock[] = [];
  for (const dependency of target.objectDependencies ?? []) {
    const referencedOid = dependency.referenced.catalogOid;
    const dependentOid = dependency.dependent.catalogOid;
    if (referencedOid === undefined || dependentOid === undefined) continue;
    const conflict = conflictByExistingOid.get(referencedOid);
    if (conflict === undefined || selectedExistingOids.has(dependentOid)) continue;
    blocks.push({
      conflictArchiveEntryId: conflict.archiveEntryId,
      referencedIdentity: restoreTargetObjectIdentity(dependency.referenced),
      dependentIdentity: restoreTargetObjectIdentity(dependency.dependent),
      dependency,
    });
  }
  for (const conflict of conflicts.filter((item) => item.target.kind === 'schema')) {
    for (const object of target.objects ?? []) {
      if (
        object.schema !== conflict.target.name ||
        object.catalogOid === undefined ||
        selectedExistingOids.has(object.catalogOid)
      ) {
        continue;
      }
      blocks.push({
        conflictArchiveEntryId: conflict.archiveEntryId,
        referencedIdentity: conflict.mappedTargetIdentity,
        dependentIdentity: restoreTargetObjectIdentity(object),
        dependency: { dependent: object, referenced: conflict.existing },
      });
    }
  }
  return blocks;
}

export function restoreTargetObjectIdentity(object: RestoreTargetObject): string {
  return restoreTargetIdentity({
    kind: object.kind,
    ...(object.schema === undefined ? {} : { schema: object.schema }),
    name: object.name,
    ...(object.identityArguments === undefined
      ? {}
      : { identityArguments: object.identityArguments }),
  });
}
