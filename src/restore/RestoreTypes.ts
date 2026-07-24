import type { PostgresConnectionInput } from '../connection/PostgresConnection.js';
import type { SensitiveValuePolicy } from '../security/SensitiveValuePolicy.js';
import type { UnsupportedObjectPolicy } from '../preflight/PreflightTypes.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import type { RestoreArchiveMetadata, RestoreArchiveSource } from './RestoreArchive.js';

export type RestoreTransactionMode = 'single' | 'section' | 'entry' | 'none';
export type RestoreErrorMode = 'stop' | 'continue';
export type RestoreCleanMode = 'none' | 'selected' | 'clean';
export type RestoreOwnershipMode = 'skip' | 'omit' | 'preserve' | 'map' | 'current-user';
export type RestorePrivilegesMode = 'preserve' | 'skip' | 'omit' | 'best-effort';
export type RestoreCommentsMode = 'preserve' | 'skip' | 'omit';
export type RestoreMissingRolePolicy = 'error' | 'warn-and-omit' | 'map-to-current-user';
export type RestoreGrantorPolicy =
  'preserve-when-possible' | 'use-current-user' | 'omit-grantor-semantics' | 'error';
export type RestoreRowSecurityMode = 'normal' | 'replica-role';
export type RestoreIdentityMode = 'preserve' | 'generate';
export type RestoreForeignTableDataMode = 'skip' | 'require';
export type RestoreExistingObjectPolicy =
  | 'fail'
  | 'skip'
  | 'clean'
  | 'replace-safe'
  /** @deprecated Use replace-safe. */
  | 'replace'
  /** @deprecated Use clean. */
  | 'clean-selected';
export type RestoreSchemaMappingPolicy = 'preserve' | 'explicit' | 'single-target-schema';
export type RestoreTablespaceMappingPolicy = 'preserve' | 'explicit' | 'omit' | 'default-target';
export type RestoreOpaqueSchemaReferencePolicy = 'warn' | 'error';
export type RestoreCleanScope = 'selected-only' | 'selected-and-owned-dependents';
export type RestoreExistingTableDataPolicy =
  'fail-if-not-empty' | 'append' | 'truncate' | 'skip-data';
export type RestoreExistingSequenceStatePolicy =
  'preserve-archive' | 'preserve-target' | 'advance-to-safe-value' | 'error';
export type RestoreValidationLevel = 'none' | 'basic' | 'structure' | 'structure-and-data';

export type RestorePhase =
  | 'initialization'
  | 'archive-validation'
  | 'target-inspection'
  | 'preflight'
  | 'planning'
  | 'conflict-scan'
  | 'clean'
  | 'pre-data'
  | 'table-data'
  | 'sequence-state'
  | 'data'
  | 'sequence-restoration'
  | 'post-data'
  | 'ownership'
  | 'comments'
  | 'privileges'
  | 'finalization'
  | 'validation'
  | 'completion';

export interface RestoreRoleMapping {
  readonly kind: 'role';
  readonly sourceRole: string;
  readonly action: 'map' | 'omit' | 'preserve' | 'current-user';
  readonly targetRole?: string;
}

export interface RestoreSchemaMapping {
  readonly kind: 'schema';
  readonly sourceSchema: string;
  readonly action: 'map' | 'omit';
  readonly targetSchema?: string;
}

export interface RestoreTablespaceMapping {
  readonly kind: 'tablespace';
  readonly sourceTablespace: string;
  readonly action: 'map' | 'omit';
  readonly targetTablespace?: string;
}

export type RestoreMappingResult =
  | { readonly status: 'unchanged'; readonly source: string; readonly target: string }
  | { readonly status: 'mapped'; readonly source: string; readonly target: string }
  | { readonly status: 'omitted'; readonly source: string }
  | { readonly status: 'unresolved'; readonly source: string };

export interface RestoreOptions {
  readonly transactionMode: RestoreTransactionMode;
  readonly errorMode: RestoreErrorMode;
  readonly cleanMode: RestoreCleanMode;
  readonly ownershipMode: RestoreOwnershipMode;
  readonly privilegesMode: RestorePrivilegesMode;
  readonly commentsMode: RestoreCommentsMode;
  readonly missingRolePolicy: RestoreMissingRolePolicy;
  readonly grantorPolicy: RestoreGrantorPolicy;
  readonly rowSecurityMode: RestoreRowSecurityMode;
  readonly identityMode: RestoreIdentityMode;
  readonly foreignTableDataMode: RestoreForeignTableDataMode;
  readonly existingObjectPolicy: RestoreExistingObjectPolicy;
  readonly schemaMappingPolicy: RestoreSchemaMappingPolicy;
  readonly singleTargetSchema?: string;
  readonly opaqueSchemaReferencePolicy: RestoreOpaqueSchemaReferencePolicy;
  readonly tablespaceMappingPolicy: RestoreTablespaceMappingPolicy;
  readonly cleanScope: RestoreCleanScope;
  readonly existingTableDataPolicy: RestoreExistingTableDataPolicy;
  readonly existingSequenceStatePolicy: RestoreExistingSequenceStatePolicy;
  readonly unsupportedObjectPolicy: UnsupportedObjectPolicy;
  readonly validationLevel: RestoreValidationLevel;
  readonly preflightOnly: boolean;
  readonly roleMappings: readonly RestoreRoleMapping[];
  readonly schemaMappings: readonly RestoreSchemaMapping[];
  readonly tablespaceMappings: readonly RestoreTablespaceMapping[];
  readonly secretPolicy: SensitiveValuePolicy;
}

export const DEFAULT_RESTORE_OPTIONS: RestoreOptions = {
  transactionMode: 'section',
  errorMode: 'stop',
  cleanMode: 'none',
  ownershipMode: 'skip',
  privilegesMode: 'preserve',
  commentsMode: 'preserve',
  missingRolePolicy: 'error',
  grantorPolicy: 'preserve-when-possible',
  rowSecurityMode: 'normal',
  identityMode: 'preserve',
  foreignTableDataMode: 'skip',
  existingObjectPolicy: 'fail',
  schemaMappingPolicy: 'preserve',
  opaqueSchemaReferencePolicy: 'warn',
  tablespaceMappingPolicy: 'preserve',
  cleanScope: 'selected-only',
  existingTableDataPolicy: 'fail-if-not-empty',
  existingSequenceStatePolicy: 'error',
  unsupportedObjectPolicy: 'error',
  validationLevel: 'basic',
  preflightOnly: false,
  roleMappings: [],
  schemaMappings: [],
  tablespaceMappings: [],
  secretPolicy: { mode: 'omit' },
};

export function normalizeRestoreOptions(options: Partial<RestoreOptions> = {}): RestoreOptions {
  return {
    ...DEFAULT_RESTORE_OPTIONS,
    ...options,
    existingObjectPolicy:
      options.existingObjectPolicy === 'replace'
        ? 'replace-safe'
        : options.existingObjectPolicy === 'clean-selected'
          ? 'clean'
          : (options.existingObjectPolicy ??
            (options.cleanMode !== undefined && options.cleanMode !== 'none'
              ? 'clean'
              : DEFAULT_RESTORE_OPTIONS.existingObjectPolicy)),
    schemaMappingPolicy:
      options.schemaMappingPolicy ??
      ((options.schemaMappings?.length ?? 0) > 0
        ? 'explicit'
        : DEFAULT_RESTORE_OPTIONS.schemaMappingPolicy),
    tablespaceMappingPolicy:
      options.tablespaceMappingPolicy ??
      ((options.tablespaceMappings?.length ?? 0) > 0
        ? 'explicit'
        : DEFAULT_RESTORE_OPTIONS.tablespaceMappingPolicy),
    roleMappings: [...(options.roleMappings ?? DEFAULT_RESTORE_OPTIONS.roleMappings)],
    schemaMappings: [...(options.schemaMappings ?? DEFAULT_RESTORE_OPTIONS.schemaMappings)],
    tablespaceMappings: [
      ...(options.tablespaceMappings ?? DEFAULT_RESTORE_OPTIONS.tablespaceMappings),
    ],
    secretPolicy: {
      ...DEFAULT_RESTORE_OPTIONS.secretPolicy,
      ...(options.secretPolicy ?? {}),
    },
  };
}

export type RestoreDiagnosticSeverity = 'info' | 'warning' | 'error' | 'fatal';

export type RestoreDiagnosticCode =
  | 'archive-invalid'
  | 'archive-dependency-missing'
  | 'archive-dependency-cycle'
  | 'target-version-incompatible'
  | 'required-extension-missing'
  | 'required-role-missing'
  | 'required-tablespace-missing'
  | 'privilege-required'
  | 'transaction-incompatible'
  | 'existing-object-conflict'
  | 'schema-mapping-unresolved'
  | 'schema-mapping-collision'
  | 'unsafe-system-schema-mapping'
  | 'opaque-schema-reference'
  | 'tablespace-unavailable'
  | 'tablespace-omitted'
  | 'unsafe-replacement'
  | 'external-dependent-object'
  | 'clean-requires-cascade'
  | 'non-empty-table'
  | 'incompatible-existing-table'
  | 'append-semantics'
  | 'truncate-blocked'
  | 'sequence-state-conflict'
  | 'destructive-partial-state-risk'
  | 'dangerous-operation'
  | 'unsupported-operation'
  | 'mapping-unresolved'
  | 'mapping-not-implemented'
  | 'secret-rejected'
  | 'step-failed'
  | 'step-skipped'
  | 'validation-incomplete'
  | 'cleanup-failed'
  | 'restore-strategy';

export interface RestoreDiagnostic {
  readonly code: RestoreDiagnosticCode;
  readonly severity: RestoreDiagnosticSeverity;
  readonly phase: RestorePhase;
  readonly archiveEntryId?: string;
  readonly objectIdentity?: string;
  readonly message: string;
  readonly safeDetails?: Readonly<Record<string, string | number | boolean | null>>;
  readonly remediation?: string;
}

export type RestoreProgressEvent =
  | RestoreLifecycleProgress
  | RestorePhaseProgress
  | RestoreStepProgress
  | RestoreCopyProgress
  | RestoreSequenceProgress
  | RestorePostDataObjectProgress
  | RestoreFinalizationProgress
  | RestoreConflictProgress
  | RestoreDiagnosticProgress;

export interface RestoreProgressBase {
  readonly timestamp: string;
  readonly phase: RestorePhase;
}

export interface RestoreLifecycleProgress extends RestoreProgressBase {
  readonly event:
    | 'restore-started'
    | 'archive-validated'
    | 'preflight-started'
    | 'preflight-completed'
    | 'plan-created'
    | 'restore-completed'
    | 'restore-failed'
    | 'restore-cancelled';
  readonly message: string;
  readonly totalSteps?: number;
}

export interface RestorePhaseProgress extends RestoreProgressBase {
  readonly event: 'phase-started' | 'phase-completed';
  readonly message: string;
}

export interface RestoreStepProgress extends RestoreProgressBase {
  readonly event:
    'step-started' | 'step-progress' | 'step-completed' | 'step-failed' | 'step-skipped';
  readonly stepId: string;
  readonly archiveEntryId: string;
  readonly objectIdentity?: string;
  readonly description: string;
  readonly rowsRestored?: number;
  readonly bytesRestored?: number;
  readonly archiveBytesRead?: number;
  readonly copyBytesWritten?: number;
  readonly totalRows?: number;
  readonly totalBytes?: number;
  readonly currentTable?: string;
}

export interface RestoreCopyProgress extends RestoreProgressBase {
  readonly event: 'copy-started' | 'copy-completed';
  readonly stepId: string;
  readonly archiveEntryId: string;
  readonly objectIdentity?: string;
  readonly currentTable: string;
  readonly rowsRestored?: number;
  readonly bytesRestored: number;
  readonly archiveBytesRead: number;
  readonly copyBytesWritten: number;
  readonly totalRows?: number;
  readonly totalBytes?: number;
  readonly durationMilliseconds: number;
}

export interface RestoreSequenceProgress extends RestoreProgressBase {
  readonly event:
    'sequence-restore-started' | 'sequence-restore-completed' | 'sequence-restore-failed';
  readonly stepId: string;
  readonly archiveEntryId: string;
  readonly sequenceIdentity: string;
  readonly lastValue: string;
  readonly isCalled: boolean;
}

export interface RestorePostDataObjectProgress extends RestoreProgressBase {
  readonly event:
    | 'index-creation-started'
    | 'index-creation-completed'
    | 'constraint-creation-started'
    | 'constraint-creation-completed'
    | 'trigger-creation-started'
    | 'trigger-creation-completed';
  readonly stepId: string;
  readonly archiveEntryId: string;
  readonly objectIdentity?: string;
}

export interface RestoreFinalizationProgress extends RestoreProgressBase {
  readonly event:
    | 'ownership-apply-started'
    | 'ownership-apply-completed'
    | 'comment-apply-started'
    | 'comment-apply-completed'
    | 'grant-apply-started'
    | 'grant-apply-completed'
    | 'revoke-apply-started'
    | 'revoke-apply-completed'
    | 'default-privilege-apply-started'
    | 'default-privilege-apply-completed'
    | 'role-switch-started'
    | 'role-switch-completed'
    | 'role-reset-started'
    | 'role-reset-completed';
  readonly stepId: string;
  readonly archiveEntryId: string;
  readonly objectIdentity?: string;
  readonly role?: string;
}

export interface RestoreConflictProgress extends RestoreProgressBase {
  readonly event:
    | 'target-conflict-scan-started'
    | 'target-conflict-scan-completed'
    | 'conflict-detected'
    | 'clean-plan-created'
    | 'object-drop-started'
    | 'object-drop-completed'
    | 'replacement-started'
    | 'replacement-completed'
    | 'table-truncation-started'
    | 'table-truncation-completed'
    | 'schema-mapping-applied'
    | 'tablespace-mapping-applied';
  readonly archiveEntryId?: string;
  readonly stepId?: string;
  readonly objectIdentity?: string;
  readonly sourceName?: string;
  readonly targetName?: string;
}

export interface RestoreDiagnosticProgress extends RestoreProgressBase {
  readonly event: 'diagnostic-emitted';
  readonly diagnostic: RestoreDiagnostic;
}

export type RestoreProgressCallback = (event: RestoreProgressEvent) => void;
export type RestoreDiagnosticCallback = (diagnostic: RestoreDiagnostic) => void;

export interface RestoreLogRecord {
  readonly event: string;
  readonly timestamp: string;
  readonly phase?: RestorePhase;
  readonly stepId?: string;
  readonly archiveEntryId?: string;
  readonly objectIdentity?: string;
  readonly durationMilliseconds?: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RestoreLogger {
  log(record: RestoreLogRecord): void;
}

export interface RestoreRequest {
  readonly archive: RestoreArchiveSource;
  readonly target: PostgresConnectionInput;
  readonly options?: Partial<RestoreOptions>;
  readonly onProgress?: RestoreProgressCallback;
  readonly onDiagnostic?: RestoreDiagnosticCallback;
  readonly signal?: AbortSignal;
  readonly logger?: RestoreLogger;
}

export interface RestoreValidationSummary {
  readonly level: RestoreValidationLevel;
  readonly checksPerformed: number;
  readonly checksFailed: number;
  readonly complete: boolean;
}

export type RestoreStatus = 'success' | 'partial' | 'failed' | 'cancelled' | 'preflight-failed';

export interface RestoreResult {
  readonly status: RestoreStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMilliseconds: number;
  readonly archiveMetadata?: RestoreArchiveMetadata;
  readonly targetVersion?: PostgresVersion;
  readonly executedStepCount: number;
  readonly skippedStepCount: number;
  readonly failedStepCount: number;
  readonly restoredObjectCount: number;
  readonly restoredTableDataCount: number;
  readonly restoredRowCount?: number;
  readonly restoredByteCount?: number;
  readonly tableDataAttemptedCount: number;
  readonly tableDataCompletedCount: number;
  readonly tableDataFailedCount: number;
  readonly copyDurationMilliseconds: number;
  readonly archiveReadDurationMilliseconds: number;
  readonly sequencesAttemptedCount: number;
  readonly sequencesRestoredCount: number;
  readonly sequencesFailedCount: number;
  readonly indexesCreatedCount: number;
  readonly constraintsCreatedCount: number;
  readonly triggersCreatedCount: number;
  readonly policiesCreatedCount: number;
  readonly ownershipStatementsAppliedCount: number;
  readonly ownershipStatementsAttemptedCount: number;
  readonly ownershipStatementsFailedCount: number;
  readonly commentsAppliedCount: number;
  readonly commentsAttemptedCount: number;
  readonly commentsFailedCount: number;
  readonly aclOperationsAppliedCount: number;
  readonly aclGrantOperationsAppliedCount: number;
  readonly aclGrantOperationsAttemptedCount: number;
  readonly aclGrantOperationsFailedCount: number;
  readonly aclRevokeOperationsAppliedCount: number;
  readonly aclRevokeOperationsAttemptedCount: number;
  readonly aclRevokeOperationsFailedCount: number;
  readonly aclOperationsSkippedCount: number;
  readonly defaultPrivilegeOperationsAppliedCount: number;
  readonly defaultPrivilegeOperationsAttemptedCount: number;
  readonly defaultPrivilegeOperationsFailedCount: number;
  readonly unresolvedRoleReferenceCount: number;
  readonly conflictsDetectedCount: number;
  readonly conflictsFailedCount: number;
  readonly objectsDroppedCount: number;
  readonly objectsReplacedCount: number;
  readonly tablesTruncatedCount: number;
  readonly tablesAppendedCount: number;
  readonly schemasRemappedCount: number;
  readonly tablespacesRemappedCount: number;
  readonly externalDependencyBlockCount: number;
  readonly destructiveOperationsCompletedCount: number;
  readonly destructiveOperationsFailedCount: number;
  readonly diagnostics: readonly RestoreDiagnostic[];
  readonly validation: RestoreValidationSummary;
  readonly partialStateMayRemain: boolean;
}
