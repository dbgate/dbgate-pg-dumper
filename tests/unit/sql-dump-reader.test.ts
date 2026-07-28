import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  detectSqlDumpFormat,
  isDumperSqlDump,
  isPgDumpSqlDump,
  SqlDumpReader,
  SqlDumpRestoreError,
} from '../../src/index.js';

const HEADER = '--\n-- dbgate-pg-dumper PostgreSQL schema dump\n--\n\n';
const PG_DUMP_HEADER = '--\n-- PostgreSQL database dump\n--\n\n';

function chunked(text: string, size = 1): Readable {
  const bytes = Buffer.from(text);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
  }
  return Readable.from(chunks);
}

async function readText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const emitted of stream) {
    const chunk: unknown = emitted;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new TypeError('Expected a byte stream.');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function countBytes(stream: Readable): Promise<number> {
  let bytes = 0;
  for await (const emitted of stream) {
    const chunk: unknown = emitted;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new TypeError('Expected a byte stream.');
    }
    bytes += chunk.byteLength;
  }
  return bytes;
}

describe('dbgate plain-SQL dump reader', () => {
  it('detects the package header from a leading string or byte sample', () => {
    expect(isDumperSqlDump(HEADER)).toBe(true);
    expect(isDumperSqlDump(Buffer.from(HEADER))).toBe(true);
    expect(isDumperSqlDump('-- PostgreSQL database dump')).toBe(false);
    expect(isPgDumpSqlDump(PG_DUMP_HEADER)).toBe(true);
    expect(detectSqlDumpFormat(HEADER)).toBe('dbgate');
    expect(detectSqlDumpFormat(PG_DUMP_HEADER)).toBe('pg-dump');
    expect(isDumperSqlDump(`SELECT '${HEADER.trim()}';`)).toBe(false);
  });

  it('parses pg_dump plain SQL and ignores only its restrict guards', async () => {
    const token = 'safe-token';
    const sql =
      PG_DUMP_HEADER +
      `\\restrict ${token}\n\n` +
      `CREATE TABLE public.items (id integer, value text);\n` +
      `COPY public.items (id, value) FROM stdin;\n` +
      `1\tone\n\\.\n\n` +
      `\\unrestrict ${token}\n`;
    const reader = new SqlDumpReader(chunked(sql));

    expect(await reader.nextOperation()).toMatchObject({ kind: 'sql' });
    const copy = await reader.nextOperation();
    expect(copy).toMatchObject({ kind: 'copy', table: { schema: 'public', table: 'items' } });
    if (copy?.kind !== 'copy') throw new Error('Expected COPY operation.');
    expect(await readText(copy.payload)).toBe('1\tone\n');
    expect(await reader.nextOperation()).toBeUndefined();
    expect(reader.location.offset).toBe(Buffer.byteLength(sql));
  });

  it('parses statements and COPY across every possible one-byte stream boundary', async () => {
    const sql =
      HEADER +
      `CREATE TABLE "odd schema"."semi;table" ("id" integer, "payload" text);\n` +
      `/* outer ; /* nested ; */ done */\n` +
      `CREATE FUNCTION "odd schema"."f"() RETURNS text LANGUAGE plpgsql AS $body$\n` +
      `BEGIN\n  -- this semicolon is inside a body ;\n` +
      `  RETURN 'quoted;value';\nEND;\n$body$;\n` +
      `COPY "odd schema"."semi;table" ("id", "payload") FROM stdin;\n` +
      `1\tone\\nline\n2\tliteral\\\\N\n\\.\n` +
      `INSERT INTO "odd schema"."semi;table" VALUES (3, E'backslash\\';still-string');\n` +
      `SELECT 'ends-with-backslash\\';\n`;
    const reader = new SqlDumpReader(chunked(sql));

    const create = await reader.nextOperation();
    expect(create).toMatchObject({ kind: 'sql' });
    expect(create?.sql).toContain('CREATE TABLE "odd schema"."semi;table"');

    const routine = await reader.nextOperation();
    expect(routine).toMatchObject({ kind: 'sql' });
    expect(routine?.sql).toContain(`RETURN 'quoted;value';`);

    const copy = await reader.nextOperation();
    expect(copy).toMatchObject({
      kind: 'copy',
      table: { schema: 'odd schema', table: 'semi;table' },
      columns: ['id', 'payload'],
    });
    if (copy?.kind !== 'copy') throw new Error('Expected COPY operation.');
    expect(await readText(copy.payload)).toBe(`1\tone\\nline\n2\tliteral\\\\N\n`);

    const insert = await reader.nextOperation();
    expect(insert).toMatchObject({ kind: 'sql' });
    expect(insert?.sql).toContain(`E'backslash\\';still-string'`);
    const standardString = await reader.nextOperation();
    expect(standardString?.sql).toBe(`SELECT 'ends-with-backslash\\';`);
    expect(await reader.nextOperation()).toBeUndefined();
    expect(reader.location).toEqual({
      offset: Buffer.byteLength(sql),
      line: sql.split('\n').length,
      column: 1,
    });
    await reader.close();
  });

  it('preserves doubled quotes, line comments, block comments, and untagged dollar bodies', async () => {
    const sql =
      HEADER +
      `SELECT 'it''s;safe', "semi;""identifier"; -- ignored ;\n` +
      `DO $$ BEGIN PERFORM 'inside;body'; /* ; */ END $$;\n`;
    const reader = new SqlDumpReader(chunked(sql, 2));
    const first = await reader.nextOperation();
    const second = await reader.nextOperation();
    expect(first?.sql).toContain(`'it''s;safe'`);
    expect(first?.sql).toContain(`"semi;""identifier"`);
    expect(second?.sql).toContain(`PERFORM 'inside;body';`);
    expect(await reader.nextOperation()).toBeUndefined();
  });

  it('does not skip the next statement when a semicolon ends a stream chunk', async () => {
    const statements = [
      `SET statement_timeout = 0;`,
      `SET lock_timeout = 0;`,
      `SET client_encoding = 'UTF8';`,
      `SET standard_conforming_strings = on;`,
      `SET check_function_bodies = false;`,
      `SET client_min_messages = warning;`,
      `SET row_security = off;`,
      `SET bytea_output = 'hex';`,
    ];
    const reader = new SqlDumpReader(chunked(`${HEADER}${statements.join('\n')}\n`, 17));

    const actual: string[] = [];
    for (;;) {
      const operation = await reader.nextOperation();
      if (!operation) break;
      if (operation.kind !== 'sql') throw new Error('Expected a SQL operation.');
      actual.push(operation.sql);
    }

    expect(actual).toEqual(statements);
  });

  it('rejects non-package SQL, psql meta-commands, malformed statements, and missing COPY markers', async () => {
    await expect(new SqlDumpReader(chunked('SELECT 1;')).nextOperation()).rejects.toMatchObject({
      code: 'RESTORE_SQL_DUMP_INVALID',
      line: 1,
    });

    const meta = new SqlDumpReader(chunked(`${HEADER}\\connect other\nSELECT 1;`));
    await expect(meta.nextOperation()).rejects.toThrow('Only pg_dump');

    const malformed = new SqlDumpReader(chunked(`${HEADER}DO $tag$ SELECT 1;`));
    await expect(malformed.nextOperation()).rejects.toBeInstanceOf(SqlDumpRestoreError);

    const unsupportedCopy = new SqlDumpReader(
      chunked(`${HEADER}COPY public.items (id) FROM STDIN WITH (FORMAT csv);\n`),
    );
    await expect(unsupportedCopy.nextOperation()).rejects.toThrow(
      'COPY FROM STDIN variant is not supported',
    );

    const copy = new SqlDumpReader(chunked(`${HEADER}COPY public.items (id) FROM stdin;\n1\n`));
    const operation = await copy.nextOperation();
    if (operation?.kind !== 'copy') throw new Error('Expected COPY operation.');
    await expect(readText(operation.payload)).rejects.toThrow('terminating');
  });

  it('bounds SQL statement buffering without applying the limit to COPY payloads', async () => {
    const oversized = new SqlDumpReader(chunked(`${HEADER}SELECT '${'x'.repeat(100)}';`), {
      maxStatementBytes: 64,
    });
    await expect(oversized.nextOperation()).rejects.toThrow('64-byte limit');

    const copy = new SqlDumpReader(
      chunked(`${HEADER}COPY public.items (payload) FROM stdin;\n${'x'.repeat(1_000)}\n\\.\n`),
      { maxStatementBytes: 128 },
    );
    const operation = await copy.nextOperation();
    if (operation?.kind !== 'copy') throw new Error('Expected COPY operation.');
    expect((await readText(operation.payload)).length).toBe(1_001);
  });

  it('streams a COPY row larger than 16 MiB through chunk boundaries', async () => {
    const payloadBytes = 16 * 1024 * 1024 + 257;
    const copy = new SqlDumpReader(
      chunked(
        `${HEADER}COPY public.items (payload) FROM stdin;\n${'x'.repeat(payloadBytes)}\n\\.\n`,
        64 * 1024,
      ),
    );

    const operation = await copy.nextOperation();
    if (operation?.kind !== 'copy') throw new Error('Expected COPY operation.');
    expect(await countBytes(operation.payload)).toBe(payloadBytes + 1);
    expect(await copy.nextOperation()).toBeUndefined();
  });
});
