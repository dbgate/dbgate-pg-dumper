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
export type RestoreValidationLevel = 'none' | 'basic' | 'structure' | 'structure-and-data' | 'full';
export type ValidationFailureMode = 'fail-restore' | 'report-partial' | 'warn-only';
export type RowCountValidationMode = 'none' | 'archive-metadata' | 'exact';
export type ChecksumValidationMode = 'none' | 'archive-payload' | 'canonical-table-data';
export type SequenceValidationMode = 'none' | 'archive-state';
export type UnorderedTableValidationPolicy =
  'row-count-only' | 'multiset-checksum' | 'skip-with-warning' | 'error';
export type RestoreValidationStatus =
  'not-run' | 'passed' | 'passed-with-warnings' | 'failed' | 'cancelled';
export type RestoreConfidence = 'unverified' | 'low' | 'medium' | 'high';
export type RestoreValidationCheckStatus =
  'passed' | 'failed' | 'warning' | 'skipped' | 'unavailable' | 'cancelled';
export type RestoreValidationCheckType =
  | 'connection-health'
  | 'object-existence'
  | 'object-structure'
  | 'row-count'
  | 'checksum'
  | 'sequence-state'
  | 'policy';

export interface ValidationSamplePolicy {
  readonly mode: 'none' | 'fixed-count' | 'percentage';
  readonly value?: number;
  readonly seed?: string;
}

export interface RestoreValidationOptions {
  readonly level: RestoreValidationLevel;
  readonly failureMode: ValidationFailureMode;
  readonly rowCountMode: RowCountValidationMode;
  readonly checksumMode: ChecksumValidationMode;
  readonly sequenceMode: SequenceValidationMode;
  readonly compareOwnership: boolean;
  readonly compareComments: boolean;
  readonly comparePrivileges: boolean;
  readonly compareTablespaces: boolean;
  readonly compareStatistics: boolean;
  readonly unorderedTablePolicy: UnorderedTableValidationPolicy;
  readonly sample: ValidationSamplePolicy;
  readonly concurrency: number;
}

export const DEFAULT_RESTORE_VALIDATION_OPTIONS: RestoreValidationOptions = {
  level: 'basic',
  failureMode: 'fail-restore',
  rowCountMode: 'none',
  checksumMode: 'none',
  sequenceMode: 'archive-state',
  compareOwnership: false,
  compareComments: false,
  comparePrivileges: false,
  compareTablespaces: true,
  compareStatistics: false,
  unorderedTablePolicy: 'skip-with-warning',
  sample: { mode: 'none' },
  concurrency: 1,
};

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
  readonly validation: RestoreValidationOptions;
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
  validation: DEFAULT_RESTORE_VALIDATION_OPTIONS,
  preflightOnly: false,
  roleMappings: [],
  schemaMappings: [],
  tablespaceMappings: [],
  secretPolicy: { mode: 'omit' },
};

export type RestoreOptionsInput = Partial<Omit<RestoreOptions, 'validation'>> & {
  readonly validation?: Partial<RestoreValidationOptions>;
};

export function normalizeRestoreOptions(options: RestoreOptionsInput = {}): RestoreOptions {
  const requestedValidationConcurrency =
    options.validation?.concurrency ?? DEFAULT_RESTORE_VALIDATION_OPTIONS.concurrency;
  const validation = {
    ...DEFAULT_RESTORE_VALIDATION_OPTIONS,
    ...(options.validation ?? {}),
    level:
      options.validation?.level ??
      options.validationLevel ??
      DEFAULT_RESTORE_VALIDATION_OPTIONS.level,
    sample: {
      ...DEFAULT_RESTORE_VALIDATION_OPTIONS.sample,
      ...(options.validation?.sample ?? {}),
    },
    concurrency: Math.max(
      1,
      Math.min(
        16,
        Number.isFinite(requestedValidationConcurrency)
          ? Math.trunc(requestedValidationConcurrency)
          : DEFAULT_RESTORE_VALIDATION_OPTIONS.concurrency,
      ),
    ),
  };
  return {
    ...DEFAULT_RESTORE_OPTIONS,
    ...options,
    validationLevel: validation.level,
    validation,
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
  | 'validation-object-missing'
  | 'validation-object-kind-mismatch'
  | 'validation-structural-mismatch'
  | 'validation-row-count-mismatch'
  | 'validation-checksum-mismatch'
  | 'validation-sequence-state-mismatch'
  | 'validation-owner-mismatch'
  | 'validation-comment-mismatch'
  | 'validation-acl-mismatch'
  | 'validation-tablespace-mismatch'
  | 'validation-unavailable'
  | 'validation-unstable-row-order'
  | 'validation-sampled'
  | 'validation-query-failed'
  | 'validation-cancelled'
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
  | RestoreValidationProgress
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

export interface RestoreValidationProgress extends RestoreProgressBase {
  readonly event:
    | 'validation-started'
    | 'validation-phase-started'
    | 'validation-object-check-started'
    | 'validation-object-check-completed'
    | 'validation-row-count-started'
    | 'validation-row-count-completed'
    | 'validation-checksum-started'
    | 'validation-checksum-progress'
    | 'validation-checksum-completed'
    | 'validation-sequence-check-completed'
    | 'validation-diagnostic-emitted'
    | 'validation-completed'
    | 'validation-failed'
    | 'validation-cancelled';
  readonly checkId?: string;
  readonly archiveEntryId?: string;
  readonly objectIdentity?: string;
  readonly checksCompleted?: number;
  readonly totalChecks?: number;
  readonly rowsScanned?: string;
  readonly bytesScanned?: string;
  readonly elapsedMilliseconds?: number;
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
  readonly options?: RestoreOptionsInput;
  readonly onProgress?: RestoreProgressCallback;
  readonly onDiagnostic?: RestoreDiagnosticCallback;
  readonly signal?: AbortSignal;
  readonly logger?: RestoreLogger;
}

export interface RestoreValidationCheckResult {
  readonly checkId: string;
  readonly type: RestoreValidationCheckType;
  readonly archiveEntryId?: string;
  readonly targetObjectIdentity?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly status: RestoreValidationCheckStatus;
  readonly durationMilliseconds: number;
  readonly diagnosticCodes: readonly RestoreDiagnosticCode[];
  readonly safeDetails?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RestoreValidationSummary {
  readonly level: RestoreValidationLevel;
  readonly checksRequested: number;
  readonly checksPerformed: number;
  readonly checksPassed: number;
  readonly checksFailed: number;
  readonly checksSkipped: number;
  readonly checksUnavailable: number;
  readonly objectsVerified: number;
  readonly tablesCounted: number;
  readonly tablesChecksummed: number;
  readonly rowsScanned: string;
  readonly bytesScanned: string;
  readonly sequenceStatesVerified: number;
  readonly complete: boolean;
}

export interface RestoreValidationResult {
  readonly status: RestoreValidationStatus;
  readonly level: RestoreValidationLevel;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMilliseconds: number;
  readonly checks: readonly RestoreValidationCheckResult[];
  readonly summary: RestoreValidationSummary;
  readonly confidence: RestoreConfidence;
  readonly diagnostics: readonly RestoreDiagnostic[];
  /** Compatibility projections retained from the former summary-only result. */
  readonly checksPerformed: number;
  readonly checksFailed: number;
  readonly complete: boolean;
}

export interface RestoreValidationRequest {
  readonly archive: RestoreArchiveSource;
  readonly target: PostgresConnectionInput;
  readonly options?: RestoreOptionsInput;
  readonly onProgress?: RestoreProgressCallback;
  readonly onDiagnostic?: RestoreDiagnosticCallback;
  readonly signal?: AbortSignal;
  readonly logger?: RestoreLogger;
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
  readonly validation: RestoreValidationResult;
  readonly partialStateMayRemain: boolean;
}
