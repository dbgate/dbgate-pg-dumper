import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { dumpPostgres, isPgDumpSqlDump, restoreSqlDump } from '../../src/index.js';
import { fromPgClient } from '../../src/pg.js';

const configuredServers = [
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
];
const selectedMajor = process.env.PG_TEST_MAJOR;
const servers =
  selectedMajor === undefined
    ? configuredServers
    : configuredServers
        .filter((server) => server.major === Number(selectedMajor))
        .map((server) => ({ ...server, url: process.env.PG_TEST_URL ?? server.url }));

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.end()));
});

function collectingOutput(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
}

async function dumpWithPgDump(url: string, schema: string): Promise<Buffer> {
  const parsed = new URL(url);
  const container = process.env.PG_DUMP_DOCKER_CONTAINER;
  const executable = container === undefined ? (process.env.PG_DUMP ?? 'pg_dump') : 'docker';
  const pgDumpArguments = ['--format=plain', '--no-owner', '--no-privileges', '--schema', schema];
  const args =
    container === undefined
      ? ['--dbname', url, ...pgDumpArguments]
      : [
          'exec',
          '-e',
          `PGPASSWORD=${decodeURIComponent(parsed.password)}`,
          container,
          'pg_dump',
          '--username',
          decodeURIComponent(parsed.username),
          '--dbname',
          decodeURIComponent(parsed.pathname.slice(1)),
          ...pgDumpArguments,
        ];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`pg_dump failed with exit code ${String(code)}: ${stderr}`));
    });
  });
}

async function localPgDumpMajor(): Promise<number | undefined> {
  if (process.env.PG_DUMP_DOCKER_CONTAINER !== undefined) return undefined;
  const executable = process.env.PG_DUMP ?? 'pg_dump';
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`pg_dump --version failed with exit code ${String(code)}.`));
        return;
      }
      const match = /(\d+)(?:\.\d+)?/u.exec(output);
      resolve(match === null ? undefined : Number(match[1]));
    });
  });
}

describe.each(servers)('PostgreSQL $major sequential SQL restore', ({ major, url }) => {
  it('restores a generated schema, dollar-quoted function, and COPY payload natively', async () => {
    const client = new Client({ connectionString: url });
    clients.push(client);
    await client.connect();
    const connection = fromPgClient(client);
    const schema = `sql_restore_${major}_${Date.now().toString(36)}`;
    await client.query(`
      CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}"."Odd ""table" (
        id bigserial PRIMARY KEY,
        payload text,
        raw bytea
      );
      INSERT INTO "${schema}"."Odd ""table" (payload, raw) VALUES
        (E'one\\nline', decode('00ff', 'hex')),
        (E'literal \\\\N and \\\\.', decode('', 'hex'));
      CREATE FUNCTION "${schema}".message() RETURNS text
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          RETURN 'body;with;semicolons';
        END;
        $function$;
      SET search_path TO "${schema}";
      CREATE VIEW "${schema}".payload_view AS
        SELECT id, payload FROM "Odd ""table";
    `);

    const outputChunks: Buffer[] = [];
    const dump = await dumpPostgres(
      connection,
      {
        mode: 'full',
        dataFormat: 'copy',
        selection: { includeSchemas: [schema] },
        noOwner: true,
        noPrivileges: true,
        restoreTransactionMode: 'single',
      },
      collectingOutput(outputChunks),
    );
    expect(dump.rowsWritten).toBe(2);

    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    const bytes = Buffer.concat(outputChunks);
    expect(bytes.toString('utf8')).toContain(`FROM ${schema}."Odd ""table"`);
    const sourceChunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 17) {
      sourceChunks.push(bytes.subarray(offset, Math.min(offset + 17, bytes.length)));
    }
    const restored = await restoreSqlDump({
      source: Readable.from(sourceChunks),
      connection,
    });

    expect(restored).toMatchObject({
      status: 'success',
      copyBlocksCompleted: 1,
      rowsRestored: 2,
      bytesRead: bytes.length,
    });
    const rows = await client.query(
      `SELECT id::text, payload, encode(raw, 'hex') AS raw
       FROM "${schema}"."Odd ""table" ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: '1', payload: 'one\nline', raw: '00ff' },
      { id: '2', payload: 'literal \\N and \\.', raw: '' },
    ]);
    const routine = await client.query(`SELECT "${schema}".message() AS value`);
    expect(routine.rows).toEqual([{ value: 'body;with;semicolons' }]);
    const viewRows = await client.query(
      `SELECT id::text, payload FROM "${schema}".payload_view ORDER BY id`,
    );
    expect(viewRows.rows).toEqual([
      { id: '1', payload: 'one\nline' },
      { id: '2', payload: 'literal \\N and \\.' },
    ]);

    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  }, 60_000);

  it('restores a real pg_dump plain-SQL stream natively', async ({ skip }) => {
    const clientMajor = await localPgDumpMajor();
    if (clientMajor !== undefined && clientMajor !== major) {
      skip();
      return;
    }
    const client = new Client({ connectionString: url });
    clients.push(client);
    await client.connect();
    const schema = `external_dump_restore_${major}_${Date.now().toString(36)}`;
    try {
      await client.query(`
        CREATE SCHEMA "${schema}";
        CREATE TYPE "${schema}".mood AS ENUM ('ok', 'great');
        CREATE TABLE "${schema}".items (
          id bigserial PRIMARY KEY,
          mood "${schema}".mood NOT NULL,
          payload text,
          raw bytea
        );
        INSERT INTO "${schema}".items (mood, payload, raw) VALUES
          ('ok', E'line one\\nline two', pg_catalog.decode('00ff', 'hex')),
          ('great', E'literal \\\\N, \\\\., and tab\\t', pg_catalog.decode('', 'hex'));
        CREATE VIEW "${schema}".item_view AS
          SELECT id, mood, payload FROM "${schema}".items;
      `);

      const bytes = await dumpWithPgDump(url, schema);
      expect(isPgDumpSqlDump(bytes.subarray(0, Math.min(bytes.length, 4096)))).toBe(true);
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);

      const chunks: Buffer[] = [];
      for (let offset = 0; offset < bytes.length; offset += 23) {
        chunks.push(bytes.subarray(offset, Math.min(offset + 23, bytes.length)));
      }
      const restored = await restoreSqlDump({
        source: Readable.from(chunks),
        connection: fromPgClient(client),
      });

      expect(restored).toMatchObject({
        status: 'success',
        copyBlocksCompleted: 1,
        rowsRestored: 2,
        bytesRead: bytes.length,
      });
      const rows = await client.query(
        `SELECT id::text, mood::text, payload, pg_catalog.encode(raw, 'hex') AS raw
         FROM "${schema}".item_view
         JOIN "${schema}".items USING (id, mood, payload)
         ORDER BY id`,
      );
      expect(rows.rows).toEqual([
        { id: '1', mood: 'ok', payload: 'line one\nline two', raw: '00ff' },
        { id: '2', mood: 'great', payload: 'literal \\N, \\., and tab\t', raw: '' },
      ]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }, 60_000);
});
