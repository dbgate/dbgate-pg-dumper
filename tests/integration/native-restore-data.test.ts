import { describe, expect, it } from 'vitest';

import {
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  createRestoreEngine,
  InMemoryRestoreArchiveSource,
  quoteIdentifier,
  type RestoreArchiveEntry,
} from '../../src/index.js';
import { NativeRestoreFixture, restoreFailureContext } from './support/nativeRestoreTestSupport.js';

describe('native PostgreSQL restore typed data', () => {
  it('restores bytea, UUID, JSONB, arrays, temporal, numeric, and bigint values exactly', async () => {
    const fixture = await NativeRestoreFixture.create('native_typed_data');
    const entries: readonly RestoreArchiveEntry[] = [
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
        description: 'Create typed-data schema.',
        diagnostics: [],
      },
      {
        entryId: 'table',
        archiveIdentity: `table:${fixture.schema}:typed_values`,
        objectType: 'table',
        section: 'pre-data',
        objectIdentity: `${fixture.schema}.typed_values`,
        dependencyEntryIds: ['schema'],
        operation: {
          kind: 'sql',
          sql: `CREATE TABLE ${fixture.qualified('typed_values')} (
            bytes bytea,
            identifier uuid,
            document_json json,
            document jsonb,
            tags integer[],
            date_value date,
            timestamp_value timestamp without time zone,
            numeric_value numeric,
            bigint_value bigint
          )`,
          target: { kind: 'table', schema: fixture.schema, name: 'typed_values' },
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create typed-data table.',
        diagnostics: [],
      },
      {
        entryId: 'data',
        archiveIdentity: `table-data:${fixture.schema}:typed_values`,
        objectType: 'table-data',
        section: 'data',
        objectIdentity: `${fixture.schema}.typed_values`,
        dependencyEntryIds: ['table'],
        operation: {
          kind: 'table-data',
          table: { schema: fixture.schema, table: 'typed_values' },
          columns: [
            'bytes',
            'identifier',
            'document_json',
            'document',
            'tags',
            'date_value',
            'timestamp_value',
            'numeric_value',
            'bigint_value',
          ],
          format: 'copy-text',
          copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          dataSourceId: 'data',
          estimatedRows: 1,
          identityBehavior: 'preserve',
          partitionBehavior: 'target-table',
          transactionRequirement: 'allowed',
        },
        description: 'Load typed values.',
        diagnostics: [],
      },
    ];

    try {
      const result = await createRestoreEngine().restore({
        archive: new InMemoryRestoreArchiveSource({
          metadata: fixture.metadata('typed-data'),
          entries,
          data: new Map([
            [
              'data',
              [
                '\\\\x00ff10',
                '123e4567-e89b-12d3-a456-426614174000',
                '{"plain":[1,2]}',
                '{"z":true,"nested":{"a":1}}',
                '{1,2,NULL}',
                '2024-01-02',
                '2024-01-02 03:04:05.123456',
                '12345678901234567890.123456789',
                '9223372036854775807',
              ].join('\t') + '\n',
            ],
          ]),
        }),
        target: fixture.target,
      });
      expect(result.status, restoreFailureContext(result)).toBe('success');

      const values = await fixture.client.query<{
        bytes: string;
        identifier: string;
        json_array_length: number;
        nested_value: string;
        json_flag: boolean;
        tags: string;
        date_value: string;
        timestamp_value: string;
        numeric_value: string;
        bigint_value: string;
      }>(
        `SELECT
          pg_catalog.encode(bytes, 'hex') AS bytes,
          identifier::text AS identifier,
          pg_catalog.json_array_length(document_json -> 'plain') AS json_array_length,
          document #>> '{nested,a}' AS nested_value,
          (document ->> 'z')::boolean AS json_flag,
          tags::text AS tags,
          date_value::text AS date_value,
          timestamp_value::text AS timestamp_value,
          numeric_value::text AS numeric_value,
          bigint_value::text AS bigint_value
        FROM ${fixture.qualified('typed_values')}`,
      );
      expect(values.rows).toEqual([
        {
          bytes: '00ff10',
          identifier: '123e4567-e89b-12d3-a456-426614174000',
          json_array_length: 2,
          nested_value: '1',
          json_flag: true,
          tags: '{1,2,NULL}',
          date_value: '2024-01-02',
          timestamp_value: '2024-01-02 03:04:05.123456',
          numeric_value: '12345678901234567890.123456789',
          bigint_value: '9223372036854775807',
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
