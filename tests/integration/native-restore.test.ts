import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  createArchiveIdentity,
  createDumpId,
  createRestoreEngine,
  InMemoryRestoreArchiveSource,
  quoteIdentifier,
  RESTORE_ARCHIVE_FORMAT,
  RESTORE_ARCHIVE_FORMAT_VERSION,
  type RestoreArchiveEntry,
  type RestoreArchiveMetadata,
  type RestoreProgressEvent,
} from '../../src/index.js';
import { fromPgClient } from '../../src/pg.js';

const selectedUrl =
  process.env.PG_TEST_URL ??
  process.env.PG18_URL ??
  'postgresql://dumper:dumper@127.0.0.1:55118/dumper_test';

describe('native PostgreSQL restore', () => {
  it('executes a structured schema archive directly through the driver', async () => {
    const client = new Client({ connectionString: selectedUrl });
    await client.connect();
    const schema = `native_restore_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const schemaIdentity = createArchiveIdentity({
      objectType: 'schema',
      schema,
      name: schema,
    });
    const tableIdentity = createArchiveIdentity({
      objectType: 'table',
      schema,
      name: 'items',
    });
    const schemaId = createDumpId(schemaIdentity);
    const tableId = createDumpId(tableIdentity);
    const entries: readonly RestoreArchiveEntry[] = [
      {
        entryId: schemaId,
        archiveIdentity: schemaIdentity,
        objectType: 'schema',
        section: 'pre-data',
        objectIdentity: schema,
        dependencyEntryIds: [],
        operation: {
          kind: 'sql',
          sql: `CREATE SCHEMA ${quoteIdentifier(schema)}`,
          transactionRequirement: 'allowed',
          privilegeRequirements: ['CREATE on database'],
        },
        description: `Create schema ${schema}.`,
        diagnostics: [],
      },
      {
        entryId: tableId,
        archiveIdentity: tableIdentity,
        objectType: 'table',
        section: 'pre-data',
        objectIdentity: `${schema}.items`,
        dependencyEntryIds: [schemaId],
        operation: {
          kind: 'sql',
          sql: `CREATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(
            'items',
          )} (id integer PRIMARY KEY, value text)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: ['CREATE on schema'],
        },
        description: `Create table ${schema}.items.`,
        diagnostics: [],
      },
    ];
    const metadata: RestoreArchiveMetadata = {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: `integration-${schema}`,
      sourceVersion: {
        complete: 'PostgreSQL 18',
        number: 180000,
        normalizedMajor: '18',
        major: 18,
        minor: 0,
        patch: 0,
      },
      requiredExtensions: [],
      requiredRoles: [],
      requiredPrivileges: [],
      requiredTablespaces: [],
      transactionCompatibility: 'compatible',
      diagnostics: [],
    };
    const progress: RestoreProgressEvent[] = [];

    try {
      const result = await createRestoreEngine().restore({
        archive: new InMemoryRestoreArchiveSource({ metadata, entries }),
        target: fromPgClient(client),
        onProgress: (event) => progress.push(event),
      });

      expect(result.status).toBe('success');
      const verification = await client.query<{ exists: boolean }>(
        `
          SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists
        `,
        [`${quoteIdentifier(schema)}.${quoteIdentifier('items')}`],
      );
      expect(verification.rows[0]?.exists).toBe(true);
      expect(progress.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'restore-started',
          'archive-validated',
          'preflight-completed',
          'plan-created',
          'step-started',
          'step-completed',
          'restore-completed',
        ]),
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await client.end();
    }
  });
});
