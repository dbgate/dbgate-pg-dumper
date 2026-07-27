import { redactSensitiveText } from '../security/SensitiveValuePolicy.js';

export type RestoreErrorCode =
  | 'RESTORE_ARCHIVE_INVALID'
  | 'RESTORE_TARGET_INCOMPATIBLE'
  | 'RESTORE_PLANNING_FAILED'
  | 'RESTORE_SQL_FAILED'
  | 'RESTORE_SQL_DUMP_INVALID'
  | 'RESTORE_COPY_FAILED'
  | 'RESTORE_SEQUENCE_FAILED'
  | 'RESTORE_TRANSACTION_FAILED'
  | 'RESTORE_CANCELLED'
  | 'RESTORE_UNSUPPORTED_OBJECT'
  | 'RESTORE_PRIVILEGE_FAILED'
  | 'RESTORE_MAPPING_FAILED'
  | 'RESTORE_VALIDATION_FAILED'
  | 'RESTORE_NOT_IMPLEMENTED'
  | 'RESTORE_SCHEMA_MAPPING_FAILED'
  | 'RESTORE_TABLESPACE_MAPPING_FAILED'
  | 'RESTORE_EXISTING_OBJECT_CONFLICT'
  | 'RESTORE_UNSAFE_CLEAN_PLAN'
  | 'RESTORE_INCOMPATIBLE_REPLACEMENT'
  | 'RESTORE_NON_EMPTY_TABLE'
  | 'RESTORE_EXTERNAL_DEPENDENCY'
  | 'RESTORE_DESTRUCTIVE_OPERATION_FAILED';

export class PostgresRestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(redactSensitiveText(message), options);
    this.name = new.target.name;
  }
}

export class RestoreArchiveValidationError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_ARCHIVE_INVALID', message, options);
  }
}

export class RestoreTargetCompatibilityError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_TARGET_INCOMPATIBLE', message, options);
  }
}

export class RestorePlanningError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_PLANNING_FAILED', message, options);
  }
}

export interface RestoreSqlErrorFields {
  readonly sqlState?: string;
  readonly serverMessage?: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly position?: string;
  readonly schema?: string;
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;
  readonly context?: string;
}

export class RestoreSqlExecutionError extends PostgresRestoreError {
  constructor(
    message: string,
    readonly stepId: string,
    readonly archiveEntryId: string,
    readonly sqlPreview: string,
    readonly fields: RestoreSqlErrorFields = {},
    options?: ErrorOptions,
  ) {
    super('RESTORE_SQL_FAILED', message, options);
  }
}

export class SqlDumpRestoreError extends PostgresRestoreError {
  constructor(
    code: 'RESTORE_SQL_DUMP_INVALID' | 'RESTORE_SQL_FAILED' | 'RESTORE_COPY_FAILED',
    message: string,
    readonly fileOffset: number,
    readonly line: number,
    readonly column: number,
    readonly operationNumber?: number,
    readonly sqlPreview?: string,
    readonly fields: RestoreSqlErrorFields = {},
    options?: ErrorOptions,
  ) {
    super(code, message, options);
  }
}

export class RestoreCopyLoadError extends PostgresRestoreError {
  constructor(
    message: string,
    readonly stepId: string,
    readonly archiveEntryId: string,
    readonly tableIdentity: string,
    readonly copyCommandPreview: string,
    readonly approximateBytes: number,
    readonly approximateRows: number | undefined,
    readonly fields: RestoreSqlErrorFields = {},
    options?: ErrorOptions,
  ) {
    super('RESTORE_COPY_FAILED', message, options);
  }
}

export class RestoreSequenceStateError extends PostgresRestoreError {
  constructor(
    message: string,
    readonly stepId: string,
    readonly archiveEntryId: string,
    readonly sequenceIdentity: string,
    readonly attemptedLastValue: string,
    readonly attemptedIsCalled: boolean,
    readonly phase: 'sequence-state',
    readonly sqlPreview: string,
    readonly fields: RestoreSqlErrorFields = {},
    options?: ErrorOptions,
  ) {
    super('RESTORE_SEQUENCE_FAILED', message, options);
  }
}

export class RestoreTransactionError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_TRANSACTION_FAILED', message, options);
  }
}

export class RestoreCancellationError extends PostgresRestoreError {
  constructor(message = 'PostgreSQL restore operation was cancelled.', options?: ErrorOptions) {
    super('RESTORE_CANCELLED', message, options);
  }
}

export class RestoreUnsupportedObjectError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_UNSUPPORTED_OBJECT', message, options);
  }
}

export class RestorePrivilegeError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_PRIVILEGE_FAILED', message, options);
  }
}

export class RestoreMappingError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_MAPPING_FAILED', message, options);
  }
}

export class RestoreValidationError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_VALIDATION_FAILED', message, options);
  }
}

export class RestoreNotImplementedError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_NOT_IMPLEMENTED', message, options);
  }
}

export class RestoreSchemaMappingError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_SCHEMA_MAPPING_FAILED', message, options);
  }
}

export class RestoreTablespaceMappingError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_TABLESPACE_MAPPING_FAILED', message, options);
  }
}

export class RestoreExistingObjectConflictError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_EXISTING_OBJECT_CONFLICT', message, options);
  }
}

export class RestoreUnsafeCleanPlanError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_UNSAFE_CLEAN_PLAN', message, options);
  }
}

export class RestoreIncompatibleReplacementError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_INCOMPATIBLE_REPLACEMENT', message, options);
  }
}

export class RestoreNonEmptyTableError extends PostgresRestoreError {
  constructor(
    message: string,
    readonly stepId: string,
    readonly archiveEntryId: string,
    readonly mappedObjectIdentity: string,
    options?: ErrorOptions,
  ) {
    super('RESTORE_NON_EMPTY_TABLE', message, options);
  }
}

export class RestoreExternalDependencyError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_EXTERNAL_DEPENDENCY', message, options);
  }
}

export class RestoreDestructiveOperationError extends PostgresRestoreError {
  constructor(
    message: string,
    readonly stepId: string,
    readonly archiveEntryId: string,
    readonly mappedObjectIdentity: string,
    readonly sqlPreview: string,
    readonly fields: RestoreSqlErrorFields = {},
    options?: ErrorOptions,
  ) {
    super('RESTORE_DESTRUCTIVE_OPERATION_FAILED', message, options);
  }
}

export function toRestoreCancellationError(cause: unknown): RestoreCancellationError {
  return cause instanceof RestoreCancellationError
    ? cause
    : new RestoreCancellationError(undefined, { cause });
}

export function safeSqlPreview(sql: string, maximumLength = 240): string {
  const redacted = redactSensitiveText(sql).replaceAll(/\s+/gu, ' ').trim();
  return redacted.length <= maximumLength
    ? redacted
    : `${redacted.slice(0, Math.max(0, maximumLength - 1))}…`;
}
