/**
 * Connection-free preflight analysis over the normalized database and archive.
 */

import type { DumpOptions } from '../api/types.js';
import type { DumpArchiveInspection } from '../archive/ArchiveTypes.js';
import type { PostgresDatabase } from '../model/PostgresDatabase.js';
import type {
  PostgresAccessControlEntry,
  PostgresDefaultPrivilege,
  PostgresOwnership,
} from '../model/PostgresHigherLevelObjects.js';
import type {
  DumpPreflightReport,
  PreflightIssue,
  PreflightObjectSummary,
  TransactionCompatibility,
} from './PreflightTypes.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import { detectTargetCapabilities } from '../compatibility/TargetCapabilities.js';

const PRIVILEGED_OBJECTS: Readonly<Partial<Record<string, readonly string[]>>> = {
  'event-trigger': ['superuser or database owner'],
  'procedural-language': ['superuser for untrusted languages'],
  'foreign-data-wrapper': ['superuser'],
  subscription: ['CREATE and replication privileges'],
  tablespace: ['superuser'],
  role: ['CREATEROLE or superuser'],
  'large-object': ['large-object ownership or superuser'],
};

const TRANSACTION_INCOMPATIBLE = new Set(['database', 'tablespace', 'subscription']);

function summary(entry: DumpArchiveInspection['entries'][number]): PreflightObjectSummary {
  return {
    dumpId: entry.dumpId,
    identity: entry.archiveIdentity,
    objectType: entry.objectType,
    section: entry.section,
  };
}

export class DumpPreflightAnalyzer {
  analyze(
    database: PostgresDatabase,
    archive: DumpArchiveInspection,
    sourceVersion: PostgresVersion,
    targetVersion: PostgresVersion,
    options: DumpOptions,
  ): DumpPreflightReport {
    const selectedEntries = archive.orderedEntries.filter((entry) => entry.selection.selected);
    const skippedEntries = archive.entries.filter((entry) => !entry.selection.selected);
    const issues: PreflightIssue[] = [];
    const portabilityIssues: PreflightIssue[] = [];
    const targetVersionIncompatibilities: PreflightIssue[] = [];
    const transactionIncompatibilities: PreflightIssue[] = [];
    const requiredPrivileges = new Set<string>();
    const targetCapabilities = detectTargetCapabilities(targetVersion);
    const bestEffortCompatibility =
      options.bestEffort === true || targetVersion.number < sourceVersion.number;
    const unsupportedFeaturePolicy =
      options.unsupportedFeaturePolicy ?? (bestEffortCompatibility ? 'warn-skip' : 'error');
    const addTargetIncompatibility = (
      feature: string,
      objectIdentity: string,
      safeToOmit = false,
    ): void => {
      const issue: PreflightIssue = {
        code: 'target-incompatibility',
        severity:
          unsupportedFeaturePolicy === 'error' ||
          (!safeToOmit && unsupportedFeaturePolicy !== 'warn-skip')
            ? 'error'
            : 'warning',
        message: `Target PostgreSQL ${targetVersion.normalizedMajor} does not support ${feature}.`,
        objectIdentity,
      };
      targetVersionIncompatibilities.push(issue);
      issues.push(issue);
    };

    for (const entry of selectedEntries) {
      for (const privilege of PRIVILEGED_OBJECTS[entry.objectType] ?? []) {
        requiredPrivileges.add(privilege);
        issues.push({
          code: 'privilege-required',
          severity: 'warning',
          message: 'Restoring this object may require elevated PostgreSQL privileges.',
          objectIdentity: entry.archiveIdentity,
          requiredPrivilege: privilege,
        });
      }
      const transactionIncompatible =
        TRANSACTION_INCOMPATIBLE.has(entry.objectType) &&
        (entry.objectType !== 'database' || options.includeCreateDatabase === true) &&
        (entry.objectType !== 'tablespace' || options.tablespacePolicy !== 'omit');
      if (transactionIncompatible) {
        const issue: PreflightIssue = {
          code: 'transaction-incompatible',
          severity: options.restoreTransactionMode === 'none' ? 'warning' : 'error',
          message: 'The selected object cannot be restored inside one transaction.',
          objectIdentity: entry.archiveIdentity,
        };
        transactionIncompatibilities.push(issue);
        issues.push(issue);
      }
    }

    for (const schema of database.schemas) {
      for (const table of schema.tables) {
        const identity = `${table.schema}.${table.name}`;
        if (!targetCapabilities.declarativePartitioning && table.kind !== 'ordinary') {
          addTargetIncompatibility('declarative partitioning', identity);
        }
        if (!targetCapabilities.tableAccessMethods && table.accessMethod !== undefined) {
          addTargetIncompatibility('table access methods', identity, table.accessMethod === 'heap');
        }
        for (const column of table.columns) {
          const columnIdentity = `${identity}.${column.name}`;
          if (!targetCapabilities.identityColumns && column.identity !== undefined) {
            addTargetIncompatibility('identity columns', columnIdentity);
          }
          if (!targetCapabilities.generatedColumns && column.generatedExpression !== undefined) {
            addTargetIncompatibility('generated columns', columnIdentity);
          }
          if (!targetCapabilities.columnCompression && column.compression !== undefined) {
            addTargetIncompatibility('column compression', columnIdentity, true);
          }
        }
        if (table.persistence === 'unlogged') {
          const issue: PreflightIssue = {
            code: 'unlogged-table',
            severity: 'warning',
            message:
              'Unlogged-table data is exported, but crash and replication semantics are not preserved.',
            objectIdentity: `${table.schema}.${table.name}`,
          };
          portabilityIssues.push(issue);
          issues.push(issue);
        }
        if (table.persistence === 'temporary') {
          const issue: PreflightIssue = {
            code: 'temporary-object',
            severity: 'warning',
            message:
              'Temporary-object semantics are session-specific and may not restore identically.',
            objectIdentity: `${table.schema}.${table.name}`,
          };
          portabilityIssues.push(issue);
          issues.push(issue);
        }
        if (table.tablespace !== undefined) {
          const mapping = options.tablespaceMappings?.[table.tablespace];
          if (options.tablespacePolicy === 'fail-unmapped' && mapping === undefined) {
            const issue: PreflightIssue = {
              code: 'portability-risk',
              severity: 'error',
              message: 'A referenced tablespace has no configured target mapping.',
              objectIdentity: `${table.schema}.${table.name}`,
            };
            portabilityIssues.push(issue);
            issues.push(issue);
          }
        }
      }
    }

    if (!targetCapabilities.procedures) {
      for (const procedure of database.procedures) {
        addTargetIncompatibility(
          'procedures',
          `${procedure.schema}.${procedure.name}(${procedure.identityArguments})`,
        );
      }
    }
    if (!targetCapabilities.includeIndexes) {
      for (const index of database.indexes.filter((item) =>
        item.elements.some((element) => !element.key),
      )) {
        addTargetIncompatibility('INCLUDE indexes', `${index.schema}.${index.name}`, true);
      }
    }
    if (!targetCapabilities.nullsNotDistinct) {
      for (const index of database.indexes.filter((item) => item.nullsNotDistinct)) {
        addTargetIncompatibility('NULLS NOT DISTINCT indexes', `${index.schema}.${index.name}`);
      }
    }
    if (!targetCapabilities.securityInvokerViews) {
      for (const view of database.views.filter((item) => item.securityInvoker === true)) {
        addTargetIncompatibility('security-invoker views', `${view.schema}.${view.name}`);
      }
    }
    if (!targetCapabilities.restrictivePolicies) {
      for (const policy of database.policies.filter((item) => !item.permissive)) {
        addTargetIncompatibility(
          'restrictive row-security policies',
          `${policy.table.schema}.${policy.table.name}.${policy.name}`,
        );
      }
    }
    if (!targetCapabilities.logicalReplication) {
      for (const publication of database.publications ?? []) {
        addTargetIncompatibility('logical-replication publications', publication.name);
      }
      for (const subscription of database.subscriptions ?? []) {
        addTargetIncompatibility('logical-replication subscriptions', subscription.name);
      }
    }
    if (!targetCapabilities.extendedStatistics) {
      for (const statistics of database.statistics ?? []) {
        addTargetIncompatibility('extended statistics', `${statistics.schema}.${statistics.name}`);
      }
    }
    if (!targetCapabilities.functionSupportFunctions) {
      for (const routine of (database.functions ?? []).filter(
        (item) => item.supportFunction !== undefined,
      )) {
        addTargetIncompatibility(
          'function planner support functions',
          `${routine.schema}.${routine.name}(${routine.identityArguments})`,
        );
      }
    }
    if (
      !targetCapabilities.databaseOwnerRole &&
      options.roleMappings?.pg_database_owner === undefined
    ) {
      for (const entry of selectedEntries) {
        const referencesDatabaseOwnerRole =
          (entry.objectType === 'ownership' &&
            !options.noOwner &&
            (entry.sourceObject as PostgresOwnership).owner === 'pg_database_owner') ||
          (entry.objectType === 'acl' &&
            !options.noPrivileges &&
            (entry.sourceObject as PostgresAccessControlEntry).grantee === 'pg_database_owner') ||
          (entry.objectType === 'default-privilege' &&
            !options.noPrivileges &&
            ((entry.sourceObject as PostgresDefaultPrivilege).owner === 'pg_database_owner' ||
              (entry.sourceObject as PostgresDefaultPrivilege).grantee === 'pg_database_owner'));
        if (!referencesDatabaseOwnerRole) continue;
        addTargetIncompatibility(
          'the predefined pg_database_owner role',
          entry.archiveIdentity,
          true,
        );
      }
    }

    const transactionCompatibility: TransactionCompatibility =
      transactionIncompatibilities.length === 0
        ? 'compatible'
        : options.restoreTransactionMode === 'none'
          ? 'section-only'
          : 'incompatible';
    const requiredRoles = new Set<string>();
    if (!options.noOwner) {
      requiredRoles.add(database.owner);
      for (const ownership of database.ownerships) {
        requiredRoles.add(options.roleMappings?.[ownership.owner] ?? ownership.owner);
      }
    }
    if (!options.noPrivileges) {
      for (const acl of database.accessControls) {
        if (acl.grantee !== 'PUBLIC') {
          requiredRoles.add(options.roleMappings?.[acl.grantee] ?? acl.grantee);
        }
        if (acl.grantor !== 'PUBLIC') {
          requiredRoles.add(options.roleMappings?.[acl.grantor] ?? acl.grantor);
        }
      }
    }

    const unsupported = selectedEntries.filter((entry) =>
      entry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'unresolved-dependency' && diagnostic.severity === 'error',
      ),
    );
    for (const entry of unsupported) {
      const issue: PreflightIssue = {
        code: 'unsupported-object',
        severity:
          (options.unsupportedObjectPolicy ?? (bestEffortCompatibility ? 'warn' : 'error')) ===
          'error'
            ? 'error'
            : 'warning',
        message: 'The selected object cannot currently be reproduced safely.',
        objectIdentity: entry.archiveIdentity,
      };
      issues.push(issue);
    }

    const canProceed = !issues.some((issue) => issue.severity === 'error');
    return {
      sourceVersion,
      targetVersion,
      selectedObjects: selectedEntries.map(summary),
      skippedObjects: skippedEntries.map(summary),
      unsupportedObjects: unsupported.map(summary),
      requiredExtensions: selectedEntries
        .filter((entry) => entry.objectType === 'extension')
        .map((entry) => entry.name),
      requiredRoles: [...requiredRoles].sort(),
      requiredPrivileges: [...requiredPrivileges].sort(),
      targetVersionIncompatibilities,
      tablespaceMappings: { ...(options.tablespaceMappings ?? {}) },
      sensitiveValueDecisions: [],
      transactionCompatibility,
      transactionIncompatibilities,
      portabilityIssues,
      issues,
      estimatedRows: database.schemas.reduce(
        (total, schema) =>
          total +
          schema.tables.reduce(
            (schemaTotal, table) => schemaTotal + Math.max(table.estimatedRowCount, 0),
            0,
          ),
        0,
      ),
      canProceed,
    };
  }
}
