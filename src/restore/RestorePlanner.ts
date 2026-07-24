import { dumpSectionPriority } from '../archive/SectionRules.js';
import type { RestoreArchiveEntry, RestoreArchiveMetadata } from './RestoreArchive.js';
import type { RestorePreflightReport } from './RestorePreflight.js';
import {
  createRestoreStepId,
  restorePhaseForEntry,
  type RestorePlan,
  type RestorePlanStep,
} from './RestorePlan.js';
import { RestorePlanningError } from './RestoreErrors.js';
import type { RestoreOptions } from './RestoreTypes.js';

function shouldSkip(entry: RestoreArchiveEntry, options: RestoreOptions): string | undefined {
  if (entry.objectType === 'comment' && options.commentsMode === 'skip') {
    return 'Comments are disabled by restore options.';
  }
  if (entry.objectType === 'ownership' && options.ownershipMode === 'skip') {
    return 'Ownership restoration is disabled by restore options.';
  }
  if (
    (entry.objectType === 'acl' || entry.objectType === 'default-privilege') &&
    options.privilegesMode === 'skip'
  ) {
    return 'Privilege restoration is disabled by restore options.';
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
    const section = dumpSectionPriority(left.section) - dumpSectionPriority(right.section);
    if (section !== 0) return section;
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

function operationStep(
  archiveId: string,
  entry: RestoreArchiveEntry,
  dependencyStepIds: readonly string[],
  skipReason: string | undefined,
): RestorePlanStep {
  const phase = restorePhaseForEntry(entry);
  const base = {
    archiveEntryId: entry.entryId,
    ...(entry.objectIdentity === undefined ? {} : { objectIdentity: entry.objectIdentity }),
    phase,
    dependencyStepIds,
    transactionRequirement: entry.operation.transactionRequirement,
    privilegeRequirements:
      entry.operation.kind === 'sql' ? entry.operation.privilegeRequirements : [],
    description: entry.description,
  };
  if (skipReason !== undefined) {
    return {
      ...base,
      kind: 'skip-entry',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'skip-entry'),
      reason: skipReason,
    };
  }
  if (entry.operation.kind === 'sql') {
    return {
      ...base,
      kind: 'execute-sql',
      stepId: createRestoreStepId(archiveId, entry.entryId, 'execute-sql'),
      operation: entry.operation,
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
    const entryStepIds = new Map<string, string>();
    const operationSteps = ordered.map((entry) => {
      const dependencies = entry.dependencyEntryIds.flatMap((id) => {
        const stepId = entryStepIds.get(id);
        return stepId === undefined ? [] : [stepId];
      });
      const step = operationStep(
        metadata.archiveId,
        entry,
        dependencies,
        shouldSkip(entry, options),
      );
      entryStepIds.set(entry.entryId, step.stepId);
      return step;
    });
    const steps = this.applyTransactions(metadata.archiveId, operationSteps, options);
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
        'pre-data',
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
    for (const phase of ['pre-data', 'data', 'sequence-restoration', 'post-data'] as const) {
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
