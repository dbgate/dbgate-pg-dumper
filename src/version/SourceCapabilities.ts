/**
 * Source-catalog capability detection.
 *
 * These flags describe what the connected source server can contain and which
 * catalog columns are safe to reference. They are intentionally separate from
 * future target compatibility decisions used by SQL renderers.
 */

import type { PostgresVersion } from './PostgresVersion.js';

export interface SourceCapabilities {
  readonly identityColumns: boolean;
  readonly declarativePartitioning: boolean;
  readonly procedures: boolean;
  readonly includeIndexes: boolean;
  readonly generatedColumns: boolean;
  readonly columnCompression: boolean;
  readonly nullsNotDistinct: boolean;
  readonly multiranges: boolean;
  readonly tableAccessMethods: boolean;
  readonly partitionConstraintParents: boolean;
  readonly defaultPartitions: boolean;
  readonly partitionedIndexes: boolean;
  readonly routineKinds: boolean;
  readonly supportFunctions: boolean;
  readonly sqlRoutineBodies: boolean;
  readonly transitionTables: boolean;
  readonly parentTriggers: boolean;
  readonly restrictivePolicies: boolean;
  readonly securityInvokerViews: boolean;
  readonly materializedViewAccessMethods: boolean;
}

export function detectSourceCapabilities(version: PostgresVersion): SourceCapabilities {
  const major = version.major;
  return {
    identityColumns: major >= 10,
    declarativePartitioning: major >= 10,
    procedures: major >= 11,
    includeIndexes: major >= 11,
    generatedColumns: major >= 12,
    columnCompression: major >= 14,
    nullsNotDistinct: major >= 15,
    multiranges: major >= 14,
    tableAccessMethods: major >= 12,
    partitionConstraintParents: major >= 11,
    defaultPartitions: major >= 11,
    partitionedIndexes: major >= 11,
    routineKinds: major >= 11,
    supportFunctions: major >= 12,
    sqlRoutineBodies: major >= 14,
    transitionTables: major >= 10,
    parentTriggers: major >= 11,
    restrictivePolicies: major >= 10,
    securityInvokerViews: major >= 15,
    materializedViewAccessMethods: major >= 12,
  };
}
