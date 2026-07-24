/**
 * Structured, secret-safe library errors.
 *
 * Messages are authored by this package and never interpolate connection
 * strings, query parameters, passwords, or arbitrary driver messages. Original
 * failures remain available through the standard `cause` property.
 */

export type DumperErrorCode =
  | 'UNSUPPORTED_SOURCE_VERSION'
  | 'CONNECTION_FAILURE'
  | 'TRANSACTION_SETUP_FAILURE'
  | 'INTROSPECTION_QUERY_FAILURE'
  | 'CANCELLED'
  | 'INCONSISTENT_CATALOG'
  | 'OUTPUT_WRITE_FAILURE'
  | 'RENDER_FAILURE'
  | 'DATA_EXPORT_FAILURE'
  | 'DATA_SERIALIZATION_FAILURE'
  | 'PREFLIGHT_FAILURE'
  | 'SECRET_POLICY_FAILURE'
  | 'UNSUPPORTED_OBJECT'
  | 'NOT_IMPLEMENTED';

/** Base class for errors callers may handle by stable code. */
export class PostgresDumperError extends Error {
  constructor(
    readonly code: DumperErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(redactSecrets(message), options);
    this.name = new.target.name;
  }
}

export class UnsupportedPostgresVersionError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('UNSUPPORTED_SOURCE_VERSION', message, options);
  }
}

export class ConnectionError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONNECTION_FAILURE', message, options);
  }
}

export class TransactionSetupError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('TRANSACTION_SETUP_FAILURE', message, options);
  }
}

export class IntrospectionQueryError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('INTROSPECTION_QUERY_FAILURE', message, options);
  }
}

export class CancellationError extends PostgresDumperError {
  constructor(message = 'PostgreSQL dump operation was cancelled.', options?: ErrorOptions) {
    super('CANCELLED', message, options);
  }
}

export class InconsistentCatalogError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('INCONSISTENT_CATALOG', message, options);
  }
}

export class OutputWriteError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('OUTPUT_WRITE_FAILURE', message, options);
  }
}

export class RenderError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('RENDER_FAILURE', message, options);
  }
}

export class DataExportError extends PostgresDumperError {
  constructor(
    message: string,
    readonly diagnostic?: unknown,
    options?: ErrorOptions,
  ) {
    super('DATA_EXPORT_FAILURE', message, options);
  }
}

export class DataSerializationError extends PostgresDumperError {
  constructor(
    message: string,
    readonly diagnostic?: unknown,
    options?: ErrorOptions,
  ) {
    super('DATA_SERIALIZATION_FAILURE', message, options);
  }
}

export class PreflightError extends PostgresDumperError {
  constructor(
    message: string,
    readonly report?: unknown,
    options?: ErrorOptions,
  ) {
    super('PREFLIGHT_FAILURE', message, options);
  }
}

export class SecretPolicyError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('SECRET_POLICY_FAILURE', message, options);
  }
}

export class UnsupportedObjectError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('UNSUPPORTED_OBJECT', message, options);
  }
}

/** Indicates a deliberately scaffolded feature that is not available yet. */
export class NotImplementedError extends PostgresDumperError {
  constructor(message: string, options?: ErrorOptions) {
    super('NOT_IMPLEMENTED', message, options);
  }
}

/** Converts arbitrary abort reasons into a stable cancellation error. */
export function toCancellationError(cause: unknown): CancellationError {
  return cause instanceof CancellationError
    ? cause
    : new CancellationError('PostgreSQL dump operation was cancelled.', { cause });
}

/**
 * Removes common credential formats from diagnostic text.
 *
 * Package code should still use fixed messages; this is a final defense for
 * caller-provided context and future diagnostic helpers.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+(@)/giu, '$1[REDACTED]$2')
    .replace(
      /\b(password|pass|pwd|secret|token)\s*=\s*('[^']*'|"[^"]*"|[^\s;]+)/giu,
      '$1=[REDACTED]',
    );
}
