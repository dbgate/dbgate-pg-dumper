/**
 * Plain data serialization tests focus on PostgreSQL COPY semantics, canonical
 * text fidelity, bounded INSERT statements, identity safety, and cancellation.
 */

import { describe, expect, it } from 'vitest';

import {
  DataSerializationError,
  PlainDataSerializer,
  StringDumpWriter,
  escapeCopyText,
  type ColumnExportDescriptor,
  type DataExportBatch,
  type NormalizedPostgresValue,
  type TableDataExportDescriptor,
} from '../../src/index.js';

function column(
  name: string,
  formattedType = 'text',
  typeOid = 25,
  identity?: 'always' | 'by-default',
): ColumnExportDescriptor {
  return {
    ordinalPosition: 1,
    attributeNumber: 1,
    name,
    quotedName: `"${name}"`,
    formattedType,
    typeOid,
    binaryCompatible: typeOid === 17,
    nullable: true,
    generated: false,
    ...(identity === undefined ? {} : { identity }),
    dropped: false,
    formatter: typeOid === 17 ? 'binary' : 'text',
  };
}

function table(columns: readonly ColumnExportDescriptor[]): TableDataExportDescriptor {
  return {
    kind: 'table',
    relationOid: 10,
    schema: 'odd schema',
    name: 'data',
    estimatedRowCount: 2,
    persistence: 'permanent',
    replicaIdentity: { mode: 'default', columns: [] },
    partition: { kind: 'ordinary' },
    identityColumns: columns.flatMap((item) => (item.identity === undefined ? [] : [item.name])),
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

function value(text: string | null, item: ColumnExportDescriptor): NormalizedPostgresValue {
  return {
    kind: text === null ? 'null' : item.typeOid === 17 ? 'binary' : 'text',
    typeOid: item.typeOid,
    formattedType: item.formattedType,
    value: text,
    binary: item.typeOid === 17,
    representation: 'canonical-text',
  };
}

function batch(
  descriptor: TableDataExportDescriptor,
  rows: readonly (readonly (string | null)[])[],
): DataExportBatch {
  return {
    table: descriptor,
    batchNumber: 1,
    firstRowNumber: 1,
    rows: rows.map((row) => ({
      values: row.map((item, index) => value(item, descriptor.columns[index]!)),
    })),
    bytesRead: 0,
  };
}

describe('COPY text escaping', () => {
  it.each([
    ['', ''],
    ['\\N', '\\\\N'],
    ['\\.', '\\\\.'],
    ['\\\\leading', '\\\\\\\\leading'],
    ['trailing\\', 'trailing\\\\'],
    ['a\tb', 'a\\tb'],
    ['a\nb', 'a\\nb'],
    ['a\r\nb\rc', 'a\\r\\nb\\rc'],
    ['\b\f\v', '\\b\\f\\v'],
    ['\0\u0001\u001f\u007f', '\\000\\001\\037\\177'],
    ['Žluťoučký 🦊', 'Žluťoučký 🦊'],
  ])('escapes %j exactly', (input, expected) => {
    expect(escapeCopyText(input)).toBe(expected);
  });

  it('emits NULL, empty text, control-like text, and a safe terminator', async () => {
    const descriptor = table([column('payload')]);
    const writer = new StringDumpWriter();
    const serializer = new PlainDataSerializer({
      writer,
      tables: [descriptor],
      targetSupportsIdentityOverride: true,
    });
    await serializer.consume(batch(descriptor, [[null], [''], ['\\N'], ['\\.'], ['a\tb\nc']]));
    const result = await serializer.finish();

    expect(writer.toString()).toBe(
      'COPY "odd schema".data ("payload") FROM stdin;\n' +
        '\\N\n\n\\\\N\n\\\\.\na\\tb\\nc\n\\.\n\n',
    );
    expect(result).toMatchObject({
      totalRows: 5,
      copyBlocks: 1,
      insertStatements: 0,
      incomplete: false,
    });
  });

  it('coalesces large COPY batches into bounded output writes', async () => {
    class CountingWriter extends StringDumpWriter {
      writeCalls = 0;

      override write(chunk: string | Uint8Array, signal?: AbortSignal): Promise<void> {
        this.writeCalls += 1;
        return super.write(chunk, signal);
      }
    }

    const descriptor = table([column('payload')]);
    const writer = new CountingWriter();
    const serializer = new PlainDataSerializer({
      writer,
      tables: [descriptor],
      targetSupportsIdentityOverride: true,
    });
    const rows = Array.from({ length: 1_000 }, (_, index) => [`row-${index}`]);

    await serializer.consume(batch(descriptor, rows));
    const result = await serializer.finish();

    expect(result.totalRows).toBe(1_000);
    expect(writer.writeCalls).toBeLessThan(10);
  });

  it('omits COPY blocks for empty tables deterministically', async () => {
    const descriptor = table([column('payload')]);
    const writer = new StringDumpWriter();
    const serializer = new PlainDataSerializer({
      writer,
      tables: [descriptor],
      targetSupportsIdentityOverride: true,
    });
    const result = await serializer.finish();
    expect(writer.toString()).toBe('');
    expect(result).toMatchObject({
      tablesProcessed: 0,
      tablesSkipped: 1,
      totalRows: 0,
      copyBlocks: 0,
    });
  });
});

describe('INSERT serialization', () => {
  it('uses canonical text, safe quoting, bytea hex, NULL, and explicit casts', async () => {
    const descriptor = table([
      column('n', 'numeric', 1700),
      { ...column('bytes', 'bytea', 17), ordinalPosition: 2, attributeNumber: 2 },
      { ...column('json', 'jsonb', 3802), ordinalPosition: 3, attributeNumber: 3 },
      { ...column('items', 'integer[]', 1007), ordinalPosition: 4, attributeNumber: 4 },
      { ...column('period', 'int4range', 3904), ordinalPosition: 5, attributeNumber: 5 },
    ]);
    const writer = new StringDumpWriter();
    const serializer = new PlainDataSerializer({
      writer,
      tables: [descriptor],
      targetSupportsIdentityOverride: true,
      options: { mode: 'column-inserts' },
    });
    await serializer.consume(
      batch(descriptor, [
        [
          '9007199254740993.0000000000000001',
          '\\x00ff',
          `{"quote":"'","n":9007199254740993}`,
          '{1,NULL,"3"}',
          '[1,10)',
        ],
        [null, '\\x', '{}', '{}', 'empty'],
      ]),
    );
    const result = await serializer.finish();
    const output = writer.toString();

    expect(output).toContain(`'9007199254740993.0000000000000001'::numeric, '\\x00ff'::bytea`);
    expect(output).toContain(`'{"quote":"''","n":9007199254740993}'::jsonb`);
    expect(output).toContain(`'{1,NULL,"3"}'::integer[]`);
    expect(output).toContain(`'[1,10)'::int4range`);
    expect(output).toContain(`(NULL, '\\x'::bytea, '{}'::jsonb`);
    expect(result).toMatchObject({ totalRows: 2, insertStatements: 1, copyBlocks: 0 });
  });

  it('flushes at row and byte limits without reordering rows', async () => {
    const descriptor = table([column('payload')]);
    const writer = new StringDumpWriter();
    const serializer = new PlainDataSerializer({
      writer,
      tables: [descriptor],
      targetSupportsIdentityOverride: true,
      options: { mode: 'inserts', rowsPerInsert: 2, maxInsertStatementBytes: 90 },
    });
    await serializer.consume(
      batch(descriptor, [['first'], ['second'], ['x'.repeat(70)], ['last']]),
    );
    const result = await serializer.finish();
    expect(result.insertStatements).toBeGreaterThanOrEqual(3);
    const output = writer.toString();
    expect(output.indexOf('first')).toBeLessThan(output.indexOf('second'));
    expect(output.indexOf('second')).toBeLessThan(output.indexOf('last'));
  });

  it('preserves GENERATED ALWAYS identity values with target-compatible syntax', async () => {
    const identity = column('id', 'bigint', 20, 'always');
    const descriptor = table([identity]);
    const writer = new StringDumpWriter();
    const serializer = new PlainDataSerializer({
      writer,
      tables: [descriptor],
      targetSupportsIdentityOverride: true,
      options: { mode: 'inserts' },
    });
    await serializer.consume(batch(descriptor, [['9223372036854775807']]));
    await serializer.finish();
    expect(writer.toString()).toContain(
      'INSERT INTO "odd schema".data ("id") OVERRIDING SYSTEM VALUE VALUES',
    );
  });

  it('fails before emitting a row when identity values cannot be restored safely', async () => {
    const descriptor = table([column('id', 'bigint', 20, 'always')]);
    const serializer = new PlainDataSerializer({
      writer: new StringDumpWriter(),
      tables: [descriptor],
      targetSupportsIdentityOverride: false,
      options: { mode: 'inserts' },
    });
    await expect(serializer.consume(batch(descriptor, [['1']]))).rejects.toBeInstanceOf(
      DataSerializationError,
    );
  });

  it('honors cancellation before writing a batch', async () => {
    const controller = new AbortController();
    controller.abort();
    const descriptor = table([column('payload')]);
    const serializer = new PlainDataSerializer({
      writer: new StringDumpWriter(),
      tables: [descriptor],
      targetSupportsIdentityOverride: true,
      signal: controller.signal,
    });
    await expect(serializer.consume(batch(descriptor, [['secret']]))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('marks a recoverable best-effort table fragment visibly incomplete', async () => {
    const descriptor = table([column('payload')]);
    const writer = new StringDumpWriter();
    const serializer = new PlainDataSerializer({
      writer,
      tables: [descriptor],
      targetSupportsIdentityOverride: true,
    });
    await serializer.consume(batch(descriptor, [['kept']]));
    await serializer.recoverTable({
      code: 'cursor-failure',
      severity: 'error',
      message: 'The table cursor failed while reading data.',
      tableIdentity: 'odd schema.data',
    });
    const result = await serializer.finish();
    expect(writer.toString()).toContain(
      '-- WARNING: INCOMPLETE table data for odd schema.data; see dump diagnostics.',
    );
    expect(result.incomplete).toBe(true);
  });
});
