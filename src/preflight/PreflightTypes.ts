/**
 * Read-only dump analysis returned before any output is emitted.
 *
 * The report intentionally contains identities and decisions, never catalog
 * secrets or arbitrary driver messages.
 */

import type { ArchiveObjectType, DumpSection } from '../archive/ArchiveTypes.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import type { SensitiveValueDecision } from '../security/SensitiveValuePolicy.js';

export type UnsupportedObjectPolicy = 'error' | 'warn' | 'skip';
export type TransactionCompatibility = 'compatible' | 'section-only' | 'incompatible';

export interface PreflightObjectSummary {
  readonly dumpId: string;
  readonly identity: string;
  readonly objectType: ArchiveObjectType;
  readonly section: DumpSection;
}

export interface PreflightIssue {
  readonly code:
    | 'unsupported-object'
    | 'target-incompatibility'
    | 'missing-role'
    | 'privilege-required'
    | 'secret-decision'
    | 'transaction-incompatible'
    | 'portability-risk'
    | 'runtime-state-omitted'
    | 'temporary-object'
    | 'unlogged-table';
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly objectIdentity?: string;
  readonly requiredPrivilege?: string;
}

export interface DumpPreflightReport {
  readonly sourceVersion: PostgresVersion;
  readonly targetVersion: PostgresVersion;
  readonly selectedObjects: readonly PreflightObjectSummary[];
  readonly skippedObjects: readonly PreflightObjectSummary[];
  readonly unsupportedObjects: readonly PreflightObjectSummary[];
  readonly requiredExtensions: readonly string[];
  readonly requiredRoles: readonly string[];
  readonly requiredPrivileges: readonly string[];
  readonly targetVersionIncompatibilities: readonly PreflightIssue[];
  readonly tablespaceMappings: Readonly<Record<string, string>>;
  readonly sensitiveValueDecisions: readonly SensitiveValueDecision[];
  readonly transactionCompatibility: TransactionCompatibility;
  readonly transactionIncompatibilities: readonly PreflightIssue[];
  readonly portabilityIssues: readonly PreflightIssue[];
  readonly issues: readonly PreflightIssue[];
  readonly estimatedRows: number;
  readonly estimatedDataBytes?: number;
  readonly canProceed: boolean;
}
