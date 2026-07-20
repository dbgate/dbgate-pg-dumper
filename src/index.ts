/**
 * Package entry point.
 *
 * Only stable, client-facing contracts are re-exported here. Internal pipeline
 * components remain behind this boundary so their implementation can evolve
 * without forcing consumers to depend on the project's architecture.
 */
export { dumpPostgres } from './api/dumpPostgres.js';
export { createArchiveIdentity, createDumpId } from './archive/ArchiveIdentity.js';
export { inspectDumpArchive } from './archive/inspectDumpArchive.js';
export {
  archiveObjectPriority,
  assignDumpSection,
  dumpSectionPriority,
} from './archive/SectionRules.js';
export type {
  ArchiveBuildOptions,
  ArchiveCycleEdge,
  ArchiveCycleMember,
  ArchiveDataExportDescriptor,
  ArchiveDependency,
  ArchiveDependencySource,
  ArchiveDependencyStrength,
  ArchiveDiagnostic,
  ArchiveDiagnosticCode,
  ArchiveDiagnosticSeverity,
  ArchiveDumpMode,
  ArchiveEntry,
  ArchiveExtension,
  ArchiveExtensionMember,
  ArchiveExtensionMembership,
  ArchiveObjectType,
  ArchiveSelectionOptions,
  ArchiveSelectionReason,
  ArchiveSelectionState,
  DumpArchiveInspection,
  DumpSection,
  InspectDumpArchiveOptions,
} from './archive/ArchiveTypes.js';
export type {
  DataExportFormat,
  DumpMode,
  DumpOptions,
  DumpProgress,
  DumpProgressCallback,
  DumpProgressPhase,
  DumpResult,
  DumpWarning,
  DumpWarningCode,
  DumpWarningSeverity,
} from './api/types.js';
export { DumpPreflightAnalyzer } from './preflight/DumpPreflightAnalyzer.js';
export type {
  DumpPreflightReport,
  PreflightIssue,
  PreflightObjectSummary,
  TransactionCompatibility,
  UnsupportedObjectPolicy,
} from './preflight/PreflightTypes.js';
export {
  isSensitiveOptionName,
  protectSensitiveValue,
  redactSensitiveText,
} from './security/SensitiveValuePolicy.js';
export type {
  ProtectedSensitiveValue,
  SensitiveValueContext,
  SensitiveValueDecision,
  SensitiveValueKind,
  SensitiveValueMode,
  SensitiveValuePolicy,
  SensitiveValueProvider,
} from './security/SensitiveValuePolicy.js';
export type {
  AcquiredPostgresConnection,
  PostgresConnection,
  PostgresConnectionInput,
  PostgresConnectionSource,
  PostgresQuery,
  PostgresQueryResult,
  PostgresRow,
  PostgresStreamOptions,
  PostgresTransactionStatus,
} from './connection/PostgresConnection.js';
export type {
  DumpSessionMetadata,
  DumpSessionOptions,
  DumpTransactionMode,
} from './connection/DumpSession.js';
export { DataExportEngine } from './data/DataExportEngine.js';
export { LargeObjectExporter } from './data/LargeObjectExporter.js';
export type {
  LargeObjectExportProgress,
  LargeObjectExportRequest,
  LargeObjectExportResult,
} from './data/LargeObjectExporter.js';
export type { DataExportBatchConsumer, DataExportRequest } from './data/DataExportEngine.js';
export { DataExportPlanner } from './data/DataExportPlanner.js';
export type { DataExportPlannerOptions } from './data/DataExportPlanner.js';
export type {
  ArchiveDataExportDescriptor as DetailedArchiveDataExportDescriptor,
  ColumnExportDescriptor,
  DataExportFormatter,
  DataExportMode,
  DataStreamingStrategy,
  DataValueReadStrategy,
  MaterializedViewDataExportDescriptor,
  PartitionExportDescriptor,
  PrimaryKeyExportDescriptor,
  ReplicaIdentityExportDescriptor,
  SequenceStateExportDescriptor,
  TableDataExportDescriptor,
} from './data/DataExportDescriptor.js';
export { escapeCopyText, writeCopyTextValue } from './serialization/CopyTextSerializer.js';
export { renderInsertLiteral } from './serialization/InsertLiteralSerializer.js';
export { PlainDataSerializer } from './serialization/PlainDataSerializer.js';
export { postgresTextValue } from './serialization/PostgresTextValue.js';
export type {
  DataBatchSerializer,
  DataSerializationDiagnostic,
  DataSerializationProgress,
  DataSerializationProgressCallback,
  DataSerializationProgressPhase,
  DataSerializationResult,
  PlainDataOutputMode,
  PlainDataSerializationOptions,
  PlainDataSerializerRequest,
  TableDataSerializationStatistics,
} from './serialization/DataSerializationTypes.js';
export { inferExportFormatter, PostgresValueNormalizer } from './data/PostgresValueNormalizer.js';
export type { NormalizedPostgresValue, PostgresValueKind } from './data/PostgresValueNormalizer.js';
export type {
  DataExportBatch,
  DataExportDiagnostic,
  DataExportDiagnosticCode,
  DataExportPlan,
  DataExportProgress,
  DataExportProgressCallback,
  DataExportProgressPhase,
  DataExportResult,
  NormalizedDataRow,
  PlannedTableExport,
} from './data/DataExportTypes.js';
export { introspectPostgres } from './introspection/introspectPostgres.js';
export { renderPlainSql, PlainSqlArchiveRenderer } from './renderer/PlainSqlRenderer.js';
export { PostgresSqlRenderer } from './renderer/SqlRenderer.js';
export {
  chooseDollarQuoteTag,
  dollarQuote,
  quoteEscapedStringLiteral,
  quoteIdentifier,
  quoteOperatorName,
  quoteQualifiedIdentifier,
  quoteRoleName,
  quoteStringLiteral,
  renderSqlLiteral,
} from './renderer/SqlPrimitives.js';
export type { IdentifierQuotingPolicy, SqlKeywordCase } from './renderer/SqlPrimitives.js';
export type {
  NormalizedPlainSqlRenderOptions,
  PlainSqlRenderContext,
  PlainSqlRenderOptions,
  PlainSqlRenderRequest,
  PlainSqlRenderResult,
  PlainSqlWarning,
  PlainSqlWarningCode,
  RestoreTransactionMode,
  RestoreTriggerMode,
  UnsupportedFeaturePolicy,
} from './renderer/RenderTypes.js';
export { StreamDumpWriter, StringDumpWriter } from './writer/DumpWriter.js';
export type { DumpWriter, DumpWriterOptions, SqlLineEnding } from './writer/DumpWriter.js';
export type {
  IntrospectPostgresOptions,
  PostgresIntrospectionMetadata,
  PostgresIntrospectionResult,
  SourceServerMetadata,
} from './introspection/introspectPostgres.js';
export type {
  IntrospectionDiagnostic,
  IntrospectionDiagnosticCode,
} from './introspection/diagnostics.js';
export type {
  PostgresColumn,
  PostgresColumnTypeKind,
  PostgresDatabase,
  PostgresIdentityMode,
  PostgresPersistence,
  PostgresReplicaIdentity,
  PostgresSchema,
  PostgresStorageMode,
  PostgresTable,
  PostgresTableKind,
  PostgresTableReference,
} from './model/PostgresDatabase.js';
export type {
  PostgresAccessControlEntry,
  PostgresAggregate,
  PostgresAggregateKind,
  PostgresComment,
  PostgresDefaultPrivilege,
  PostgresDefaultPrivilegeObjectType,
  PostgresFunction,
  PostgresMaterializedView,
  PostgresMaterializedViewIndex,
  PostgresOwnership,
  PostgresParallelSafety,
  PostgresPolicy,
  PostgresPolicyCommand,
  PostgresProcedure,
  PostgresRelationColumn,
  PostgresRoutineBase,
  PostgresRoutineKind,
  PostgresRoutineVolatility,
  PostgresRule,
  PostgresRuleEnabled,
  PostgresRuleEvent,
  PostgresTrigger,
  PostgresTriggerEnabled,
  PostgresTriggerEvent,
  PostgresTriggerTiming,
  PostgresView,
  PostgresViewCheckOption,
} from './model/PostgresHigherLevelObjects.js';
export type {
  PostgresCheckConstraint,
  PostgresConstraint,
  PostgresConstraintKind,
  PostgresDomain,
  PostgresEnumLabel,
  PostgresEnumType,
  PostgresForeignKeyAction,
  PostgresForeignKeyConstraint,
  PostgresForeignKeyMatch,
  PostgresIndex,
  PostgresIndexElement,
  PostgresKeyConstraint,
  PostgresObjectKind,
  PostgresObjectReference,
  PostgresPartitionBound,
  PostgresPartitionDefinition,
  PostgresPartitionStrategy,
  PostgresSequence,
  PostgresSequenceOwnership,
  PostgresStructuralObject,
} from './model/PostgresStructuralObjects.js';
export {
  isSchemaSelected,
  isTableSelected,
  normalizeDumpSelection,
} from './selection/Selection.js';
export type { DumpSelection, NormalizedDumpSelection } from './selection/Selection.js';
export {
  CancellationError,
  ConnectionError,
  DataExportError,
  DataSerializationError,
  PreflightError,
  SecretPolicyError,
  UnsupportedObjectError,
  InconsistentCatalogError,
  IntrospectionQueryError,
  OutputWriteError,
  PostgresDumperError,
  RenderError,
  TransactionSetupError,
  UnsupportedPostgresVersionError,
} from './utils/errors.js';
export { PostgresVersionService } from './version/PostgresVersion.js';
export type { PostgresVersion } from './version/PostgresVersion.js';
export { detectSourceCapabilities } from './version/SourceCapabilities.js';
export type { SourceCapabilities } from './version/SourceCapabilities.js';
