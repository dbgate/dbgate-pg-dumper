/**
 * Non-fatal catalog diagnostics produced while assembling structural objects.
 *
 * Diagnostics are stable, machine-readable, and avoid embedding query values or
 * driver messages. They make inconsistent or unsupported metadata visible
 * without forcing every recoverable condition to abort introspection.
 */

export type IntrospectionDiagnosticCode =
  | 'missing-reference'
  | 'malformed-constraint-columns'
  | 'unsupported-catalog-metadata'
  | 'invalid-index'
  | 'unvalidated-constraint'
  | 'orphaned-sequence'
  | 'unresolved-partition-parent'
  | 'malformed-acl'
  | 'unresolved-function-type'
  | 'missing-trigger-function'
  | 'unresolved-view-dependency'
  | 'excluded-internal-object'
  | 'missing-owner-role'
  | 'invalid-materialized-view'
  | 'unsupported-object-kind';

export interface IntrospectionDiagnostic {
  readonly code: IntrospectionDiagnosticCode;
  readonly severity: 'warning';
  readonly message: string;
  readonly objectOid?: number;
  readonly objectIdentity?: string;
}

export class IntrospectionDiagnostics {
  readonly #items: IntrospectionDiagnostic[] = [];

  add(diagnostic: IntrospectionDiagnostic): void {
    this.#items.push(diagnostic);
  }

  getAll(): readonly IntrospectionDiagnostic[] {
    return [...this.#items];
  }
}
