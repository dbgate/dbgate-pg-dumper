/**
 * Centralized target PostgreSQL syntax capabilities.
 *
 * These flags describe emitted SQL syntax, independently of source catalog
 * capabilities. Native mode simply derives them from the source version.
 */

import type { PostgresVersion } from '../version/PostgresVersion.js';

export interface TargetCapabilities {
  readonly identityColumns: boolean;
  readonly declarativePartitioning: boolean;
  readonly procedures: boolean;
  readonly includeIndexes: boolean;
  readonly generatedColumns: boolean;
  readonly columnCompression: boolean;
  readonly nullsNotDistinct: boolean;
  readonly securityInvokerViews: boolean;
  readonly restrictivePolicies: boolean;
  readonly tableAccessMethods: boolean;
  readonly idleInTransactionSessionTimeout: boolean;
  readonly logicalReplication: boolean;
  readonly extendedStatistics: boolean;
  readonly functionSupportFunctions: boolean;
}

export function detectTargetCapabilities(version: PostgresVersion): TargetCapabilities {
  const major = version.major;
  return {
    identityColumns: major >= 10,
    declarativePartitioning: major >= 10,
    procedures: major >= 11,
    includeIndexes: major >= 11,
    generatedColumns: major >= 12,
    columnCompression: major >= 14,
    nullsNotDistinct: major >= 15,
    securityInvokerViews: major >= 15,
    restrictivePolicies: major >= 10,
    tableAccessMethods: major >= 12,
    idleInTransactionSessionTimeout: major >= 9,
    logicalReplication: major >= 10,
    extendedStatistics: major >= 10,
    functionSupportFunctions: major >= 12,
  };
}
