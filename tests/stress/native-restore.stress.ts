import { describe, expect, it } from 'vitest';

import {
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  createRestoreEngine,
  InMemoryRestoreArchiveSource,
  quoteIdentifier,
  type NativeRestoreTransactionMode,
  type RestoreArchiveEntry,
  type RestoreProgressEvent,
} from '../../src/index.js';
import {
  NativeRestoreFixture,
  restoreFailureContext,
} from '../integration/support/nativeRestoreTestSupport.js';
import { saveRestoreBenchmarkArtifact } from '../performance/restoreBenchmarkArtifacts.js';
import {
  benchmarkResult,
  createRestoreStressArchive,
  expectedRestoreStressRow,
  resolveRestoreWorkloadConfiguration,
  RestoreMemorySampler,
} from '../performance/restoreWorkload.js';

const DEFAULT_MAX_PEAK_RSS_INCREASE = 256 * 1024 * 1024;
const DEFAULT_MAX_CANCELLATION_MILLISECONDS = 5_000;
const TRANSACTION_MODES: readonly NativeRestoreTransactionMode[] = [
  'single',
  'section',
  'entry',
  'none',
];

function environmentBound(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive.`);
  return parsed;
}

describe('native PostgreSQL restore stress correctness', () => {
  it('streams a deterministic mixed workload with bounded source and process memory', async () => {
    const fixture = await NativeRestoreFixture.create('native_stress_stream');
    const configuration = resolveRestoreWorkloadConfiguration();
    const source = createRestoreStressArchive(fixture, configuration);
    const memory = new RestoreMemorySampler();
    const progress: RestoreProgressEvent[] = [];

    try {
      memory.start();
      const result = await createRestoreEngine().restore({
        archive: source.archive,
        target: fixture.target,
        options: {
          transactionMode: 'single',
          validation: { level: 'basic' },
        },
        onProgress: (event) => {
          memory.phase = event.phase;
          progress.push(event);
        },
      });
      const summary = memory.stop();
      expect(result.status, restoreFailureContext(result)).toBe('success');
      expect(result.restoredRowCount).toBe(configuration.rowCount);
      expect(result.sequencesRestoredCount).toBe(1);
      expect(source.telemetry.rowsGenerated).toBe(configuration.rowCount);
      expect(source.telemetry.logicalBytes).toBe(result.restoredByteCount);
      expect(source.telemetry.maximumChunkBytes).toBeLessThanOrEqual(
        configuration.chunkBytes + configuration.largeValueBytes + 8192,
      );
      expect(source.telemetry.maximumReadableBytes).toBeLessThanOrEqual(
        configuration.chunkBytes * 3 + configuration.largeValueBytes + 8192,
      );
      expect(source.telemetry.destroyed).toBe(true);
      expect(summary.peakRssIncrease).toBeLessThan(
        environmentBound('RESTORE_TEST_MAX_RSS_BYTES', DEFAULT_MAX_PEAK_RSS_INCREASE),
      );

      const sampleIds = [
        ...new Set([1, Math.ceil(configuration.rowCount / 2), configuration.rowCount]),
      ];
      const rows = await fixture.client.query<{
        id: string;
        integer_value: number;
        short_text: string;
        nullable_text: string | null;
        uuid_value: string;
      }>(
        `SELECT id::text, integer_value, short_text, nullable_text, uuid_value::text
         FROM ${fixture.qualified('items')}
         WHERE id = ANY($1::bigint[])
         ORDER BY id::bigint`,
        [sampleIds],
      );
      expect(rows.rows).toEqual(
        sampleIds
          .map((row) => expectedRestoreStressRow(configuration, row))
          .sort((left, right) => Number(left.id) - Number(right.id)),
      );
      const counts = await fixture.client.query<{ count: string; distinct_count: string }>(
        `SELECT count(*)::text AS count, count(DISTINCT id)::text AS distinct_count
         FROM ${fixture.qualified('items')}`,
      );
      expect(counts.rows[0]).toEqual({
        count: String(configuration.rowCount),
        distinct_count: String(configuration.rowCount),
      });
      expect(await fixture.sequenceState('items_id_seq')).toEqual({
        last_value: String(configuration.rowCount),
        is_called: true,
      });
      expect(
        progress.filter((event) => event.event === 'step-progress').length,
      ).toBeLessThanOrEqual(source.telemetry.chunksGenerated + 1);

      const measurement = benchmarkResult(
        'stress-correctness',
        configuration,
        result,
        summary,
        progress.length,
        { validationLevel: 'basic', transactionMode: 'single' },
      );
      expect(measurement.logicalBytes).toBeGreaterThan(0);
    } finally {
      memory.stop();
      await fixture.close();
    }
  });

  it('honors backpressure from a slow archive source without losing or duplicating rows', async () => {
    const fixture = await NativeRestoreFixture.create('native_stress_slow');
    const configuration = resolveRestoreWorkloadConfiguration({
      profile: 'smoke',
      shape: 'wide',
      rowCount: 1_000,
      chunkBytes: 64 * 1024,
      sourceDelayMilliseconds: 1,
    });
    const source = createRestoreStressArchive(fixture, configuration);

    try {
      const result = await createRestoreEngine().restore({
        archive: source.archive,
        target: fixture.target,
        options: { transactionMode: 'section', validationLevel: 'none' },
      });
      expect(result.status, restoreFailureContext(result)).toBe('success');
      expect(result.restoredRowCount).toBe(configuration.rowCount);
      expect(source.telemetry.chunksGenerated).toBeGreaterThan(1);
      expect(source.telemetry.resumeCount).toBeGreaterThan(0);
      expect(source.telemetry.maximumReadableBytes).toBeLessThanOrEqual(
        configuration.chunkBytes * 3,
      );
      const counts = await fixture.client.query<{ count: string; distinct_count: string }>(
        `SELECT count(*)::text AS count, count(DISTINCT id)::text AS distinct_count
         FROM ${fixture.qualified('items')}`,
      );
      expect(counts.rows[0]).toEqual({
        count: String(configuration.rowCount),
        distinct_count: String(configuration.rowCount),
      });
    } finally {
      await fixture.close();
    }
  });

  it('restores a large metadata graph of many small tables deterministically', async () => {
    const fixture = await NativeRestoreFixture.create('native_stress_graph');
    const tableCount = 50;
    const rowsPerTable = 20;
    const entries: RestoreArchiveEntry[] = [
      {
        entryId: 'schema',
        archiveIdentity: `schema:${fixture.schema}`,
        objectType: 'schema',
        section: 'pre-data',
        objectIdentity: fixture.schema,
        dependencyEntryIds: [],
        operation: {
          kind: 'sql',
          sql: `CREATE SCHEMA ${quoteIdentifier(fixture.schema)}`,
          target: { kind: 'schema', name: fixture.schema },
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create many-table stress schema.',
        diagnostics: [],
      },
    ];
    const data = new Map<string, string>();
    for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
      const name = `item_${String(tableIndex).padStart(3, '0')}`;
      const tableId = `table-${String(tableIndex)}`;
      const dataId = `data-${String(tableIndex)}`;
      const previousTableId = tableIndex === 0 ? 'schema' : `table-${String(tableIndex - 1)}`;
      entries.push(
        {
          entryId: tableId,
          archiveIdentity: `table:${fixture.schema}:${name}`,
          objectType: 'table',
          section: 'pre-data',
          objectIdentity: `${fixture.schema}.${name}`,
          dependencyEntryIds:
            previousTableId === 'schema' ? ['schema'] : ['schema', previousTableId],
          operation: {
            kind: 'sql',
            sql: `CREATE TABLE ${fixture.qualified(name)} (id integer NOT NULL, value text NOT NULL)`,
            target: { kind: 'table', schema: fixture.schema, name },
            transactionRequirement: 'allowed',
            privilegeRequirements: [],
          },
          description: `Create stress table ${name}.`,
          diagnostics: [],
        },
        {
          entryId: dataId,
          archiveIdentity: `table-data:${fixture.schema}:${name}`,
          objectType: 'table-data',
          section: 'data',
          objectIdentity: `${fixture.schema}.${name}`,
          dependencyEntryIds: [tableId],
          operation: {
            kind: 'table-data',
            table: { schema: fixture.schema, table: name },
            columns: ['id', 'value'],
            format: 'copy-text',
            copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
            dataSourceId: dataId,
            estimatedRows: rowsPerTable,
            identityBehavior: 'preserve',
            partitionBehavior: 'target-table',
            transactionRequirement: 'allowed',
          },
          description: `Load stress table ${name}.`,
          diagnostics: [],
        },
        {
          entryId: `primary-key-${String(tableIndex)}`,
          archiveIdentity: `constraint:${fixture.schema}:${name}:${name}_pkey`,
          objectType: 'constraint',
          section: 'post-data',
          objectIdentity: `${fixture.schema}.${name}_pkey`,
          dependencyEntryIds: [dataId],
          operation: {
            kind: 'sql',
            sql: `ALTER TABLE ${fixture.qualified(name)} ADD CONSTRAINT ${quoteIdentifier(
              `${name}_pkey`,
            )} PRIMARY KEY (id)`,
            transactionRequirement: 'allowed',
            privilegeRequirements: [],
          },
          description: `Index stress table ${name}.`,
          diagnostics: [],
        },
      );
      data.set(
        dataId,
        Array.from(
          { length: rowsPerTable },
          (_, rowIndex) => `${String(rowIndex + 1)}\ttable-${String(tableIndex)}\n`,
        ).join(''),
      );
    }
    const archive = new InMemoryRestoreArchiveSource({
      metadata: fixture.metadata('many-small-tables'),
      entries,
      data,
    });

    try {
      const result = await createRestoreEngine().restore({
        archive,
        target: fixture.target,
        options: { transactionMode: 'section', validationLevel: 'none' },
      });
      expect(result.status, restoreFailureContext(result)).toBe('success');
      expect(result.restoredTableDataCount).toBe(tableCount);
      expect(result.restoredRowCount).toBe(tableCount * rowsPerTable);
      expect(result.constraintsCreatedCount).toBe(tableCount);
      const relations = await fixture.client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_catalog.pg_class AS class
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
         WHERE namespace.nspname = $1 AND class.relkind = 'r'`,
        [fixture.schema],
      );
      expect(relations.rows[0]?.count).toBe(String(tableCount));
      for (const tableIndex of [0, Math.floor(tableCount / 2), tableCount - 1]) {
        const name = `item_${String(tableIndex).padStart(3, '0')}`;
        const count = await fixture.client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${fixture.qualified(name)}`,
        );
        expect(count.rows[0]?.count).toBe(String(rowsPerTable));
      }
      expect(archive.closed).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it.each(TRANSACTION_MODES)(
    'preserves exact state under the %s transaction mode',
    async (transactionMode) => {
      const fixture = await NativeRestoreFixture.create(`native_stress_${transactionMode}`);
      const configuration = resolveRestoreWorkloadConfiguration({
        profile: 'smoke',
        shape: 'narrow',
        rowCount: 1_000,
      });
      const source = createRestoreStressArchive(fixture, configuration);
      try {
        const result = await createRestoreEngine().restore({
          archive: source.archive,
          target: fixture.target,
          options: { transactionMode, validationLevel: 'none' },
        });
        expect(result.status, restoreFailureContext(result)).toBe('success');
        expect(result.restoredRowCount).toBe(configuration.rowCount);
        const count = await fixture.client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${fixture.qualified('items')}`,
        );
        expect(count.rows[0]?.count).toBe(String(configuration.rowCount));
        expect(await fixture.target.getTransactionStatus()).toBe('idle');
      } finally {
        await fixture.close();
      }
    },
  );

  it('cancels at a deterministic COPY byte offset with bounded cleanup latency', async () => {
    const fixture = await NativeRestoreFixture.create('native_stress_cancel');
    const configuration = resolveRestoreWorkloadConfiguration({
      profile: 'ci',
      shape: 'wide',
      rowCount: 250_000,
      chunkBytes: 32 * 1024,
    });
    const source = createRestoreStressArchive(fixture, configuration);
    const controller = new AbortController();
    const abortAfterBytes = 2 * 1024 * 1024;
    let abortedAt: number | undefined;
    const memory = new RestoreMemorySampler();

    try {
      memory.start();
      const result = await createRestoreEngine().restore({
        archive: source.archive,
        target: fixture.target,
        options: { transactionMode: 'single', validationLevel: 'none' },
        signal: controller.signal,
        onProgress: (event) => {
          if (
            abortedAt === undefined &&
            event.event === 'step-progress' &&
            (event.bytesRestored ?? 0) >= abortAfterBytes
          ) {
            abortedAt = performance.now();
            controller.abort(new Error('stress cancellation'));
          }
        },
      });
      const completedAt = performance.now();
      const summary = memory.stop();
      const cancellationLatencyMilliseconds = completedAt - abortedAt!;
      expect(result.status).toBe('cancelled');
      expect(abortedAt).toBeDefined();
      expect(cancellationLatencyMilliseconds).toBeLessThan(
        environmentBound('RESTORE_TEST_MAX_CANCEL_MS', DEFAULT_MAX_CANCELLATION_MILLISECONDS),
      );
      expect(source.telemetry.rowsGenerated).toBeLessThan(configuration.rowCount);
      expect(source.telemetry.destroyed).toBe(true);
      expect(source.archive.closed).toBe(true);
      expect(await fixture.relationExists('items')).toBe(false);
      expect(await fixture.target.getTransactionStatus()).toBe('idle');
      await expect(fixture.client.query('SELECT 1')).resolves.toMatchObject({ rowCount: 1 });
      const measurement = benchmarkResult(
        'stress-cancellation',
        configuration,
        result,
        summary,
        0,
        {
          validationLevel: 'none',
          transactionMode: 'single',
          cancellationLatencyMilliseconds,
        },
      );
      await saveRestoreBenchmarkArtifact(
        {
          generatedAt: new Date().toISOString(),
          warmupRuns: 0,
          measuredRuns: 1,
          measurements: [measurement],
          median: measurement,
        },
        'test-output/restore-performance/stress-cancellation.json',
      );
      process.stdout.write(
        `Cancellation cleanup latency: ${cancellationLatencyMilliseconds.toFixed(1)} ms\n`,
      );
    } finally {
      memory.stop();
      await fixture.close();
    }
  });

  it('stops consuming a large payload after invalid COPY data and rolls back cleanly', async () => {
    const fixture = await NativeRestoreFixture.create('native_stress_invalid');
    const invalidRow = 2_000;
    const configuration = resolveRestoreWorkloadConfiguration({
      profile: 'smoke',
      shape: 'mixed',
      rowCount: 20_000,
      chunkBytes: 16 * 1024,
      sourceDelayMilliseconds: 1,
      corruptRow: invalidRow,
    });
    const source = createRestoreStressArchive(fixture, configuration);

    try {
      const result = await createRestoreEngine().restore({
        archive: source.archive,
        target: fixture.target,
        options: { transactionMode: 'single', validationLevel: 'none' },
      });
      expect(result.status).toBe('failed');
      expect(result.tableDataFailedCount).toBe(1);
      expect(source.telemetry.rowsGenerated).toBeLessThan(configuration.rowCount);
      expect(source.telemetry.rowsGenerated).toBeGreaterThanOrEqual(invalidRow);
      expect(source.telemetry.destroyed).toBe(true);
      expect(await fixture.relationExists('items')).toBe(false);
      expect(await fixture.target.getTransactionStatus()).toBe('idle');
    } finally {
      await fixture.close();
    }
  });
});
