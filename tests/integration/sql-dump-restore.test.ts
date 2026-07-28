import { Readable, Writable } from 'node:stream';

import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { dumpPostgres, restoreSqlDump } from '../../src/index.js';
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
});
