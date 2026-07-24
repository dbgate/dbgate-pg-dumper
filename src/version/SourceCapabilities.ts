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
  readonly publications: boolean;
  readonly publicationTruncate: boolean;
  readonly publicationPartitionRoot: boolean;
  readonly publicationRowFilters: boolean;
  readonly publicationSchemas: boolean;
  readonly subscriptionBinary: boolean;
  readonly subscriptionStreaming: boolean;
  readonly subscriptionTwoPhase: boolean;
  readonly subscriptionFailover: boolean;
  readonly roleBypassRls: boolean;
  readonly extendedStatistics: boolean;
  readonly statisticsTarget: boolean;
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
    publications: major >= 10,
    publicationTruncate: major >= 11,
    publicationPartitionRoot: major >= 13,
    publicationRowFilters: major >= 15,
    publicationSchemas: major >= 15,
    subscriptionBinary: major >= 14,
    subscriptionStreaming: major >= 14,
    subscriptionTwoPhase: major >= 15,
    subscriptionFailover: major >= 17,
    roleBypassRls: major >= 9,
    extendedStatistics: major >= 10,
    statisticsTarget: major >= 13,
  };
}
