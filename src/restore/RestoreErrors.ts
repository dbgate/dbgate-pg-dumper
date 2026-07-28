import { redactSensitiveText } from '../security/SensitiveValuePolicy.js';

export type RestoreErrorCode =
  'RESTORE_SQL_FAILED' | 'RESTORE_SQL_DUMP_INVALID' | 'RESTORE_COPY_FAILED' | 'RESTORE_CANCELLED';

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

export class RestoreCopyValidationError extends PostgresRestoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('RESTORE_COPY_FAILED', message, options);
  }
}

export class RestoreCopyLoadError extends PostgresRestoreError {
  constructor(
    message: string,
    readonly operationId: string,
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

export class RestoreCancellationError extends PostgresRestoreError {
  constructor(message = 'PostgreSQL restore operation was cancelled.', options?: ErrorOptions) {
    super('RESTORE_CANCELLED', message, options);
  }
}

export function safeSqlPreview(sql: string, maximumLength = 240): string {
  const redacted = redactSensitiveText(sql).replaceAll(/\s+/gu, ' ').trim();
  return redacted.length <= maximumLength
    ? redacted
    : `${redacted.slice(0, Math.max(0, maximumLength - 1))}…`;
}
