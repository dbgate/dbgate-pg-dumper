import type { PostgresConnectionInput } from '../connection/PostgresConnection.js';
import type { SensitiveValuePolicy } from '../security/SensitiveValuePolicy.js';
import type { UnsupportedObjectPolicy } from '../preflight/PreflightTypes.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import type { RestoreArchiveMetadata, RestoreArchiveSource } from './RestoreArchive.js';

export type RestoreTransactionMode = 'single' | 'section' | 'entry' | 'none';
export type RestoreErrorMode = 'stop' | 'continue';
export type RestoreCleanMode = 'none' | 'selected';
export type RestoreOwnershipMode = 'skip' | 'preserve';
export type RestorePrivilegesMode = 'preserve' | 'skip';
export type RestoreCommentsMode = 'preserve' | 'skip';
export type RestoreRowSecurityMode = 'normal' | 'replica-role';
export type RestoreIdentityMode = 'preserve' | 'generate';
export type RestoreForeignTableDataMode = 'skip' | 'require';
export type RestoreExistingObjectPolicy = 'fail' | 'skip' | 'replace' | 'clean-selected';
export type RestoreValidationLevel = 'none' | 'basic' | 'structure' | 'structure-and-data';

export type RestorePhase =
  | 'initialization'
  | 'archive-validation'
  | 'target-inspection'
  | 'preflight'
  | 'planning'
  | 'pre-data'
  | 'data'
  | 'sequence-restoration'
  | 'post-data'
  | 'finalization'
  | 'validation'
  | 'completion';

export interface RestoreRoleMapping {
  readonly kind: 'role';
  readonly sourceRole: string;
  readonly action: 'map' | 'omit';
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
  readonly rowSecurityMode: RestoreRowSecurityMode;
  readonly identityMode: RestoreIdentityMode;
  readonly foreignTableDataMode: RestoreForeignTableDataMode;
  readonly existingObjectPolicy: RestoreExistingObjectPolicy;
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
  rowSecurityMode: 'normal',
  identityMode: 'preserve',
  foreignTableDataMode: 'skip',
  existingObjectPolicy: 'fail',
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
  | 'dangerous-operation'
  | 'unsupported-operation'
  | 'mapping-unresolved'
  | 'mapping-not-implemented'
  | 'secret-rejected'
  | 'step-failed'
  | 'step-skipped'
  | 'validation-incomplete'
  | 'cleanup-failed';

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
  readonly diagnostics: readonly RestoreDiagnostic[];
  readonly validation: RestoreValidationSummary;
  readonly partialStateMayRemain: boolean;
}
