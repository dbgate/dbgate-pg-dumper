import { archiveObjectPriority } from '../archive/SectionRules.js';
import { quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import type { RestoreArchiveEntry, RestoreArchiveMetadata } from './RestoreArchive.js';
import type { RestorePreflightReport } from './RestorePreflight.js';
import {
  createRestoreStepId,
  RESTORE_EXECUTION_PHASES,
  restorePhasePriority,
  restorePhaseForEntry,
  type RestorePlan,
  type RestorePlanStep,
} from './RestorePlan.js';
import { RestorePlanningError } from './RestoreErrors.js';
import type { RestoreOptions } from './RestoreTypes.js';
import {
  buildAclSql,
  buildCommentSql,
  buildDefaultPrivilegeSql,
  buildOwnershipSql,
  resolveRestoreRole,
  type RestoreRoleResolution,
} from './RestoreFinalization.js';
import { mapRestoreArchiveEntry, restoreTargetIdentity } from './RestoreMapping.js';
import { buildRestoreDropSql } from './RestoreClean.js';
import type { RestoreExistingObjectConflict } from './RestoreConflicts.js';
import type { RestoreTargetSnapshot } from './RestoreTarget.js';

function shouldSkip(entry: RestoreArchiveEntry, options: RestoreOptions): string | undefined {
  if (
    entry.objectType === 'comment' &&
    (options.commentsMode === 'skip' || options.commentsMode === 'omit')
  ) {
    return 'Comments are disabled by restore options.';
  }
  if (
    entry.objectType === 'ownership' &&
    (options.ownershipMode === 'skip' || options.ownershipMode === 'omit')
  ) {
    return 'Ownership restoration is disabled by restore options.';
  }
  if (
    (entry.objectType === 'acl' || entry.objectType === 'default-privilege') &&
    (options.privilegesMode === 'skip' || options.privilegesMode === 'omit')
  ) {
    return 'Privilege restoration is disabled by restore options.';
  }
  if (
    entry.operation.kind === 'table-data' &&
    entry.operation.tableKind === 'foreign' &&
    entry.operation.foreignTableDataRequired !== true &&
    options.foreignTableDataMode === 'skip'
  ) {
    return 'Foreign-table data loading is disabled by restore options.';
  }
  if (
    entry.operation.kind === 'table-data' &&
    options.schemaMappings.some((mapping) => {
      const operation = entry.operation;
      return (
        operation.kind === 'table-data' &&
        mapping.sourceSchema === operation.table.schema &&
        mapping.action === 'omit'
      );
    })
  ) {
    return 'The source schema is omitted by restore mapping.';
  }
  if (
    entry.operation.kind === 'sequence-state' &&
    options.schemaMappings.some((mapping) => {
      const operation = entry.operation;
      return (
        operation.kind === 'sequence-state' &&
        mapping.sourceSchema === operation.schema &&
        mapping.action === 'omit'
      );
    })
  ) {
    return 'The source sequence schema is omitted by restore mapping.';
  }
  return undefined;
}

function orderEntries(entries: readonly RestoreArchiveEntry[]): readonly RestoreArchiveEntry[] {
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  const remaining = new Map(
    entries.map((entry) => [
      entry.entryId,
      entry.dependencyEntryIds.filter((dependency) => byId.has(dependency)).length,
    ]),
  );
  const dependents = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const dependency of entry.dependencyEntryIds) {
      const values = dependents.get(dependency) ?? new Set<string>();
      values.add(entry.entryId);
      dependents.set(dependency, values);
    }
  }
  const compare = (left: RestoreArchiveEntry, right: RestoreArchiveEntry): number => {
    const phase =
      restorePhasePriority(restorePhaseForEntry(left)) -
      restorePhasePriority(restorePhaseForEntry(right));
    if (phase !== 0) return phase;
    const objectType =
      archiveObjectPriority(left.objectType) - archiveObjectPriority(right.objectType);
    if (objectType !== 0) return objectType;
    const identity = left.archiveIdentity.localeCompare(right.archiveIdentity);
    return identity !== 0 ? identity : left.entryId.localeCompare(right.entryId);
  };
  const available = entries.filter((entry) => remaining.get(entry.entryId) === 0).sort(compare);
  const ordered: RestoreArchiveEntry[] = [];
  while (available.length > 0) {
    const entry = available.shift()!;
    ordered.push(entry);
    for (const dependentId of dependents.get(entry.entryId) ?? []) {
      const count = (remaining.get(dependentId) ?? 0) - 1;
      remaining.set(dependentId, count);
      if (count === 0) {
        available.push(byId.get(dependentId)!);
        available.sort(compare);
      }
    }
  }
  if (ordered.length !== entries.length) {
    throw new RestorePlanningError('Cannot create a restore plan from a cyclic archive.');
  }
  return ordered;
}

function orderDropConflicts(
  conflicts: readonly RestoreExistingObjectConflict[],
  target: RestoreTargetSnapshot,
  archivePosition: ReadonlyMap<string, number>,
): readonly RestoreExistingObjectConflict[] {
  const byOid = new Map(
    conflicts.flatMap((conflict) =>
      conflict.existing.catalogOid === undefined
        ? []
        : [[conflict.existing.catalogOid, conflict] as const],
    ),
  );
  const dependents = new Map<number, Set<number>>();
  for (const dependency of target.objectDependencies ?? []) {
    const referenced = dependency.referenced.catalogOid;
    const dependent = dependency.dependent.catalogOid;
    if (
      referenced === undefined ||
      dependent === undefined ||
      !byOid.has(referenced) ||
      !byOid.has(dependent)
    ) {
      continue;
    }
    const values = dependents.get(referenced) ?? new Set<number>();
    values.add(dependent);
    dependents.set(referenced, values);
  }
  const ordered: RestoreExistingObjectConflict[] = [];
  const visited = new Set<RestoreExistingObjectConflict>();
  const visiting = new Set<RestoreExistingObjectConflict>();
  const visit = (conflict: RestoreExistingObjectConflict): void => {
    if (visited.has(conflict)) return;
    if (visiting.has(conflict)) {
      throw new RestorePlanningError('Target dependency cycle prevents a safe clean order.');
    }
    visiting.add(conflict);
    const oid = conflict.existing.catalogOid;
    const childConflicts =
      oid === undefined
        ? []
        : [...(dependents.get(oid) ?? [])].flatMap((value) => {
            const item = byOid.get(value);
            return item === undefined ? [] : [item];
          });
    childConflicts
      .sort((left, right) => left.mappedTargetIdentity.localeCompare(right.mappedTargetIdentity))
      .forEach(visit);
    visiting.delete(conflict);
    visited.add(conflict);
    ordered.push(conflict);
  };
  [...conflicts]
    .sort(
      (left, right) =>
        (archivePosition.get(right.archiveEntryId) ?? 0) -
          (archivePosition.get(left.archiveEntryId) ?? 0) ||
        left.mappedTargetIdentity.localeCompare(right.mappedTargetIdentity),
    )
    .forEach(visit);
  return ordered;
}

function operationStep(
  archiveId: string,
  entry: RestoreArchiveEntry,
  dependencyStepIds: readonly string[],
  skipReason: string | undefined,
  preflight: RestorePreflightReport,
  options: RestoreOptions,
  skipSatisfiesDependencies = false,
  isReplacement = false,
): RestorePlanStep {
  const phase = restorePhaseForEntry(entry);
  const base = {
    archiveEntryId: entry.entryId,
    ...(entry.objectIdentity === undefined ? {} : { objectIdentity: entry.objectIdentity }),
    archiveObjectType: entry.objectType,
    phase,
    dependencyStepIds,
    transactionRequirement: entry.operation.transactionRequirement,
    privilegeRequirements:
      entry.operation.kind === 'table-data' || entry.operation.kind === 'sequence-state'
        ? []
        : entry.operation.privilegeRequirements,
    description: entry.description,
  };
  if (skipReason !== undefined) {
    return {
      ...base,
      kind: 'skip-entry',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'skip-entry'),
      reason: skipReason,
      ...(skipSatisfiesDependencies ? { satisfiesDependencies: true } : {}),
    };
  }
  const role = (name: string): RestoreRoleResolution =>
    resolveRestoreRole(name, {
      target: preflight.target,
      mappings: options.roleMappings,
      missingRolePolicy: options.missingRolePolicy,
    });
  const usable = (resolution: RestoreRoleResolution): boolean =>
    resolution.status !== 'omitted' && resolution.status !== 'unresolved';
  const grantorPolicyFor = (
    grantor: RestoreRoleResolution | undefined,
  ): RestoreOptions['grantorPolicy'] => {
    if (
      options.grantorPolicy !== 'preserve-when-possible' ||
      grantor === undefined ||
      !('targetRole' in grantor) ||
      grantor.targetRole === preflight.target.currentUser.name ||
      preflight.target.currentUser.superuser ||
      (preflight.target.setRoleTargets ?? []).includes(grantor.targetRole)
    ) {
      return options.grantorPolicy;
    }
    return options.privilegesMode === 'best-effort' ? 'use-current-user' : options.grantorPolicy;
  };
  const roleSkip = (resolutions: readonly RestoreRoleResolution[]): RestorePlanStep | undefined => {
    const invalid = resolutions.find((item) => !usable(item));
    if (invalid === undefined) return undefined;
    if (invalid.status === 'unresolved') {
      throw new RestorePlanningError(`Restore role ${invalid.sourceRole} could not be resolved.`);
    }
    return {
      ...base,
      kind: 'skip-entry',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'skip-entry'),
      reason: 'reason' in invalid ? invalid.reason : 'Role resolution was omitted.',
    };
  };
  if (entry.operation.kind === 'ownership') {
    const owner =
      options.ownershipMode === 'current-user'
        ? role(preflight.target.currentUser.name)
        : role(entry.operation.owner);
    const skipped = roleSkip([owner]);
    if (skipped !== undefined) return skipped;
    const rendered = buildOwnershipSql(entry.operation, owner);
    return {
      ...base,
      kind: 'restore-ownership',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'restore-ownership'),
      ...rendered,
    };
  }
  if (entry.operation.kind === 'comment') {
    return {
      ...base,
      kind: 'apply-comment',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'apply-comment'),
      ...buildCommentSql(entry.operation),
    };
  }
  if (entry.operation.kind === 'acl') {
    const grantee = role(entry.operation.grantee);
    const grantor =
      entry.operation.grantor === undefined ? undefined : role(entry.operation.grantor);
    const skipped = roleSkip(grantor === undefined ? [grantee] : [grantee, grantor]);
    if (skipped !== undefined) return skipped;
    const rendered = buildAclSql(entry.operation, grantee, grantor, grantorPolicyFor(grantor));
    return {
      ...base,
      kind: 'apply-acl',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'apply-acl'),
      ...rendered,
      aclAction: entry.operation.action ?? 'grant',
    };
  }
  if (entry.operation.kind === 'default-privilege') {
    const owner = role(entry.operation.owner);
    const grantee = role(entry.operation.grantee);
    const grantor =
      entry.operation.grantor === undefined ? undefined : role(entry.operation.grantor);
    const skipped = roleSkip(grantor === undefined ? [owner, grantee] : [owner, grantee, grantor]);
    if (skipped !== undefined) return skipped;
    const rendered = buildDefaultPrivilegeSql(
      entry.operation,
      owner,
      grantee,
      grantor,
      grantorPolicyFor(grantor ?? owner),
    );
    return {
      ...base,
      kind: 'apply-default-privilege',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'apply-default-privilege'),
      ...rendered,
      aclAction: entry.operation.action ?? 'grant',
    };
  }
  if (entry.operation.kind === 'sql') {
    return {
      ...base,
      kind: 'execute-sql',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'execute-sql'),
      operation: entry.operation,
      ...(isReplacement ? { replacement: true } : {}),
    };
  }
  if (entry.operation.kind === 'sequence-state') {
    return {
      ...base,
      kind: 'restore-sequence-state',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'restore-sequence-state'),
      operation: entry.operation,
    };
  }
  return {
    ...base,
    kind: 'load-table-data',
    stepId: createRestoreStepId(archiveId, entry.entryId, 'load-table-data'),
    operation: entry.operation,
  };
}

function transactionStep(
  archiveId: string,
  archiveEntryId: string,
  kind: 'begin-transaction' | 'commit-transaction',
  phase: RestorePlanStep['phase'],
  occurrence: number,
  dependencyStepIds: readonly string[],
): RestorePlanStep {
  return {
    kind,
    stepId: createRestoreStepId(archiveId, archiveEntryId, kind, occurrence),
    archiveEntryId,
    phase,
    dependencyStepIds,
    transactionRequirement: 'forbidden',
    privilegeRequirements: [],
    description:
      kind === 'begin-transaction' ? 'Begin restore transaction.' : 'Commit restore transaction.',
  };
}

export function validateRestorePlan(steps: readonly RestorePlanStep[]): void {
  const positions = new Map(steps.map((step, index) => [step.stepId, index]));
  for (const [index, step] of steps.entries()) {
    for (const dependency of step.dependencyStepIds) {
      const dependencyIndex = positions.get(dependency);
      if (dependencyIndex === undefined) {
        throw new RestorePlanningError(
          `Restore plan step ${step.stepId} references a missing dependency.`,
        );
      }
      if (dependencyIndex >= index) {
        throw new RestorePlanningError(
          `Restore plan step ${step.stepId} executes before one of its dependencies.`,
        );
      }
    }
    if (
      step.kind === 'load-table-data' &&
      step.operation.generatedColumns?.some((column) => step.operation.columns.includes(column)) ===
        true
    ) {
      throw new RestorePlanningError(
        `Restore plan step ${step.stepId} includes a generated column in COPY input.`,
      );
    }
    if (
      step.kind === 'restore-sequence-state' &&
      restorePhasePriority(step.phase) <= restorePhasePriority('table-data')
    ) {
      throw new RestorePlanningError(
        `Sequence-state step ${step.stepId} is not ordered after table data.`,
      );
    }
    if (
      step.archiveObjectType === 'foreign-key' &&
      restorePhasePriority(step.phase) < restorePhasePriority('post-data')
    ) {
      throw new RestorePlanningError(
        `Foreign-key step ${step.stepId} must execute after table data.`,
      );
    }
    if (step.kind === 'drop-object') {
      if (step.phase !== 'clean' || /\bCASCADE\b/iu.test(step.sql)) {
        throw new RestorePlanningError(
          `Clean step ${step.stepId} is outside clean phase or requires implicit CASCADE.`,
        );
      }
    }
    if (
      step.kind === 'load-table-data' &&
      steps.some(
        (candidate, candidateIndex) =>
          candidateIndex > index &&
          (candidate.kind === 'drop-object' || candidate.kind === 'truncate-table'),
      )
    ) {
      throw new RestorePlanningError('A destructive clean step is ordered after table data.');
    }
  }
}

export class RestorePlanner {
  createPlan(
    metadata: RestoreArchiveMetadata,
    entries: readonly RestoreArchiveEntry[],
    preflight: RestorePreflightReport,
    options: RestoreOptions,
  ): RestorePlan {
    if (!preflight.canProceed) {
      throw new RestorePlanningError('Restore preflight contains blocking diagnostics.');
    }
    const ordered = orderEntries(entries);
    const mappingContext = {
      options,
      availableSchemas: new Set(preflight.target.schemas),
      availableTablespaces: new Set(preflight.target.tablespaces),
      protectedSchemas: new Set(preflight.target.extensionSchemas ?? []),
    };
    const cleanRequested =
      options.cleanMode !== 'none' ||
      options.existingObjectPolicy === 'clean' ||
      options.existingObjectPolicy === 'clean-selected';
    const dropConflicts = preflight.conflicts.filter((conflict) => {
      if (cleanRequested) return true;
      if (options.existingObjectPolicy !== 'replace-safe') return false;
      const entry = entries.find((candidate) => candidate.entryId === conflict.archiveEntryId);
      return (
        entry?.operation.kind === 'sql' && entry.operation.replaceStrategy === 'drop-and-recreate'
      );
    });
    const orderPosition = new Map(ordered.map((entry, index) => [entry.entryId, index]));
    const orderedDrops = orderDropConflicts(dropConflicts, preflight.target, orderPosition);
    const cleanSteps: RestorePlanStep[] = [];
    let priorCleanStepId: string | undefined;
    for (const [index, conflict] of orderedDrops.entries()) {
      const stepId = createRestoreStepId(
        metadata.archiveId,
        conflict.archiveEntryId,
        'drop-object',
        index,
      );
      cleanSteps.push({
        kind: 'drop-object',
        stepId,
        archiveEntryId: conflict.archiveEntryId,
        objectIdentity: conflict.mappedTargetIdentity,
        ...(entries.find((entry) => entry.entryId === conflict.archiveEntryId)?.objectType ===
        undefined
          ? {}
          : {
              archiveObjectType: entries.find((entry) => entry.entryId === conflict.archiveEntryId)!
                .objectType,
            }),
        phase: 'clean',
        dependencyStepIds: priorCleanStepId === undefined ? [] : [priorCleanStepId],
        transactionRequirement: 'allowed',
        privilegeRequirements: ['ownership of target object'],
        description: `Drop conflicting target ${conflict.mappedTargetIdentity}.`,
        target: conflict.target,
        sql: buildRestoreDropSql(conflict.target),
        destructiveImpact: 'selected-object',
        reason: 'Selected target conflicts with the mapped archive identity.',
        relatedArchiveEntryIds: [conflict.archiveEntryId],
      });
      priorCleanStepId = stepId;
    }
    const entryStepIds = new Map<string, string>();
    const operationSteps: RestorePlanStep[] = [...cleanSteps];
    const conflictByEntry = new Map(
      preflight.conflicts.map((conflict) => [conflict.archiveEntryId, conflict]),
    );
    const conflictingTableIdentities = new Set(
      preflight.conflicts
        .filter((conflict) => conflict.target.kind === 'table')
        .map((conflict) => restoreTargetIdentity(conflict.target)),
    );
    let auxiliaryOccurrence = 0;
    for (const originalEntry of ordered) {
      const mappedEntry = mapRestoreArchiveEntry(originalEntry, mappingContext);
      const entry = mappedEntry ?? originalEntry;
      const dependencies = entry.dependencyEntryIds.flatMap((id) => {
        const stepId = entryStepIds.get(id);
        return stepId === undefined ? [] : [stepId];
      });
      const conflict = conflictByEntry.get(entry.entryId);
      let skipReason = shouldSkip(entry, options);
      let skipSatisfiesDependencies = false;
      let isReplacement = false;
      let appendData = false;
      let effectiveEntry = entry;
      if (mappedEntry === undefined) {
        skipReason = 'The entry is omitted by schema or tablespace mapping.';
      } else if (conflict !== undefined && options.existingObjectPolicy === 'skip') {
        skipReason = 'A compatible existing target object is preserved by skip policy.';
        skipSatisfiesDependencies = conflict.compatibility === 'compatible';
      } else if (
        conflict !== undefined &&
        options.existingObjectPolicy === 'replace-safe' &&
        entry.operation.kind === 'sql' &&
        entry.operation.replaceStrategy === 'create-or-replace' &&
        entry.operation.replacementSql !== undefined
      ) {
        effectiveEntry = {
          ...entry,
          operation: { ...entry.operation, sql: entry.operation.replacementSql },
        };
        isReplacement = true;
      }
      if (entry.operation.kind === 'table-data') {
        const identity = restoreTargetIdentity({
          kind: 'table',
          schema: entry.operation.table.schema,
          name: entry.operation.table.table,
        });
        if (conflictingTableIdentities.has(identity) && !cleanRequested) {
          if (options.existingTableDataPolicy === 'skip-data') {
            skipReason = 'Existing-table data is preserved by skip-data policy.';
          } else if (options.existingTableDataPolicy === 'truncate') {
            const sql = `TRUNCATE TABLE ${quoteQualifiedIdentifier(
              [entry.operation.table.schema, entry.operation.table.table],
              { quoteAllIdentifiers: true },
            )}`;
            const truncateStep: RestorePlanStep = {
              kind: 'truncate-table',
              stepId: createRestoreStepId(
                metadata.archiveId,
                entry.entryId,
                'truncate-table',
                auxiliaryOccurrence++,
              ),
              archiveEntryId: entry.entryId,
              objectIdentity: identity,
              archiveObjectType: entry.objectType,
              phase: 'clean',
              dependencyStepIds: priorCleanStepId === undefined ? [] : [priorCleanStepId],
              transactionRequirement: 'allowed',
              privilegeRequirements: ['TRUNCATE on target table'],
              description: `Truncate existing target table ${identity}.`,
              table: entry.operation.table,
              sql,
            };
            operationSteps.push(truncateStep);
            priorCleanStepId = truncateStep.stepId;
          } else if (options.existingTableDataPolicy === 'fail-if-not-empty') {
            const assertion: RestorePlanStep = {
              kind: 'assert-table-empty',
              stepId: createRestoreStepId(
                metadata.archiveId,
                entry.entryId,
                'assert-table-empty',
                auxiliaryOccurrence++,
              ),
              archiveEntryId: entry.entryId,
              objectIdentity: identity,
              archiveObjectType: entry.objectType,
              phase: 'table-data',
              dependencyStepIds: [...dependencies],
              transactionRequirement: 'allowed',
              privilegeRequirements: ['SELECT on target table'],
              description: `Assert existing target table ${identity} is empty.`,
              table: entry.operation.table,
              sql: `SELECT NOT EXISTS (SELECT 1 FROM ${quoteQualifiedIdentifier(
                [entry.operation.table.schema, entry.operation.table.table],
                { quoteAllIdentifiers: true },
              )} LIMIT 1) AS empty`,
            };
            operationSteps.push(assertion);
            dependencies.splice(0, dependencies.length, assertion.stepId);
          } else if (options.existingTableDataPolicy === 'append') {
            appendData = true;
          }
        }
      }
      if (entry.operation.kind === 'sequence-state') {
        const sequenceOperation = entry.operation;
        if (
          options.existingSequenceStatePolicy === 'preserve-target' &&
          preflight.target.objects?.some(
            (object) =>
              object.kind === 'sequence' &&
              object.schema === sequenceOperation.schema &&
              object.name === sequenceOperation.sequence,
          )
        ) {
          skipReason = 'Existing sequence state is preserved by policy.';
        }
      }
      let step = operationStep(
        metadata.archiveId,
        effectiveEntry,
        dependencies,
        skipReason,
        preflight,
        options,
        skipSatisfiesDependencies,
        isReplacement,
      );
      if (step.kind === 'load-table-data' && appendData) {
        step = { ...step, dataDisposition: 'append' };
      }
      entryStepIds.set(entry.entryId, step.stepId);
      operationSteps.push(step);
    }
    operationSteps.sort(
      (left, right) => restorePhasePriority(left.phase) - restorePhasePriority(right.phase),
    );
    const steps = this.applyTransactions(metadata.archiveId, operationSteps, options);
    validateRestorePlan(steps);
    return {
      metadata: {
        planId: createRestoreStepId(metadata.archiveId, 'plan', 'emit-diagnostic'),
        archiveId: metadata.archiveId,
        archiveMetadata: metadata,
        targetVersion: preflight.target.version,
        transactionMode: options.transactionMode,
        createdAt: new Date().toISOString(),
      },
      steps,
      diagnostics: [...preflight.diagnostics],
    };
  }

  private applyTransactions(
    archiveId: string,
    operationSteps: readonly RestorePlanStep[],
    options: RestoreOptions,
  ): readonly RestorePlanStep[] {
    if (options.transactionMode === 'none') return operationSteps;
    if (options.transactionMode === 'single') {
      if (operationSteps.length === 0) return [];
      const first = operationSteps[0]!;
      const begin = transactionStep(
        archiveId,
        first.archiveEntryId,
        'begin-transaction',
        first.phase,
        0,
        [],
      );
      const adjusted = operationSteps.map((step, index) => ({
        ...step,
        dependencyStepIds:
          index === 0 ? [...step.dependencyStepIds, begin.stepId] : step.dependencyStepIds,
      }));
      const commit = transactionStep(
        archiveId,
        operationSteps.at(-1)!.archiveEntryId,
        'commit-transaction',
        'finalization',
        0,
        [adjusted.at(-1)!.stepId],
      );
      return [begin, ...adjusted, commit];
    }
    if (options.transactionMode === 'entry') {
      const result: RestorePlanStep[] = [];
      let occurrence = 0;
      for (const step of operationSteps) {
        if (step.kind === 'skip-entry' || step.transactionRequirement === 'forbidden') {
          result.push(step);
          continue;
        }
        const begin = transactionStep(
          archiveId,
          step.archiveEntryId,
          'begin-transaction',
          step.phase,
          occurrence,
          step.dependencyStepIds,
        );
        const adjusted = { ...step, dependencyStepIds: [begin.stepId] };
        const commit = transactionStep(
          archiveId,
          step.archiveEntryId,
          'commit-transaction',
          step.phase,
          occurrence,
          [adjusted.stepId],
        );
        result.push(begin, adjusted, commit);
        occurrence += 1;
      }
      return result;
    }

    const result: RestorePlanStep[] = [];
    let occurrence = 0;
    for (const phase of RESTORE_EXECUTION_PHASES) {
      const phaseSteps = operationSteps.filter((step) => step.phase === phase);
      let transaction: RestorePlanStep | undefined;
      for (const step of phaseSteps) {
        if (step.kind === 'skip-entry' || step.transactionRequirement === 'forbidden') {
          if (transaction !== undefined) {
            result.push(
              transactionStep(
                archiveId,
                transaction.archiveEntryId,
                'commit-transaction',
                phase,
                occurrence,
                [result.at(-1)!.stepId],
              ),
            );
            transaction = undefined;
            occurrence += 1;
          }
          result.push(step);
          continue;
        }
        if (transaction === undefined) {
          transaction = transactionStep(
            archiveId,
            step.archiveEntryId,
            'begin-transaction',
            phase,
            occurrence,
            step.dependencyStepIds,
          );
          result.push(transaction);
        }
        result.push({ ...step, dependencyStepIds: [result.at(-1)!.stepId] });
      }
      if (transaction !== undefined) {
        result.push(
          transactionStep(
            archiveId,
            transaction.archiveEntryId,
            'commit-transaction',
            phase,
            occurrence,
            [result.at(-1)!.stepId],
          ),
        );
        occurrence += 1;
      }
    }
    return result;
  }
}
