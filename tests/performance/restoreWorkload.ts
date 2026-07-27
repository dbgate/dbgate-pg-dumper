import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { Readable } from 'node:stream';
import { getHeapStatistics } from 'node:v8';

import {
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  InMemoryRestoreArchiveSource,
  quoteIdentifier,
  type NativeRestoreTransactionMode,
  type RestoreArchiveEntry,
  type RestoreResult,
  type RestoreValidationLevel,
} from '../../src/index.js';
import type { NativeRestoreFixture } from '../integration/support/nativeRestoreTestSupport.js';

export type RestoreWorkloadProfile = 'smoke' | 'ci' | 'large' | 'stress' | 'manual-extreme';
export type RestoreRowShape = 'narrow' | 'wide' | 'mixed' | 'highly-nullable' | 'large-values';
export type RestoreArchiveSourceType = 'direct-stream' | 'persistent-directory';

export interface RestoreWorkloadConfiguration {
  readonly profile: RestoreWorkloadProfile;
  readonly shape: RestoreRowShape;
  readonly rowCount: number;
  readonly seed: number;
  readonly chunkBytes: number;
  readonly sourceDelayMilliseconds: number;
  readonly largeValueBytes: number;
  readonly corruptRow?: number;
}

export interface RestoreStreamTelemetry {
  rowsGenerated: number;
  logicalBytes: number;
  chunksGenerated: number;
  maximumChunkBytes: number;
  maximumReadableBytes: number;
  pauseCount: number;
  resumeCount: number;
  destroyed: boolean;
}

export interface MemorySnapshot {
  readonly timestampMilliseconds: number;
  readonly phase: string;
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

export interface MemorySummary {
  readonly gcAvailable: boolean;
  readonly baseline: MemorySnapshot;
  readonly peak: MemorySnapshot;
  readonly final: MemorySnapshot;
  readonly peakRssIncrease: number;
  readonly peakHeapIncrease: number;
  readonly sampleCount: number;
}

export interface RestoreBenchmarkResult {
  readonly benchmarkName: string;
  readonly workloadProfile: RestoreWorkloadProfile;
  readonly rowShape: RestoreRowShape;
  readonly postgresVersion: string;
  readonly nodeVersion: string;
  readonly operatingSystem: string;
  readonly cpuCount: number;
  readonly memoryLimitBytes?: number;
  readonly rowCount: number;
  readonly logicalBytes: number;
  readonly storedBytes?: number;
  readonly totalDurationMilliseconds: number;
  readonly copyDurationMilliseconds: number;
  readonly archiveReadDurationMilliseconds: number;
  readonly validationDurationMilliseconds: number;
  readonly rowsPerSecond: number;
  readonly logicalMegabytesPerSecond: number;
  readonly baselineRss: number;
  readonly peakRss: number;
  readonly peakHeapUsed: number;
  readonly cancellationLatencyMilliseconds?: number;
  readonly checksumMode: string;
  readonly validationLevel: RestoreValidationLevel;
  readonly transactionMode: NativeRestoreTransactionMode;
  readonly concurrency: number;
  readonly archiveSourceType: RestoreArchiveSourceType;
  readonly resultStatus: RestoreResult['status'];
  readonly progressEventCount: number;
}

const PROFILE_ROWS: Readonly<Record<RestoreWorkloadProfile, number>> = {
  smoke: 10_000,
  ci: 250_000,
  large: 1_000_000,
  stress: 5_000_000,
  'manual-extreme': 10_000_000,
};

function integerEnvironment(name: string, fallback: number, minimum = 0): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${String(minimum)}.`);
  }
  return parsed;
}

export function resolveRestoreWorkloadConfiguration(
  overrides: Partial<RestoreWorkloadConfiguration> = {},
): RestoreWorkloadConfiguration {
  const profile =
    overrides.profile ??
    (process.env.RESTORE_STRESS_PROFILE as RestoreWorkloadProfile | undefined) ??
    'smoke';
  if (!(profile in PROFILE_ROWS)) throw new Error(`Unknown restore workload profile: ${profile}`);
  const shape =
    overrides.shape ?? (process.env.RESTORE_STRESS_SHAPE as RestoreRowShape | undefined) ?? 'mixed';
  if (!['narrow', 'wide', 'mixed', 'highly-nullable', 'large-values'].includes(shape)) {
    throw new Error(`Unknown restore row shape: ${shape}`);
  }
  const configuredRows = integerEnvironment('RESTORE_TEST_ROWS', PROFILE_ROWS[profile], 1);
  const extremeGigabytes = Number(process.env.RESTORE_TEST_SIZE_GB ?? '0');
  const extremeRows =
    profile === 'manual-extreme' && Number.isFinite(extremeGigabytes) && extremeGigabytes > 0
      ? Math.ceil((extremeGigabytes * 1024 ** 3) / 1024)
      : configuredRows;
  return {
    profile,
    shape,
    rowCount: overrides.rowCount ?? extremeRows,
    seed: overrides.seed ?? integerEnvironment('RESTORE_TEST_SEED', 73),
    chunkBytes:
      overrides.chunkBytes ?? integerEnvironment('RESTORE_TEST_CHUNK_BYTES', 64 * 1024, 1),
    sourceDelayMilliseconds:
      overrides.sourceDelayMilliseconds ?? integerEnvironment('RESTORE_TEST_SOURCE_DELAY_MS', 0),
    largeValueBytes:
      overrides.largeValueBytes ??
      integerEnvironment('RESTORE_TEST_LARGE_VALUE_BYTES', 2 * 1024 * 1024, 1),
    ...(overrides.corruptRow === undefined ? {} : { corruptRow: overrides.corruptRow }),
  };
}

function copyText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
}

function deterministicUuid(seed: number, row: number): string {
  const value = BigInt(seed) * 0x9e3779b97f4a7c15n + BigInt(row);
  const hex = (value & ((1n << 128n) - 1n)).toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(
    17,
    20,
  )}-${hex.slice(20)}`;
}

function textValue(configuration: RestoreWorkloadConfiguration, row: number): string {
  const edge = row % 97;
  const base =
    edge === 0
      ? 'Unicode žluťoučký 🦊\tline one\nline two\\tail'
      : edge === 1
        ? ''
        : `row-${String(row)}-seed-${String(configuration.seed)}`;
  if (configuration.shape === 'narrow') return base.slice(0, 32);
  if (configuration.shape === 'wide') return `${base}:${'w'.repeat(2048 + (row % 1024))}`;
  if (configuration.shape === 'large-values' && row % 1000 === 0) {
    return `${base}:${'L'.repeat(configuration.largeValueBytes)}`;
  }
  return `${base}:${'m'.repeat(row % 256)}`;
}

export function expectedRestoreStressRow(
  configuration: RestoreWorkloadConfiguration,
  row: number,
): {
  readonly id: string;
  readonly integer_value: number;
  readonly short_text: string;
  readonly nullable_text: string | null;
  readonly uuid_value: string;
} {
  const nullable =
    configuration.shape === 'highly-nullable'
      ? row % 5 === 0
        ? textValue(configuration, row)
        : null
      : row % 11 === 0
        ? null
        : row % 17 === 0
          ? ''
          : `nullable-${String(row)}`;
  return {
    id: String(row),
    integer_value: (row * 31 + configuration.seed) % 2_000_000_000,
    short_text: textValue(configuration, row).slice(0, 4096),
    nullable_text: nullable,
    uuid_value: deterministicUuid(configuration.seed, row),
  };
}

export function restoreStressCopyRow(
  configuration: RestoreWorkloadConfiguration,
  row: number,
): string {
  const expected = expectedRestoreStressRow(configuration, row);
  const invalidId = configuration.corruptRow === row ? 'invalid-bigint' : expected.id;
  const timestamp = new Date(Date.UTC(2020, 0, 1) + row * 1000).toISOString();
  const json = JSON.stringify({
    row,
    seed: configuration.seed,
    edge: row % 97 === 0 ? 'Unicode 🦊\nvalue' : null,
  });
  const bytea = `\\\\x${((row + configuration.seed) >>> 0).toString(16).padStart(8, '0')}`;
  return [
    invalidId,
    String(expected.integer_value),
    `${String(row)}.${String(row % 1000).padStart(3, '0')}`,
    row % 2 === 0 ? 't' : 'f',
    copyText(expected.short_text.slice(0, 4096)),
    copyText(textValue(configuration, row)),
    expected.nullable_text === null ? '\\N' : copyText(expected.nullable_text),
    expected.uuid_value,
    timestamp.slice(0, 23).replace('T', ' '),
    timestamp,
    copyText(json),
    bytea,
    `{tag_${String(row % 13)},seed_${String(configuration.seed)}}`,
  ]
    .join('\t')
    .concat('\n');
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function createRestoreStressStream(configuration: RestoreWorkloadConfiguration): {
  readonly stream: Readable;
  readonly telemetry: RestoreStreamTelemetry;
} {
  const telemetry: RestoreStreamTelemetry = {
    rowsGenerated: 0,
    logicalBytes: 0,
    chunksGenerated: 0,
    maximumChunkBytes: 0,
    maximumReadableBytes: 0,
    pauseCount: 0,
    resumeCount: 0,
    destroyed: false,
  };
  const chunks = async function* (): AsyncGenerator<Buffer> {
    let pending: string[] = [];
    let pendingBytes = 0;
    for (let row = 1; row <= configuration.rowCount; row += 1) {
      const value = restoreStressCopyRow(configuration, row);
      const bytes = Buffer.byteLength(value);
      if (pendingBytes > 0 && pendingBytes + bytes > configuration.chunkBytes) {
        const chunk = Buffer.from(pending.join(''));
        telemetry.chunksGenerated += 1;
        telemetry.maximumChunkBytes = Math.max(telemetry.maximumChunkBytes, chunk.length);
        pending = [];
        pendingBytes = 0;
        yield chunk;
        await delay(configuration.sourceDelayMilliseconds);
      }
      pending.push(value);
      pendingBytes += bytes;
      telemetry.rowsGenerated += 1;
      telemetry.logicalBytes += bytes;
    }
    if (pendingBytes > 0) {
      const chunk = Buffer.from(pending.join(''));
      telemetry.chunksGenerated += 1;
      telemetry.maximumChunkBytes = Math.max(telemetry.maximumChunkBytes, chunk.length);
      yield chunk;
    }
  };
  const stream = Readable.from(chunks(), {
    objectMode: false,
    highWaterMark: configuration.chunkBytes * 2,
  });
  stream.on('pause', () => {
    telemetry.pauseCount += 1;
    telemetry.maximumReadableBytes = Math.max(
      telemetry.maximumReadableBytes,
      stream.readableLength,
    );
  });
  stream.on('resume', () => {
    telemetry.resumeCount += 1;
    telemetry.maximumReadableBytes = Math.max(
      telemetry.maximumReadableBytes,
      stream.readableLength,
    );
  });
  stream.on('data', () => {
    telemetry.maximumReadableBytes = Math.max(
      telemetry.maximumReadableBytes,
      stream.readableLength,
    );
  });
  stream.on('close', () => {
    telemetry.destroyed = stream.destroyed;
  });
  return { stream, telemetry };
}

export function createRestoreStressArchive(
  fixture: NativeRestoreFixture,
  configuration: RestoreWorkloadConfiguration,
): {
  readonly archive: InMemoryRestoreArchiveSource;
  readonly telemetry: RestoreStreamTelemetry;
} {
  let telemetry: RestoreStreamTelemetry | undefined;
  const schema = fixture.schema;
  const qualified = fixture.qualified('items');
  const entries: readonly RestoreArchiveEntry[] = [
    {
      entryId: 'schema',
      archiveIdentity: `schema:${schema}`,
      objectType: 'schema',
      section: 'pre-data',
      objectIdentity: schema,
      dependencyEntryIds: [],
      operation: {
        kind: 'sql',
        sql: `CREATE SCHEMA ${quoteIdentifier(schema)}`,
        target: { kind: 'schema', name: schema },
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
      description: 'Create stress schema.',
      diagnostics: [],
    },
    {
      entryId: 'table',
      archiveIdentity: `table:${schema}:items`,
      objectType: 'table',
      section: 'pre-data',
      objectIdentity: `${schema}.items`,
      dependencyEntryIds: ['schema'],
      operation: {
        kind: 'sql',
        sql: `CREATE TABLE ${qualified} (
          id bigint NOT NULL,
          integer_value integer NOT NULL,
          numeric_value numeric(30,3) NOT NULL,
          boolean_value boolean NOT NULL,
          short_text text NOT NULL,
          long_text text NOT NULL,
          nullable_text text,
          uuid_value uuid NOT NULL,
          timestamp_value timestamp NOT NULL,
          timestamptz_value timestamptz NOT NULL,
          jsonb_value jsonb NOT NULL,
          bytea_value bytea NOT NULL,
          array_value text[] NOT NULL
        )`,
        target: { kind: 'table', schema, name: 'items' },
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
      description: 'Create stress table.',
      diagnostics: [],
    },
    {
      entryId: 'sequence',
      archiveIdentity: `sequence:${schema}:items_id_seq`,
      objectType: 'sequence',
      section: 'pre-data',
      objectIdentity: `${schema}.items_id_seq`,
      dependencyEntryIds: ['schema'],
      operation: {
        kind: 'sql',
        sql: `CREATE SEQUENCE ${fixture.qualified('items_id_seq')}`,
        target: { kind: 'sequence', schema, name: 'items_id_seq' },
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
      description: 'Create stress sequence.',
      diagnostics: [],
    },
    {
      entryId: 'data',
      archiveIdentity: `table-data:${schema}:items`,
      objectType: 'table-data',
      section: 'data',
      objectIdentity: `${schema}.items`,
      dependencyEntryIds: ['table'],
      operation: {
        kind: 'table-data',
        table: { schema, table: 'items' },
        columns: [
          'id',
          'integer_value',
          'numeric_value',
          'boolean_value',
          'short_text',
          'long_text',
          'nullable_text',
          'uuid_value',
          'timestamp_value',
          'timestamptz_value',
          'jsonb_value',
          'bytea_value',
          'array_value',
        ],
        format: 'copy-text',
        copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
        dataSourceId: 'data',
        estimatedRows: configuration.rowCount,
        identityBehavior: 'preserve',
        partitionBehavior: 'target-table',
        transactionRequirement: 'allowed',
      },
      description: 'Stream deterministic stress rows.',
      diagnostics: [],
    },
    {
      entryId: 'sequence-state',
      archiveIdentity: `sequence-state:${schema}:items_id_seq`,
      objectType: 'sequence-state',
      section: 'data',
      objectIdentity: `${schema}.items_id_seq`,
      dependencyEntryIds: ['sequence', 'data'],
      operation: {
        kind: 'sequence-state',
        schema,
        sequence: 'items_id_seq',
        lastValue: String(configuration.rowCount),
        isCalled: true,
        dataType: 'bigint',
        increment: '1',
        transactionRequirement: 'allowed',
      },
      description: 'Restore deterministic stress sequence state.',
      diagnostics: [],
    },
    {
      entryId: 'primary-key',
      archiveIdentity: `constraint:${schema}:items:items_pkey`,
      objectType: 'constraint',
      section: 'post-data',
      objectIdentity: `${schema}.items_pkey`,
      dependencyEntryIds: ['data'],
      operation: {
        kind: 'sql',
        sql: `ALTER TABLE ${qualified} ADD CONSTRAINT items_pkey PRIMARY KEY (id)`,
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
      description: 'Create the primary key after COPY.',
      diagnostics: [],
    },
    {
      entryId: 'secondary-index',
      archiveIdentity: `index:${schema}:items_integer_value`,
      objectType: 'index',
      section: 'post-data',
      objectIdentity: `${schema}.items_integer_value`,
      dependencyEntryIds: ['data'],
      operation: {
        kind: 'sql',
        sql: `CREATE INDEX items_integer_value ON ${qualified} (integer_value)`,
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
      description: 'Create a representative secondary index after COPY.',
      diagnostics: [],
    },
  ];
  const archive = new InMemoryRestoreArchiveSource({
    metadata: fixture.metadata(`stress-${configuration.profile}-${configuration.shape}`),
    entries,
    data: new Map([
      [
        'data',
        () => {
          const generated = createRestoreStressStream(configuration);
          telemetry = generated.telemetry;
          return generated.stream;
        },
      ],
    ]),
  });
  return {
    archive,
    get telemetry() {
      if (telemetry === undefined) {
        throw new Error('The stress payload stream has not been opened.');
      }
      return telemetry;
    },
  };
}

export class RestoreMemorySampler {
  readonly #samples: MemorySnapshot[] = [];
  readonly #intervalMilliseconds: number;
  #phase = 'setup';
  #timer: NodeJS.Timeout | undefined;

  constructor(intervalMilliseconds = 25) {
    this.#intervalMilliseconds = intervalMilliseconds;
  }

  set phase(value: string) {
    this.#phase = value;
    this.sample();
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.sample();
    this.#timer = setInterval(() => this.sample(), this.#intervalMilliseconds);
    this.#timer.unref();
  }

  sample(): void {
    const usage = process.memoryUsage();
    this.#samples.push({
      timestampMilliseconds: Date.now(),
      phase: this.#phase,
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
    });
  }

  stop(): MemorySummary {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#phase = 'cleanup';
    this.sample();
    const baseline = this.#samples[0]!;
    const final = this.#samples.at(-1)!;
    const peak = this.#samples.reduce((current, sample) =>
      sample.rss > current.rss ? sample : current,
    );
    return {
      gcAvailable: typeof globalThis.gc === 'function',
      baseline,
      peak,
      final,
      peakRssIncrease: Math.max(0, peak.rss - baseline.rss),
      peakHeapIncrease: Math.max(0, peak.heapUsed - baseline.heapUsed),
      sampleCount: this.#samples.length,
    };
  }
}

export function benchmarkResult(
  name: string,
  configuration: RestoreWorkloadConfiguration,
  result: RestoreResult,
  memory: MemorySummary,
  progressEventCount: number,
  options: {
    readonly validationLevel: RestoreValidationLevel;
    readonly transactionMode: NativeRestoreTransactionMode;
    readonly cancellationLatencyMilliseconds?: number;
  },
): RestoreBenchmarkResult {
  const rows = result.restoredRowCount ?? 0;
  const bytes = result.restoredByteCount ?? 0;
  const copySeconds = Math.max(result.copyDurationMilliseconds / 1000, 0.001);
  return {
    benchmarkName: name,
    workloadProfile: configuration.profile,
    rowShape: configuration.shape,
    postgresVersion: result.targetVersion?.complete ?? 'unknown',
    nodeVersion: process.version,
    operatingSystem: `${platform()} ${release()}`,
    cpuCount: cpus().length,
    memoryLimitBytes: getHeapStatistics().heap_size_limit,
    rowCount: rows,
    logicalBytes: bytes,
    totalDurationMilliseconds: result.durationMilliseconds,
    copyDurationMilliseconds: result.copyDurationMilliseconds,
    archiveReadDurationMilliseconds: result.archiveReadDurationMilliseconds,
    validationDurationMilliseconds: Math.max(
      0,
      result.durationMilliseconds - result.copyDurationMilliseconds,
    ),
    rowsPerSecond: rows / copySeconds,
    logicalMegabytesPerSecond: bytes / 1024 / 1024 / copySeconds,
    baselineRss: memory.baseline.rss,
    peakRss: memory.peak.rss,
    peakHeapUsed: memory.peak.heapUsed,
    ...(options.cancellationLatencyMilliseconds === undefined
      ? {}
      : { cancellationLatencyMilliseconds: options.cancellationLatencyMilliseconds }),
    checksumMode: 'streaming-sha256',
    validationLevel: options.validationLevel,
    transactionMode: options.transactionMode,
    concurrency: 1,
    archiveSourceType: 'direct-stream',
    resultStatus: result.status,
    progressEventCount,
  };
}

export function formatRestoreBenchmark(result: RestoreBenchmarkResult): string {
  return [
    `Restore benchmark: ${result.rowShape} / ${result.workloadProfile}`,
    `PostgreSQL: ${result.postgresVersion}`,
    `Rows: ${result.rowCount.toLocaleString('en-US')}`,
    `Logical data: ${(result.logicalBytes / 1024 / 1024).toFixed(2)} MB`,
    `COPY duration: ${(result.copyDurationMilliseconds / 1000).toFixed(2)} s`,
    `Throughput: ${Math.round(result.rowsPerSecond).toLocaleString('en-US')} rows/s`,
    `Throughput: ${result.logicalMegabytesPerSecond.toFixed(2)} MB/s`,
    `Peak RSS increase: ${((result.peakRss - result.baselineRss) / 1024 / 1024).toFixed(2)} MB`,
    `Validation: ${result.validationLevel}, ${(
      result.validationDurationMilliseconds / 1000
    ).toFixed(2)} s`,
    `Status: ${result.resultStatus}`,
  ].join('\n');
}

export function restoreBenchmarkBaselineKey(result: RestoreBenchmarkResult): string {
  return [
    `node-${process.versions.node.split('.')[0]}`,
    `pg-${result.postgresVersion.match(/\d+/u)?.[0] ?? 'unknown'}`,
    platform(),
    result.workloadProfile,
    result.rowShape,
    result.archiveSourceType,
    `rows-${String(result.rowCount)}`,
  ].join('_');
}

export interface RestoreBenchmarkRegression {
  readonly throughputChangePercent: number;
  readonly peakRssChangePercent: number;
  readonly warnings: readonly string[];
  readonly failures: readonly string[];
}

export function compareRestoreBenchmark(
  current: RestoreBenchmarkResult,
  baseline: RestoreBenchmarkResult,
  options: {
    readonly throughputWarningPercent?: number;
    readonly memoryFailurePercent?: number;
    readonly enforcePerformance?: boolean;
  } = {},
): RestoreBenchmarkRegression {
  const throughputChangePercent =
    ((current.rowsPerSecond - baseline.rowsPerSecond) / baseline.rowsPerSecond) * 100;
  const currentRss = current.peakRss - current.baselineRss;
  const baselineRss = baseline.peakRss - baseline.baselineRss;
  const peakRssChangePercent =
    baselineRss === 0 ? 0 : ((currentRss - baselineRss) / baselineRss) * 100;
  const warnings: string[] = [];
  const failures: string[] = [];
  if (throughputChangePercent < -(options.throughputWarningPercent ?? 20)) {
    const message = `Throughput regressed by ${Math.abs(throughputChangePercent).toFixed(1)}%.`;
    if (options.enforcePerformance === true) failures.push(message);
    else warnings.push(message);
  }
  if (peakRssChangePercent > (options.memoryFailurePercent ?? 50)) {
    failures.push(`Peak RSS growth regressed by ${peakRssChangePercent.toFixed(1)}%.`);
  }
  return { throughputChangePercent, peakRssChangePercent, warnings, failures };
}

export function checksumRestoreStressSamples(
  configuration: RestoreWorkloadConfiguration,
  rows: readonly number[],
): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(restoreStressCopyRow(configuration, row));
  return hash.digest('hex');
}
