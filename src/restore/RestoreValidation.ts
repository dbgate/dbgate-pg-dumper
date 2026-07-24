import { createHash } from 'node:crypto';

import {
  acquirePostgresConnection,
  type PostgresConnection,
} from '../connection/PostgresConnection.js';
import { quoteIdentifier, quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import { redactSensitiveText } from '../security/SensitiveValuePolicy.js';
import type {
  RestoreArchiveEntry,
  RestoreArchiveMetadata,
  RestoreDataOperation,
  RestoreObjectTarget,
} from './RestoreArchive.js';
import {
  mapRestoreArchiveEntry,
  restoreEntryTarget,
  restoreTargetIdentity,
  type RestoreMappingContext,
} from './RestoreMapping.js';
import {
  QueryRestoreTargetInspector,
  type RestoreTargetInspector,
  type RestoreTargetObject,
  type RestoreTargetSnapshot,
} from './RestoreTarget.js';
import {
  normalizeRestoreOptions,
  type RestoreConfidence,
  type RestoreDiagnostic,
  type RestoreDiagnosticCode,
  type RestoreOptions,
  type RestoreProgressEvent,
  type RestoreValidationCheckResult,
  type RestoreValidationCheckStatus,
  type RestoreValidationCheckType,
  type RestoreValidationRequest,
  type RestoreValidationResult,
  type RestoreValidationStatus,
  type RestoreValidationProgress,
} from './RestoreTypes.js';

interface ValidationCallbacks {
  readonly onProgress?: (event: RestoreProgressEvent) => void;
  readonly onDiagnostic?: (diagnostic: RestoreDiagnostic) => void;
  readonly signal?: AbortSignal;
}

export interface RestoreConfidenceContext {
  readonly executionStatus?: 'success' | 'partial' | 'failed' | 'cancelled' | 'preflight-failed';
  readonly skippedStepCount?: number;
  readonly unresolvedMappings?: boolean;
  readonly partialStateMayRemain?: boolean;
}

function timestamp(clock: () => Date): string {
  return clock().toISOString();
}

function checkId(type: RestoreValidationCheckType, entryId = '', identity = ''): string {
  return `v_${createHash('sha256')
    .update(`${type}\0${entryId}\0${identity}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function emit(callbacks: ValidationCallbacks, event: RestoreProgressEvent): void {
  callbacks.onProgress?.(event);
}

function diagnostic(
  code: RestoreDiagnosticCode,
  severity: RestoreDiagnostic['severity'],
  message: string,
  entry?: RestoreArchiveEntry,
  objectIdentity?: string,
  safeDetails?: RestoreDiagnostic['safeDetails'],
): RestoreDiagnostic {
  return {
    code,
    severity,
    phase: 'validation',
    ...(entry === undefined ? {} : { archiveEntryId: entry.entryId }),
    ...(objectIdentity === undefined ? {} : { objectIdentity }),
    message,
    ...(safeDetails === undefined ? {} : { safeDetails }),
  };
}

function objectMatches(target: RestoreObjectTarget, actual: RestoreTargetObject): boolean {
  if (target.kind === 'schema') return actual.kind === 'schema' && actual.name === target.name;
  const routine =
    target.kind === 'function' || target.kind === 'procedure' || target.kind === 'aggregate';
  const child = target.parent !== undefined;
  return (
    target.kind === actual.kind &&
    target.schema === actual.schema &&
    (target.subName ?? target.name) === actual.name &&
    (!routine || (target.identityArguments ?? '') === (actual.identityArguments ?? '')) &&
    (!child ||
      (target.parent?.schema === actual.parentSchema && target.parent.name === actual.parentName))
  );
}

function namespaceMatches(target: RestoreObjectTarget, actual: RestoreTargetObject): boolean {
  if (target.kind === 'schema') return actual.kind === 'schema' && actual.name === target.name;
  const routine =
    target.kind === 'function' || target.kind === 'procedure' || target.kind === 'aggregate';
  return (
    target.schema === actual.schema &&
    (target.subName ?? target.name) === actual.name &&
    (!routine || (target.identityArguments ?? '') === (actual.identityArguments ?? ''))
  );
}

const INSPECTED_TARGET_KINDS = new Set<RestoreObjectTarget['kind']>([
  'schema',
  'table',
  'view',
  'materialized-view',
  'sequence',
  'index',
  'constraint',
  'trigger',
  'policy',
  'type',
  'domain',
  'enum',
  'range-type',
  'composite-type',
  'function',
  'procedure',
  'aggregate',
  'extension',
  'publication',
  'statistics',
]);

function levelAtLeast(
  level: RestoreOptions['validation']['level'],
  expected: 'basic' | 'structure' | 'structure-and-data' | 'full',
): boolean {
  const levels = ['none', 'basic', 'structure', 'structure-and-data', 'full'] as const;
  return levels.indexOf(level) >= levels.indexOf(expected);
}

export function canonicalizeValidationValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'bool:true' : 'bool:false';
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (value === Number.POSITIVE_INFINITY) return 'number:Infinity';
    if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity';
    if (Object.is(value, -0)) return 'number:-0';
    return `number:${String(value)}`;
  }
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (Buffer.isBuffer(value)) return `bytes:${value.toString('hex')}`;
  if (Array.isArray(value)) {
    return `array:[${value.map((item) => canonicalizeValidationValue(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `object:{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeValidationValue(record[key])}`)
      .join(',')}}`;
  }
  return `${typeof value}:[unsupported]`;
}

export function checksumCanonicalValidationRows(rows: readonly unknown[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(canonicalizeValidationValue(row)).update('\n');
  return hash.digest('hex');
}

export function deriveRestoreConfidence(
  status: RestoreValidationStatus,
  level: RestoreOptions['validation']['level'],
  checks: readonly RestoreValidationCheckResult[],
  context: RestoreConfidenceContext = {},
): RestoreConfidence {
  if (status === 'not-run' || level === 'none') return 'unverified';
  if (
    status === 'failed' ||
    status === 'cancelled' ||
    context.executionStatus === 'partial' ||
    context.executionStatus === 'failed' ||
    (context.skippedStepCount ?? 0) > 0 ||
    context.unresolvedMappings === true ||
    context.partialStateMayRemain === true ||
    checks.some((check) => check.status === 'failed' || check.status === 'warning')
  ) {
    return 'low';
  }
  if (
    levelAtLeast(level, 'structure-and-data') &&
    checks.some((check) => check.type === 'row-count' || check.type === 'checksum') &&
    !checks.some(
      (check) =>
        (check.type === 'row-count' ||
          check.type === 'checksum' ||
          check.type === 'sequence-state') &&
        (check.status === 'unavailable' || check.status === 'skipped'),
    )
  ) {
    return 'high';
  }
  return levelAtLeast(level, 'structure') ? 'medium' : 'low';
}

function createCheck(
  type: RestoreValidationCheckType,
  status: RestoreValidationCheckStatus,
  durationMilliseconds: number,
  options: {
    entry?: RestoreArchiveEntry;
    identity?: string;
    expected?: unknown;
    actual?: unknown;
    diagnosticCodes?: readonly RestoreDiagnosticCode[];
    safeDetails?: RestoreValidationCheckResult['safeDetails'];
  } = {},
): RestoreValidationCheckResult {
  return {
    checkId: checkId(type, options.entry?.entryId, options.identity),
    type,
    ...(options.entry === undefined ? {} : { archiveEntryId: options.entry.entryId }),
    ...(options.identity === undefined ? {} : { targetObjectIdentity: options.identity }),
    ...(options.expected === undefined ? {} : { expected: options.expected }),
    ...(options.actual === undefined ? {} : { actual: options.actual }),
    status,
    durationMilliseconds,
    diagnosticCodes: options.diagnosticCodes ?? [],
    ...(options.safeDetails === undefined ? {} : { safeDetails: options.safeDetails }),
  };
}

export function createNotRunRestoreValidationResult(
  level: RestoreOptions['validation']['level'],
  started: Date,
  completed: Date,
): RestoreValidationResult {
  const summary = {
    level,
    checksRequested: 0,
    checksPerformed: 0,
    checksPassed: 0,
    checksFailed: 0,
    checksSkipped: 0,
    checksUnavailable: 0,
    objectsVerified: 0,
    tablesCounted: 0,
    tablesChecksummed: 0,
    rowsScanned: '0',
    bytesScanned: '0',
    sequenceStatesVerified: 0,
    complete: level === 'none',
  };
  return {
    status: 'not-run',
    level,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMilliseconds: Math.max(0, completed.getTime() - started.getTime()),
    checks: [],
    summary,
    confidence: 'unverified',
    diagnostics: [],
    checksPerformed: 0,
    checksFailed: 0,
    complete: summary.complete,
  };
}

function qualifiedTable(operation: RestoreDataOperation): string {
  return quoteQualifiedIdentifier([operation.table.schema, operation.table.table], {
    quoteAllIdentifiers: true,
  });
}

export function formatRestoreValidationSummary(result: RestoreValidationResult): string {
  return `Validation ${result.status}; confidence ${result.confidence}; ${String(
    result.summary.checksPassed,
  )}/${String(result.summary.checksPerformed)} checks passed, ${String(
    result.summary.checksFailed,
  )} failed, ${String(result.summary.checksUnavailable)} unavailable.`;
}

export class PostgreSqlRestoreValidator {
  constructor(
    private readonly targetInspector: RestoreTargetInspector = new QueryRestoreTargetInspector(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async validate(request: RestoreValidationRequest): Promise<RestoreValidationResult> {
    let acquired: Awaited<ReturnType<typeof acquirePostgresConnection>> | undefined;
    const started = this.clock();
    try {
      const metadata = await request.archive.readMetadata(request.signal);
      const entries: RestoreArchiveEntry[] = [];
      for await (const entry of request.archive.listEntries(request.signal)) entries.push(entry);
      acquired = await acquirePostgresConnection(request.target, request.signal);
      const target = await this.targetInspector.inspect(acquired.connection, request.signal);
      return await this.validateLoaded(
        acquired.connection,
        metadata,
        entries,
        target,
        normalizeRestoreOptions(request.options),
        request,
      );
    } catch (cause) {
      if (request.signal?.aborted !== true) throw cause;
      const completed = this.clock();
      const result = createNotRunRestoreValidationResult(
        normalizeRestoreOptions(request.options).validation.level,
        started,
        completed,
      );
      return { ...result, status: 'cancelled', confidence: 'low' };
    } finally {
      await Promise.allSettled([acquired?.release(), request.archive.close()]);
    }
  }

  async validateLoaded(
    connection: PostgresConnection,
    _metadata: RestoreArchiveMetadata,
    entries: readonly RestoreArchiveEntry[],
    target: RestoreTargetSnapshot,
    options: RestoreOptions,
    callbacks: ValidationCallbacks = {},
    confidenceContext: RestoreConfidenceContext = {},
  ): Promise<RestoreValidationResult> {
    const started = this.clock();
    const validation = options.validation;
    if (validation.level === 'none')
      return createNotRunRestoreValidationResult('none', started, this.clock());
    const checks: RestoreValidationCheckResult[] = [];
    const diagnostics: RestoreDiagnostic[] = [];
    let rowsScanned = 0n;
    let bytesScanned = 0n;
    const mapping: RestoreMappingContext = {
      options,
      availableSchemas: new Set(target.schemas),
      availableTablespaces: new Set(target.tablespaces),
      protectedSchemas: new Set(target.extensionSchemas ?? []),
    };
    const mappedEntries = entries.flatMap((entry) => {
      const mapped = mapRestoreArchiveEntry(entry, mapping);
      return mapped === undefined ? [] : [mapped];
    });
    const addDiagnostic = (item: RestoreDiagnostic): void => {
      diagnostics.push(item);
      callbacks.onDiagnostic?.(item);
      emit(callbacks, {
        event: 'validation-diagnostic-emitted',
        phase: 'validation',
        timestamp: timestamp(this.clock),
      });
    };
    const progress = (
      event: RestoreValidationProgress['event'],
      extra: Partial<Omit<RestoreValidationProgress, 'event' | 'phase' | 'timestamp'>> = {},
    ): void => {
      emit(callbacks, {
        event,
        phase: 'validation',
        timestamp: timestamp(this.clock),
        ...extra,
      });
    };
    progress('validation-started');
    try {
      callbacks.signal?.throwIfAborted();
      progress('validation-phase-started');
      const healthStarted = this.clock();
      const health = await connection.query<{
        database_name: string;
        role_name: string;
        replication_role: string;
      }>(
        {
          text: `SELECT current_database()::text AS database_name,
            current_user::text AS role_name,
            pg_catalog.current_setting('session_replication_role') AS replication_role`,
        },
        callbacks.signal,
      );
      const transactionStatus = await connection.getTransactionStatus(callbacks.signal);
      const healthRow = health.rows[0];
      const healthy =
        healthRow !== undefined &&
        (target.databaseName === undefined || healthRow.database_name === target.databaseName) &&
        healthRow.role_name === target.currentUser.name &&
        healthRow.replication_role === 'origin' &&
        transactionStatus === 'idle';
      checks.push(
        createCheck(
          'connection-health',
          healthy ? 'passed' : 'failed',
          this.clock().getTime() - healthStarted.getTime(),
          {
            expected: {
              role: target.currentUser.name,
              database: target.databaseName,
              replicationRole: 'origin',
              transactionStatus: 'idle',
            },
            actual: {
              role: healthRow?.role_name,
              database: healthRow?.database_name,
              replicationRole: healthRow?.replication_role,
              transactionStatus,
            },
            diagnosticCodes: healthy ? [] : ['validation-structural-mismatch'],
          },
        ),
      );
      if (!healthy) {
        addDiagnostic(
          diagnostic(
            'validation-structural-mismatch',
            'error',
            'The validation session is not in the expected clean state.',
          ),
        );
      }

      const creationEntries = mappedEntries.filter(
        (entry) =>
          entry.operation.kind === 'sql' &&
          entry.operation.target !== undefined &&
          entry.operation.createsTarget !== false,
      );
      const seenTargets = new Set<string>();
      for (const entry of creationEntries) {
        callbacks.signal?.throwIfAborted();
        const targetIdentity = restoreEntryTarget(entry);
        if (targetIdentity === undefined) continue;
        const identity = restoreTargetIdentity(targetIdentity);
        if (seenTargets.has(identity)) continue;
        seenTargets.add(identity);
        const startedCheck = this.clock();
        progress('validation-object-check-started', {
          archiveEntryId: entry.entryId,
          objectIdentity: identity,
        });
        if (!INSPECTED_TARGET_KINDS.has(targetIdentity.kind)) {
          checks.push(
            createCheck('object-existence', 'unavailable', 0, {
              entry,
              identity,
              expected: targetIdentity.kind,
              diagnosticCodes: ['validation-unavailable'],
            }),
          );
          addDiagnostic(
            diagnostic(
              'validation-unavailable',
              'warning',
              'The compact target inspector does not expose this object kind for validation.',
              entry,
              identity,
              { objectKind: targetIdentity.kind },
            ),
          );
          continue;
        }
        const exact = target.objects?.find((object) => objectMatches(targetIdentity, object));
        const namespace = target.objects?.find((object) =>
          namespaceMatches(targetIdentity, object),
        );
        const status: RestoreValidationCheckStatus =
          exact !== undefined ? 'passed' : namespace === undefined ? 'failed' : 'failed';
        const code: RestoreDiagnosticCode =
          namespace === undefined ? 'validation-object-missing' : 'validation-object-kind-mismatch';
        checks.push(
          createCheck('object-existence', status, this.clock().getTime() - startedCheck.getTime(), {
            entry,
            identity,
            expected: targetIdentity.kind,
            actual: exact?.kind ?? namespace?.kind ?? null,
            diagnosticCodes: exact === undefined ? [code] : [],
          }),
        );
        if (exact === undefined) {
          addDiagnostic(
            diagnostic(
              code,
              'error',
              namespace === undefined
                ? 'A selected mapped restore object is missing.'
                : 'A selected mapped restore identity has a different object kind.',
              entry,
              identity,
              {
                expectedKind: targetIdentity.kind,
                actualKind: namespace?.kind ?? null,
              },
            ),
          );
        } else if (levelAtLeast(validation.level, 'structure')) {
          const shape =
            entry.operation.kind === 'sql' ? entry.operation.replacementTargetShape : undefined;
          const columnsMatch =
            shape?.columns === undefined ||
            (exact.columns !== undefined &&
              shape.columns.length === exact.columns.length &&
              shape.columns.every(
                (column, index) =>
                  column.name === exact.columns?.[index]?.name &&
                  column.formattedType === exact.columns[index]?.formattedType,
              ));
          const returnTypeMatches =
            shape?.returnType === undefined || shape.returnType === exact.returnType;
          const tablespaceMatches =
            !validation.compareTablespaces ||
            entry.operation.kind !== 'sql' ||
            entry.operation.tablespace === undefined ||
            entry.operation.tablespace === exact.tablespace;
          const structureMatches = columnsMatch && returnTypeMatches && tablespaceMatches;
          checks.push(
            createCheck(
              'object-structure',
              structureMatches ? 'passed' : 'failed',
              this.clock().getTime() - startedCheck.getTime(),
              {
                entry,
                identity,
                expected: {
                  columns: shape?.columns,
                  returnType: shape?.returnType,
                  tablespace:
                    entry.operation.kind === 'sql' ? entry.operation.tablespace : undefined,
                },
                actual: {
                  columns: exact.columns?.map((column) => ({
                    name: column.name,
                    formattedType: column.formattedType,
                  })),
                  returnType: exact.returnType,
                  tablespace: exact.tablespace,
                },
                diagnosticCodes: structureMatches ? [] : ['validation-structural-mismatch'],
              },
            ),
          );
          if (!structureMatches) {
            addDiagnostic(
              diagnostic(
                tablespaceMatches
                  ? 'validation-structural-mismatch'
                  : 'validation-tablespace-mismatch',
                'error',
                'The restored object structure differs from available structured archive metadata.',
                entry,
                identity,
              ),
            );
          }
        }
        progress('validation-object-check-completed', {
          archiveEntryId: entry.entryId,
          objectIdentity: identity,
          checksCompleted: checks.length,
        });
      }

      if (levelAtLeast(validation.level, 'structure')) {
        const unsupportedComparisons = [
          [validation.compareOwnership, 'ownership'],
          [validation.compareComments, 'comments'],
          [validation.comparePrivileges, 'privileges'],
          [validation.compareStatistics, 'statistics'],
        ] as const;
        for (const [requested, subject] of unsupportedComparisons) {
          if (!requested) continue;
          checks.push(
            createCheck('policy', 'unavailable', 0, {
              actual: `${subject} metadata is not carried by the compact target snapshot`,
              diagnosticCodes: ['validation-unavailable'],
            }),
          );
          addDiagnostic(
            diagnostic(
              'validation-unavailable',
              'warning',
              `${subject} validation is unavailable with the current compact target snapshot.`,
            ),
          );
        }
      }

      if (levelAtLeast(validation.level, 'structure-and-data')) {
        if (validation.sample.mode !== 'none') {
          checks.push(
            createCheck('policy', 'unavailable', 0, {
              expected: validation.sample,
              diagnosticCodes: ['validation-sampled'],
            }),
          );
          addDiagnostic(
            diagnostic(
              'validation-sampled',
              'warning',
              'Deterministic sampled validation is configured but is not yet implemented.',
            ),
          );
        }
        for (const entry of mappedEntries) {
          callbacks.signal?.throwIfAborted();
          if (entry.operation.kind === 'table-data') {
            const operation = entry.operation;
            const identity = `${operation.table.schema}.${operation.table.table}`;
            if (
              options.existingTableDataPolicy === 'skip-data' ||
              options.existingTableDataPolicy === 'append'
            ) {
              checks.push(
                createCheck('row-count', 'skipped', 0, {
                  entry,
                  identity,
                  actual: `intentionally ${options.existingTableDataPolicy}`,
                }),
              );
              continue;
            }
            if (validation.rowCountMode !== 'none') {
              const countStarted = this.clock();
              progress('validation-row-count-started', {
                archiveEntryId: entry.entryId,
                objectIdentity: identity,
              });
              const count = await connection.query<{ count_value: string }>(
                {
                  text: `SELECT pg_catalog.count(*)::text AS count_value FROM ${qualifiedTable(operation)}`,
                },
                callbacks.signal,
              );
              const actual = count.rows[0]?.count_value;
              const expected = operation.estimatedRows;
              if (actual !== undefined) rowsScanned += BigInt(actual);
              const available = expected !== undefined;
              const passed = available && actual === String(expected);
              checks.push(
                createCheck(
                  'row-count',
                  available ? (passed ? 'passed' : 'failed') : 'unavailable',
                  this.clock().getTime() - countStarted.getTime(),
                  {
                    entry,
                    identity,
                    expected: expected ?? null,
                    actual: actual ?? null,
                    diagnosticCodes: available
                      ? passed
                        ? []
                        : ['validation-row-count-mismatch']
                      : ['validation-unavailable'],
                  },
                ),
              );
              if (!available || !passed) {
                addDiagnostic(
                  diagnostic(
                    available ? 'validation-row-count-mismatch' : 'validation-unavailable',
                    available ? 'error' : 'warning',
                    available
                      ? 'The exact target row count differs from archive metadata.'
                      : 'An exact row count was read, but the archive has no trusted expected count.',
                    entry,
                    identity,
                    { actualCount: actual ?? null, expectedCount: expected ?? null },
                  ),
                );
              }
              progress('validation-row-count-completed', {
                archiveEntryId: entry.entryId,
                objectIdentity: identity,
                ...(actual === undefined ? {} : { rowsScanned: actual }),
              });
            }
            if (validation.checksumMode !== 'none') {
              const expected = operation.validation?.canonicalSha256;
              const orderColumns = operation.validation?.orderColumns;
              if (
                validation.checksumMode === 'archive-payload' ||
                expected === undefined ||
                orderColumns === undefined
              ) {
                checks.push(
                  createCheck('checksum', 'unavailable', 0, {
                    entry,
                    identity,
                    expected: expected ?? operation.checksum?.value ?? null,
                    actual:
                      validation.checksumMode === 'archive-payload'
                        ? 'payload checksum does not prove target data'
                        : null,
                    diagnosticCodes: ['validation-unavailable'],
                  }),
                );
                addDiagnostic(
                  diagnostic(
                    'validation-unavailable',
                    'warning',
                    'Canonical target checksum requires an expected canonical checksum and stable order columns.',
                    entry,
                    identity,
                  ),
                );
              } else {
                const checksumStarted = this.clock();
                progress('validation-checksum-started', {
                  archiveEntryId: entry.entryId,
                  objectIdentity: identity,
                });
                const columns = operation.columns.map(
                  (column) => `${quoteIdentifier(column, { quoteAllIdentifiers: true })}::text`,
                );
                const order = orderColumns
                  .map((column) => quoteIdentifier(column, { quoteAllIdentifiers: true }))
                  .join(', ');
                const query = {
                  text: `SELECT pg_catalog.json_build_array(${columns.join(
                    ', ',
                  )}) AS validation_row FROM ${qualifiedTable(operation)} ORDER BY ${order}`,
                };
                const hash = createHash('sha256');
                let checksumRowCount = 0;
                let checksumByteCount = 0;
                const consumeRow = (row: unknown): void => {
                  const canonical = canonicalizeValidationValue(row);
                  hash.update(canonical).update('\n');
                  checksumRowCount += 1;
                  checksumByteCount += Buffer.byteLength(canonical);
                };
                if (connection.stream !== undefined) {
                  for await (const row of connection.stream<{ validation_row: unknown }>(query, {
                    ...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
                    batchSize: 512,
                  })) {
                    consumeRow(row.validation_row);
                  }
                } else {
                  const result = await connection.query<{ validation_row: unknown }>(
                    query,
                    callbacks.signal,
                  );
                  for (const row of result.rows) consumeRow(row.validation_row);
                }
                const actual = hash.digest('hex');
                rowsScanned += BigInt(checksumRowCount);
                bytesScanned += BigInt(checksumByteCount);
                const passed = actual === expected;
                checks.push(
                  createCheck(
                    'checksum',
                    passed ? 'passed' : 'failed',
                    this.clock().getTime() - checksumStarted.getTime(),
                    {
                      entry,
                      identity,
                      expected,
                      actual,
                      diagnosticCodes: passed ? [] : ['validation-checksum-mismatch'],
                    },
                  ),
                );
                if (!passed) {
                  addDiagnostic(
                    diagnostic(
                      'validation-checksum-mismatch',
                      'error',
                      'The canonical target-data checksum differs from the archive fingerprint.',
                      entry,
                      identity,
                    ),
                  );
                }
                progress('validation-checksum-completed', {
                  archiveEntryId: entry.entryId,
                  objectIdentity: identity,
                  rowsScanned: String(checksumRowCount),
                  bytesScanned: String(checksumByteCount),
                });
              }
            }
          } else if (
            entry.operation.kind === 'sequence-state' &&
            validation.sequenceMode === 'archive-state'
          ) {
            const operation = entry.operation;
            const identity = `${operation.schema}.${operation.sequence}`;
            if (options.existingSequenceStatePolicy === 'preserve-target') {
              checks.push(
                createCheck('sequence-state', 'skipped', 0, {
                  entry,
                  identity,
                  actual: 'preserve-target policy',
                }),
              );
              continue;
            }
            const sequenceStarted = this.clock();
            const state = await connection.query<{ last_value: string; is_called: boolean }>(
              {
                text: `SELECT last_value::text AS last_value, is_called FROM ${quoteQualifiedIdentifier(
                  [operation.schema, operation.sequence],
                  { quoteAllIdentifiers: true },
                )}`,
              },
              callbacks.signal,
            );
            const actual = state.rows[0];
            const passed =
              actual?.last_value === operation.lastValue && actual.is_called === operation.isCalled;
            checks.push(
              createCheck(
                'sequence-state',
                passed ? 'passed' : 'failed',
                this.clock().getTime() - sequenceStarted.getTime(),
                {
                  entry,
                  identity,
                  expected: { lastValue: operation.lastValue, isCalled: operation.isCalled },
                  actual:
                    actual === undefined
                      ? null
                      : { lastValue: actual.last_value, isCalled: actual.is_called },
                  diagnosticCodes: passed ? [] : ['validation-sequence-state-mismatch'],
                },
              ),
            );
            if (!passed) {
              addDiagnostic(
                diagnostic(
                  'validation-sequence-state-mismatch',
                  'error',
                  'The target sequence state differs from the archived state.',
                  entry,
                  identity,
                ),
              );
            }
            progress('validation-sequence-check-completed', {
              archiveEntryId: entry.entryId,
              objectIdentity: identity,
            });
          }
        }
      }
    } catch (cause) {
      if (callbacks.signal?.aborted === true) {
        const cancelled = createCheck('policy', 'cancelled', 0, {
          diagnosticCodes: ['validation-cancelled'],
        });
        checks.push(cancelled);
        const item = diagnostic(
          'validation-cancelled',
          'warning',
          'Post-restore validation was cancelled; committed restore state was preserved.',
        );
        addDiagnostic(item);
      } else {
        const message = redactSensitiveText(cause instanceof Error ? cause.message : String(cause));
        checks.push(
          createCheck('policy', 'failed', 0, {
            actual: 'validation query failed',
            diagnosticCodes: ['validation-query-failed'],
            safeDetails: { errorType: cause instanceof Error ? cause.name : typeof cause },
          }),
        );
        addDiagnostic(
          diagnostic(
            'validation-query-failed',
            'error',
            'A post-restore validation query failed.',
            undefined,
            undefined,
            { error: message.slice(0, 200) },
          ),
        );
      }
    }
    const completed = this.clock();
    const failed = checks.filter((check) => check.status === 'failed').length;
    const warnings = checks.filter((check) => check.status === 'warning').length;
    const cancelled = checks.some((check) => check.status === 'cancelled');
    const unavailable = checks.filter((check) => check.status === 'unavailable').length;
    const skipped = checks.filter((check) => check.status === 'skipped').length;
    const passed = checks.filter((check) => check.status === 'passed').length;
    const status: RestoreValidationStatus = cancelled
      ? 'cancelled'
      : failed > 0
        ? 'failed'
        : warnings > 0 || unavailable > 0
          ? 'passed-with-warnings'
          : 'passed';
    const summary = {
      level: validation.level,
      checksRequested: checks.length,
      checksPerformed: checks.filter((check) => check.status !== 'skipped').length,
      checksPassed: passed,
      checksFailed: failed,
      checksSkipped: skipped,
      checksUnavailable: unavailable,
      objectsVerified: checks.filter(
        (check) => check.type === 'object-existence' && check.status === 'passed',
      ).length,
      tablesCounted: checks.filter(
        (check) => check.type === 'row-count' && check.status === 'passed',
      ).length,
      tablesChecksummed: checks.filter(
        (check) => check.type === 'checksum' && check.status === 'passed',
      ).length,
      rowsScanned: rowsScanned.toString(),
      bytesScanned: bytesScanned.toString(),
      sequenceStatesVerified: checks.filter(
        (check) => check.type === 'sequence-state' && check.status === 'passed',
      ).length,
      complete: failed === 0 && unavailable === 0 && !cancelled,
    };
    const confidence = deriveRestoreConfidence(status, validation.level, checks, confidenceContext);
    progress(
      status === 'failed'
        ? 'validation-failed'
        : status === 'cancelled'
          ? 'validation-cancelled'
          : 'validation-completed',
      {
        checksCompleted: summary.checksPerformed,
        totalChecks: summary.checksRequested,
        rowsScanned: summary.rowsScanned,
        bytesScanned: summary.bytesScanned,
        elapsedMilliseconds: completed.getTime() - started.getTime(),
      },
    );
    return {
      status,
      level: validation.level,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMilliseconds: Math.max(0, completed.getTime() - started.getTime()),
      checks,
      summary,
      confidence,
      diagnostics,
      checksPerformed: summary.checksPerformed,
      checksFailed: summary.checksFailed,
      complete: summary.complete,
    };
  }
}
