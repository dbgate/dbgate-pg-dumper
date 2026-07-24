import { createHash } from 'node:crypto';

import type { DumpSection } from '../archive/ArchiveTypes.js';
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
  if (entry.operation.kind === 'sequence-state') return 'sequence-restoration';
  const phases: Readonly<Record<DumpSection, RestorePhase>> = {
    'pre-data': 'pre-data',
    data: 'data',
    'post-data': 'post-data',
  };
  return phases[entry.section];
}
