import { createHash } from 'node:crypto';

import type { ArchiveObjectType, DumpSection } from '../archive/ArchiveTypes.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import type {
  RestoreArchiveEntry,
  RestoreArchiveMetadata,
  RestoreDataOperation,
  RestoreSequenceStateOperation,
  RestoreSqlOperation,
  RestoreTransactionRequirement,
} from './RestoreArchive.js';
import type { RestoreDiagnostic, RestorePhase, RestoreTransactionMode } from './RestoreTypes.js';

export interface RestorePlanMetadata {
  readonly planId: string;
  readonly archiveId: string;
  readonly archiveMetadata: RestoreArchiveMetadata;
  readonly targetVersion: PostgresVersion;
  readonly transactionMode: RestoreTransactionMode;
  readonly createdAt: string;
}

export interface RestorePlanStepBase {
  readonly stepId: string;
  readonly archiveEntryId: string;
  readonly objectIdentity?: string;
  readonly archiveObjectType?: ArchiveObjectType;
  readonly phase: RestorePhase;
  readonly dependencyStepIds: readonly string[];
  readonly transactionRequirement: RestoreTransactionRequirement;
  readonly privilegeRequirements: readonly string[];
  readonly description: string;
}

export interface RestoreExecuteSqlStep extends RestorePlanStepBase {
  readonly kind: 'execute-sql';
  readonly operation: RestoreSqlOperation;
}

export interface RestoreLoadDataStep extends RestorePlanStepBase {
  readonly kind: 'load-table-data';
  readonly operation: RestoreDataOperation;
}

export interface RestoreSequenceStateStep extends RestorePlanStepBase {
  readonly kind: 'restore-sequence-state';
  readonly operation: RestoreSequenceStateOperation;
}

export interface RestoreTransactionStep extends RestorePlanStepBase {
  readonly kind: 'begin-transaction' | 'commit-transaction' | 'rollback-transaction';
}

export interface RestoreValidationStep extends RestorePlanStepBase {
  readonly kind: 'validate-object';
  readonly validation: 'exists' | 'row-count' | 'sequence-state' | 'checksum';
}

export interface RestoreSkipStep extends RestorePlanStepBase {
  readonly kind: 'skip-entry';
  readonly reason: string;
}

export interface RestoreDiagnosticStep extends RestorePlanStepBase {
  readonly kind: 'emit-diagnostic';
  readonly diagnostic: RestoreDiagnostic;
}

export type RestorePlanStep =
  | RestoreExecuteSqlStep
  | RestoreLoadDataStep
  | RestoreSequenceStateStep
  | RestoreTransactionStep
  | RestoreValidationStep
  | RestoreSkipStep
  | RestoreDiagnosticStep;

export interface RestorePlan {
  readonly metadata: RestorePlanMetadata;
  readonly steps: readonly RestorePlanStep[];
  readonly diagnostics: readonly RestoreDiagnostic[];
}

export function createRestoreStepId(
  archiveId: string,
  archiveEntryId: string,
  kind: RestorePlanStep['kind'],
  occurrence = 0,
): string {
  const identity = `${archiveId}\0${archiveEntryId}\0${kind}\0${String(occurrence)}`;
  return `r_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

export function restorePhaseForEntry(entry: RestoreArchiveEntry): RestorePhase {
  if (entry.operation.kind === 'sequence-state') return 'sequence-state';
  if (entry.objectType === 'table-data' || entry.objectType === 'materialized-view-data') {
    return 'table-data';
  }
  if (entry.objectType === 'ownership' || entry.objectType === 'sequence-ownership') {
    return 'ownership';
  }
  if (entry.objectType === 'comment') return 'comments';
  if (entry.objectType === 'acl' || entry.objectType === 'default-privilege') {
    return 'privileges';
  }
  const phases: Readonly<Record<DumpSection, RestorePhase>> = {
    'pre-data': 'pre-data',
    data: 'table-data',
    'post-data': 'post-data',
  };
  return phases[entry.section];
}

export const RESTORE_EXECUTION_PHASES = [
  'pre-data',
  'table-data',
  'sequence-state',
  'post-data',
  'ownership',
  'comments',
  'privileges',
] as const satisfies readonly RestorePhase[];

export function restorePhasePriority(phase: RestorePhase): number {
  const priorities: Readonly<Partial<Record<RestorePhase, number>>> = {
    initialization: 0,
    'archive-validation': 1,
    'target-inspection': 2,
    preflight: 3,
    planning: 4,
    'pre-data': 10,
    data: 20,
    'table-data': 20,
    'sequence-restoration': 30,
    'sequence-state': 30,
    'post-data': 40,
    ownership: 50,
    comments: 60,
    privileges: 70,
    finalization: 80,
    validation: 90,
    completion: 100,
  };
  return priorities[phase] ?? 100;
}
