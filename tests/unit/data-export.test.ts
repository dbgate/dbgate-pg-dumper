/**
 * Format-neutral data export tests cover planning, bounded batches, cursor
 * cleanup, progress, cancellation, and shallow value normalization.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import type {
  ArchiveEntry,
  ColumnExportDescriptor,
  DumpArchiveInspection,
  PostgresConnection,
  PostgresQuery,
  PostgresQueryResult,
  PostgresRow,
  TableDataExportDescriptor,
} from '../../src/index.js';
import { DataExportEngine, DataExportPlanner, PostgresValueNormalizer } from '../../src/index.js';

function column(
  name: string,
  typeOid: number,
  formattedType: string,
  formatter: ColumnExportDescriptor['formatter'],
  ordinalPosition = 1,
): ColumnExportDescriptor {
  return {
    ordinalPosition,
    attributeNumber: ordinalPosition,
    name,
    quotedName: name,
    formattedType,
    typeOid,
    binaryCompatible: formatter === 'binary',
    nullable: true,
    generated: false,
    dropped: false,
    formatter,
  };
}

function descriptor(
  columns: readonly ColumnExportDescriptor[] = [column('id', 23, 'integer', 'integer')],
): TableDataExportDescriptor {
  return {
    kind: 'table',
    relationOid: 10,
    schema: 'app',
    name: 'items',
    estimatedRowCount: 12,
    persistence: 'permanent',
    primaryKey: { name: 'items_pkey', columns: ['id'] },
    replicaIdentity: { mode: 'default', columns: ['id'] },
    partition: { kind: 'ordinary' },
    identityColumns: [],
    generatedColumns: [],
    columns,
    exportMode: 'rows',
    streamingStrategy: 'auto',
    valueReadStrategy: 'canonical-text',
    rowLevelSecurity: false,
    forceRowLevelSecurity: false,
    defaultDataPolicy: 'include',
  };
}

function archive(data = descriptor()): DumpArchiveInspection {
  const entry: ArchiveEntry = {
    dumpId: 'data-items',
    archiveIdentity: 'table-data:app:items',
    catalogOid: 10,
    objectType: 'table-data',
    schema: 'app',
    name: 'items',
    specificIdentity: '',
    section: 'data',
    dependencyDumpIds: [],
    dependencies: [],
    selection: { selected: true, reason: 'explicit', requiredByDumpIds: [] },
    dataExport: data,
    sourceObject: {},
    diagnostics: [],
  };
  return {
    valid: true,
    entries: [entry],
    orderedEntries: [entry],
    orderedDumpIds: [entry.dumpId],
    diagnostics: [],
  };
}

function streamingConnection(rows: readonly PostgresRow[]): PostgresConnection {
  return {
    query: () => Promise.reject(new Error('query fallback should not run')),
    stream<Row extends PostgresRow>() {
      return (async function* () {
        await Promise.resolve();
        for (const row of rows) yield row as Row;
      })();
    },
    getTransactionStatus: () => Promise.resolve('in-transaction'),
  };
}

describe('DataExportPlanner', () => {
  it('creates a deterministic sequential plan with bounded settings', () => {
    const plan = new DataExportPlanner().plan(archive(), {
      batchSize: 2,
      fetchSize: 4,
      adapterStreamingAvailable: true,
    });
    expect(plan).toMatchObject({
      sequential: true,
      transactionUsage: 'existing-snapshot',
      totalEstimatedRows: 12,
      tables: [
        {
          order: 0,
          tableIdentity: 'app.items',
          batchSize: 2,
          fetchSize: 4,
          strategy: 'adapter-cursor',
          parallelReadEligible: true,
        },
      ],
    });
  });

  it('rejects unbounded or invalid batch settings', () => {
    expect(() => new DataExportPlanner().plan(archive(), { batchSize: 0 })).toThrow(RangeError);
  });

  it('omits foreign-table data by default and supports explicit opt-in', () => {
    const foreign = {
      ...descriptor(),
      partition: { kind: 'foreign' as const },
      defaultDataPolicy: 'omit-foreign' as const,
    };
    const omitted = new DataExportPlanner().plan(archive(foreign));
    expect(omitted.tables).toHaveLength(0);
    expect(omitted).toMatchObject({
      omittedTableIdentities: ['app.items'],
      diagnostics: [{ code: 'foreign-table-omitted' }],
    });
    expect(
      new DataExportPlanner().plan(archive(foreign), { includeForeignTables: true }).tables,
    ).toHaveLength(1);
  });

  it('makes row-security behavior explicit', () => {
    const secured = {
      ...descriptor(),
      rowLevelSecurity: true,
    };
    const plan = new DataExportPlanner().plan(archive(secured), {
      rowSecurityMode: 'disable',
    });
    expect(plan).toMatchObject({
      rowSecurityMode: 'disable',
      requiresRowSecurityDisable: true,
      diagnostics: [{ code: 'row-security-active' }],
    });
    expect(() =>
      new DataExportPlanner().plan(archive(secured), {
        rowSecurityMode: 'require-complete',
      }),
    ).toThrowError(/complete export/u);
  });
});

describe('DataExportEngine', () => {
  it('streams bounded normalized batches and reports progress', async () => {
    const plan = new DataExportPlanner().plan(archive(), {
      batchSize: 2,
      adapterStreamingAvailable: true,
    });
    const batches: number[] = [];
    const phases: string[] = [];
    const result = await new DataExportEngine().export(
      {
        connection: streamingConnection([{ id: 1 }, { id: 2 }, { id: 3 }, { id: null }]),
        plan,
        onProgress: (event) => phases.push(event.phase),
      },
      (batch) => {
        batches.push(batch.rows.length);
        expect(batch.rows.length).toBeLessThanOrEqual(2);
      },
    );
    expect(batches).toEqual([2, 2]);
    expect(result).toMatchObject({
      tablesCompleted: 1,
      rowsExported: 4,
      batchesExported: 2,
      cancelled: false,
    });
    expect(phases).toEqual([
      'preparing',
      'table-starting',
      'batch-exported',
      'rows-exported',
      'batch-exported',
      'rows-exported',
      'table-completed',
      'completed',
    ]);
  });

  it('uses DECLARE/FETCH/CLOSE and always closes the SQL cursor', async () => {
    const calls: string[] = [];
    let fetches = 0;
    const connection: PostgresConnection = {
      query<Row extends PostgresRow>(query: PostgresQuery): Promise<PostgresQueryResult<Row>> {
        calls.push(query.text);
        if (query.text.startsWith('FETCH')) {
          fetches += 1;
          const rows = fetches === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
          return Promise.resolve({ rows: rows as unknown as Row[], rowCount: rows.length });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      getTransactionStatus: () => Promise.resolve('in-transaction'),
    };
    const plan = new DataExportPlanner().plan(archive(), {
      batchSize: 2,
      fetchSize: 2,
      adapterStreamingAvailable: false,
    });
    const result = await new DataExportEngine().export({ connection, plan }, () => {});
    expect(result.rowsExported).toBe(3);
    expect(calls[0]).toMatch(/^DECLARE "dbgate_data_\d+" NO SCROLL CURSOR/u);
    expect(calls.filter((sql) => sql.startsWith('FETCH'))).toHaveLength(2);
    expect(calls.at(-1)).toMatch(/^CLOSE "dbgate_data_\d+"/u);
  });

  it('closes its cursor and returns cancellation diagnostics', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let fetched = false;
    const connection: PostgresConnection = {
      query<Row extends PostgresRow>(query: PostgresQuery): Promise<PostgresQueryResult<Row>> {
        calls.push(query.text);
        if (query.text.startsWith('FETCH') && !fetched) {
          fetched = true;
          return Promise.resolve({
            rows: [{ id: 1 }, { id: 2 }] as unknown as Row[],
            rowCount: 2,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      getTransactionStatus: () => Promise.resolve('in-transaction'),
    };
    const plan = new DataExportPlanner().plan(archive(), {
      batchSize: 1,
      fetchSize: 2,
    });
    const result = await new DataExportEngine().export(
      { connection, plan, signal: controller.signal },
      () => controller.abort(),
    );
    expect(result.cancelled).toBe(true);
    expect(result.diagnostics).toMatchObject([{ code: 'cancelled-export' }]);
    expect(calls.at(-1)).toMatch(/^CLOSE /u);
  });

  it('handles cancellation before opening a cursor', async () => {
    const controller = new AbortController();
    controller.abort();
    const plan = new DataExportPlanner().plan(archive(), {
      adapterStreamingAvailable: true,
    });
    const result = await new DataExportEngine().export(
      {
        connection: streamingConnection([{ id: 1 }]),
        plan,
        signal: controller.signal,
      },
      () => {
        throw new Error('no batch expected');
      },
    );
    expect(result).toMatchObject({
      cancelled: true,
      rowsExported: 0,
      diagnostics: [{ code: 'cancelled-export' }],
    });
  });

  it('requires the caller-owned consistent transaction', async () => {
    const connection = streamingConnection([]);
    connection.getTransactionStatus = () => Promise.resolve('idle');
    const plan = new DataExportPlanner().plan(archive(), {
      adapterStreamingAvailable: true,
    });
    await expect(
      new DataExportEngine().export({ connection, plan }, () => {}),
    ).rejects.toMatchObject({
      code: 'DATA_EXPORT_FAILURE',
      diagnostic: { code: 'inconsistent-snapshot' },
    });
  });

  it('wraps failed batch consumers and closes the adapter iterator', async () => {
    let cleaned = false;
    const connection: PostgresConnection = {
      query: () => Promise.reject(new Error('unused')),
      stream<Row extends PostgresRow>() {
        return (async function* () {
          try {
            await Promise.resolve();
            yield { id: 1 } as unknown as Row;
            yield { id: 2 } as unknown as Row;
          } finally {
            cleaned = true;
          }
        })();
      },
      getTransactionStatus: () => Promise.resolve('in-transaction'),
    };
    const plan = new DataExportPlanner().plan(archive(), {
      batchSize: 1,
      adapterStreamingAvailable: true,
    });
    await expect(
      new DataExportEngine().export({ connection, plan }, () => {
        throw new Error('sink failed');
      }),
    ).rejects.toMatchObject({
      code: 'DATA_EXPORT_FAILURE',
      diagnostic: { code: 'failed-batch' },
    });
    expect(cleaned).toBe(true);
  });

  it('continues in explicit best-effort mode and returns an error diagnostic', async () => {
    const plan = new DataExportPlanner().plan(archive(), {
      batchSize: 1,
      adapterStreamingAvailable: true,
    });
    const recovered: string[] = [];
    const result = await new DataExportEngine().export(
      {
        connection: streamingConnection([{ id: '1' }]),
        plan,
        bestEffort: true,
        onRecoverableTableError: (diagnostic) => {
          recovered.push(diagnostic.code);
        },
      },
      () => {
        throw new Error('serialization failed');
      },
    );
    expect(recovered).toEqual(['failed-batch']);
    expect(result.diagnostics).toMatchObject([{ code: 'failed-batch', severity: 'error' }]);
  });
});

describe('PostgresValueNormalizer', () => {
  it('normalizes NULL, scalar, binary, array, JSON, and composite values without copying', () => {
    const normalizer = new PostgresValueNormalizer();
    const bytes = Buffer.from([0, 255, 1]);
    const array = [1, null, 3];
    const json = { emoji: '🦊', nested: [true] };
    const composite = { x: 1, label: 'point' };
    const binaryStream = new PassThrough();

    expect(normalizer.normalize(null, column('v', 25, 'text', 'text')).kind).toBe('null');
    expect(normalizer.normalize(true, column('v', 16, 'boolean', 'boolean')).kind).toBe('boolean');
    expect(
      normalizer.normalize('9007199254740993', column('v', 20, 'bigint', 'integer')).kind,
    ).toBe('integer');
    const binaryValue = normalizer.normalize(bytes, column('v', 17, 'bytea', 'binary'));
    expect(binaryValue).toMatchObject({ kind: 'binary', value: bytes, binary: true });
    expect(normalizer.normalize(binaryStream, column('v', 17, 'bytea', 'binary'))).toMatchObject({
      kind: 'binary',
      value: binaryStream,
      binary: true,
    });
    const arrayValue = normalizer.normalize(array, column('v', 1007, 'integer[]', 'array'));
    expect(arrayValue.value).toBe(array);
    const jsonValue = normalizer.normalize(json, column('v', 3802, 'jsonb', 'json'));
    expect(jsonValue).toMatchObject({ kind: 'json', value: json });
    const compositeValue = normalizer.normalize(
      composite,
      column('v', 40_000, 'app.point', 'composite'),
    );
    expect(compositeValue).toMatchObject({ kind: 'composite', value: composite });
    expect(
      normalizer.normalize('(1,point)', {
        ...column('v', 40_000, 'app.point', 'composite'),
        typeCategory: 'composite',
      }).kind,
    ).toBe('composite');
  });

  it.each([
    [2950, 'uuid', 'text', 'uuid'],
    [142, 'xml', 'text', 'xml'],
    [869, 'inet', 'network', 'network'],
    [1562, 'bit varying', 'bit-string', 'bit-string'],
    [1114, 'timestamp without time zone', 'temporal', 'timestamp'],
    [1184, 'timestamp with time zone', 'temporal', 'timestamptz'],
    [1082, 'date', 'temporal', 'date'],
    [1186, 'interval', 'temporal', 'interval'],
    [790, 'money', 'numeric', 'money'],
    [3904, 'int4range', 'range', 'range'],
    [4451, 'int4multirange', 'range', 'multirange'],
    [600, 'point', 'other', 'geometric'],
    [26, 'oid', 'integer', 'oid'],
  ] as const)('classifies PostgreSQL type %s', (oid, type, formatter, expected) => {
    expect(
      new PostgresValueNormalizer().normalize('value', column('v', oid, type, formatter)).kind,
    ).toBe(expected);
  });
});
