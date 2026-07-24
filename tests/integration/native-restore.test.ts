import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  createArchiveIdentity,
  createDumpId,
  createRestoreEngine,
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
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
  it('restores a structured schema and COPY text payload directly through the driver', async () => {
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
    const dataId = `${tableId}-data`;
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
          )} (id integer PRIMARY KEY, value text NOT NULL, optional_value text)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: ['CREATE on schema'],
        },
        description: `Create table ${schema}.items.`,
        diagnostics: [],
      },
      {
        entryId: dataId,
        archiveIdentity: `table-data:${schema}:items`,
        objectType: 'table-data',
        section: 'data',
        objectIdentity: `${schema}.items`,
        dependencyEntryIds: [tableId],
        operation: {
          kind: 'table-data',
          table: { schema, table: 'items' },
          columns: ['id', 'value', 'optional_value'],
          format: 'copy-text',
          copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          dataSourceId: dataId,
          estimatedRows: 4,
          identityBehavior: 'preserve',
          partitionBehavior: 'target-table',
          tableKind: 'ordinary',
          transactionRequirement: 'allowed',
        },
        description: `Load table data for ${schema}.items.`,
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
        archive: new InMemoryRestoreArchiveSource({
          metadata,
          entries,
          data: new Map([
            [
              dataId,
              [
                '1\ttab\\tnewline\\ncarriage\\rslash\\\\\t\\N\n',
                '2\t\tliteral\\\\N\n',
                '3\tliteral\\\\.\tUnicode žluťoučký 🦊\n',
                '4\tordinary\tvalue\n',
              ].join(''),
            ],
          ]),
        }),
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
      const restoredRows = await client.query<{
        id: number;
        value: string;
        optional_value: string | null;
      }>(
        `SELECT id, value, optional_value FROM ${quoteIdentifier(schema)}.${quoteIdentifier(
          'items',
        )} ORDER BY id`,
      );
      expect(restoredRows.rows).toEqual([
        {
          id: 1,
          value: 'tab\tnewline\ncarriage\rslash\\',
          optional_value: null,
        },
        { id: 2, value: '', optional_value: 'literal\\N' },
        { id: 3, value: 'literal\\.', optional_value: 'Unicode žluťoučký 🦊' },
        { id: 4, value: 'ordinary', optional_value: 'value' },
      ]);
      expect(result.restoredTableDataCount).toBe(1);
      expect(result.tableDataCompletedCount).toBe(1);
      expect(result.restoredRowCount).toBe(4);
      expect(progress.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'restore-started',
          'archive-validated',
          'preflight-completed',
          'plan-created',
          'step-started',
          'step-completed',
          'copy-started',
          'copy-completed',
          'restore-completed',
        ]),
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await client.end();
    }
  });
});
