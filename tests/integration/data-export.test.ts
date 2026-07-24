/**
 * Docker-backed bounded-memory data export verification.
 *
 * This suite intentionally consumes normalized batches without serializing
 * them, proving that relation size does not determine application buffering.
 */

import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DataExportEngine,
  DataExportPlanner,
  inspectDumpArchive,
  introspectPostgres,
} from '../../src/index.js';
import { fromPgClient } from '../../src/pg.js';

const servers = [
  {
    major: 9,
    url: process.env.PG96_URL ?? 'postgresql://dumper:dumper@127.0.0.1:55496/dumper_test',
  },
  {
    major: 13,
    url: process.env.PG13_URL ?? 'postgresql://dumper:dumper@127.0.0.1:55113/dumper_test',
  },
  {
    major: 18,
    url: process.env.PG18_URL ?? 'postgresql://dumper:dumper@127.0.0.1:55118/dumper_test',
  },
].filter(
  (server) =>
    process.env.PG_TEST_MAJOR === undefined || server.major === Number(process.env.PG_TEST_MAJOR),
);

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.end()));
});

async function createDataFixtures(
  client: Client,
  major: number,
  rowCount: number,
): Promise<number> {
  await client.query(`
    DROP SCHEMA IF EXISTS data_fixture CASCADE;
    CREATE SCHEMA data_fixture;
    CREATE TYPE data_fixture.mood AS ENUM ('sad', 'ok', 'happy');

    CREATE TABLE data_fixture.large_rows (
      id bigint NOT NULL,
      nullable_text text,
      payload text
    );
    INSERT INTO data_fixture.large_rows
    SELECT value,
           CASE WHEN value % 3 = 0 THEN NULL ELSE 'row-' || value::text END,
           repeat('x', 64)
    FROM generate_series(1, ${rowCount}) AS value;

    CREATE TABLE data_fixture.special_values (
      id integer,
      raw bytea,
      document jsonb,
      numbers integer[],
      mood data_fixture.mood,
      identifier uuid,
      active boolean,
      bounds int4range,
      unicode_text text
    );
    INSERT INTO data_fixture.special_values VALUES (
      1,
      decode('00ff017f', 'hex'),
      jsonb_build_object('emoji', U&'\\+01F98A', 'nested', jsonb_build_array(true, NULL, 42)),
      ARRAY[1,NULL,3],
      'happy',
      '123e4567-e89b-12d3-a456-426614174000',
      true,
      '[1,10)',
      U&'P\\0159\\00EDli\\0161 \\017Elu\\0165ou\\010Dk\\00FD k\\016F\\0148 \\+01F98A'
    );

    CREATE TABLE data_fixture.toast_values (id integer, payload text);
    INSERT INTO data_fixture.toast_values VALUES (1, repeat(U&'\\+01F98A', 300000));
  `);

  let extraRows = 2;
  if (major >= 10) {
    await client.query(`
      CREATE TABLE data_fixture.partitioned_values (
        id integer,
        created_on date
      ) PARTITION BY RANGE (created_on);
      CREATE TABLE data_fixture.partitioned_values_2025
        PARTITION OF data_fixture.partitioned_values
        FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
      INSERT INTO data_fixture.partitioned_values
      VALUES (1, '2025-02-01'), (2, '2025-03-01');
    `);
    extraRows += 2;
  }
  if (major >= 14) {
    await client.query(`
      CREATE TABLE data_fixture.multirange_values (value int4multirange);
      INSERT INTO data_fixture.multirange_values VALUES ('{[1,3),[8,10)}');
    `);
    extraRows += 1;
  }
  return rowCount + extraRows;
}

describe.each(servers)('PostgreSQL $major data export', ({ major, url }) => {
  it('streams one million rows and complex values with bounded memory', async () => {
    const client = new Client({ connectionString: url });
    clients.push(client);
    await client.connect();
    const connection = fromPgClient(client);
    const rowCount = Number(process.env.DATA_EXPORT_ROWS ?? 1_000_000);
    const expectedRows = await createDataFixtures(client, major, rowCount);
    const selection = { includeSchemas: ['data_fixture'] };
    const introspection = await introspectPostgres(connection, { selection });
    const archive = inspectDumpArchive(introspection.database, {
      selection: { mode: 'data-only' },
    });

    await connection.query({ text: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' });
    const plan = new DataExportPlanner().plan(archive, {
      batchSize: 1_000,
      fetchSize: 1_000,
      adapterStreamingAvailable: true,
    });
    const baselineHeap = process.memoryUsage().heapUsed;
    let maximumHeap = baselineHeap;
    let maximumBatchRows = 0;
    let sawBinary = false;
    let sawArray = false;
    let sawJson = false;
    let sawRange = false;
    let sawMultirange = major < 14;
    try {
      const result = await new DataExportEngine().export({ connection, plan }, (batch) => {
        maximumBatchRows = Math.max(maximumBatchRows, batch.rows.length);
        maximumHeap = Math.max(maximumHeap, process.memoryUsage().heapUsed);
        for (const row of batch.rows) {
          for (const value of row.values) {
            sawBinary ||= value.kind === 'binary';
            sawArray ||= value.kind === 'array';
            sawJson ||= value.kind === 'json';
            sawRange ||= value.kind === 'range';
            sawMultirange ||= value.kind === 'multirange';
          }
        }
      });
      expect(result.rowsExported).toBe(expectedRows);
      expect(result.cancelled).toBe(false);
      expect(maximumBatchRows).toBeLessThanOrEqual(1_000);
      expect(maximumHeap - baselineHeap).toBeLessThan(192 * 1024 * 1024);
      expect({ sawBinary, sawArray, sawJson, sawRange, sawMultirange }).toEqual({
        sawBinary: true,
        sawArray: true,
        sawJson: true,
        sawRange: true,
        sawMultirange: true,
      });
    } finally {
      await connection.query({ text: 'ROLLBACK' });
    }
  }, 120_000);
});
