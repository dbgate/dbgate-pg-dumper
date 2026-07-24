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
  quoteQualifiedIdentifier,
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
    const functionId = `${tableId}-trigger-function`;
    const uniqueId = `${tableId}-unique`;
    const indexId = `${tableId}-partial-index`;
    const triggerId = `${tableId}-trigger`;
    const rlsId = `${tableId}-rls`;
    const policyId = `${tableId}-policy`;
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
        entryId: functionId,
        archiveIdentity: `function:${schema}:preserve_value`,
        objectType: 'function',
        section: 'pre-data',
        objectIdentity: `${schema}.preserve_value()`,
        dependencyEntryIds: [schemaId],
        operation: {
          kind: 'sql',
          sql: `
            CREATE FUNCTION ${quoteIdentifier(schema)}.preserve_value()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              NEW.value := 'triggered:' || NEW.value;
              RETURN NEW;
            END
            $$
          `,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create trigger function.',
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
      {
        entryId: uniqueId,
        archiveIdentity: `constraint:${schema}:items:value_unique`,
        objectType: 'constraint',
        section: 'post-data',
        objectIdentity: `${schema}.items.value_unique`,
        dependencyEntryIds: [dataId],
        operation: {
          kind: 'sql',
          sql: `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(
            'items',
          )} ADD CONSTRAINT value_unique UNIQUE (value)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create unique constraint.',
        diagnostics: [],
      },
      {
        entryId: indexId,
        archiveIdentity: `index:${schema}:items_nonempty`,
        objectType: 'index',
        section: 'post-data',
        objectIdentity: `${schema}.items_nonempty`,
        dependencyEntryIds: [dataId],
        operation: {
          kind: 'sql',
          sql: `CREATE INDEX items_nonempty ON ${quoteIdentifier(schema)}.${quoteIdentifier(
            'items',
          )} ((length(value))) WHERE value <> ''`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create partial expression index.',
        diagnostics: [],
      },
      {
        entryId: triggerId,
        archiveIdentity: `trigger:${schema}:items_mutator`,
        objectType: 'trigger',
        section: 'post-data',
        objectIdentity: `${schema}.items_mutator`,
        dependencyEntryIds: [dataId, functionId],
        operation: {
          kind: 'sql',
          sql: `CREATE TRIGGER items_mutator BEFORE INSERT ON ${quoteIdentifier(
            schema,
          )}.${quoteIdentifier('items')} FOR EACH ROW EXECUTE PROCEDURE ${quoteIdentifier(
            schema,
          )}.preserve_value()`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create data-mutating trigger after COPY.',
        diagnostics: [],
      },
      {
        entryId: rlsId,
        archiveIdentity: `table-finalization:${schema}:items:rls`,
        objectType: 'table',
        section: 'post-data',
        objectIdentity: `${schema}.items`,
        dependencyEntryIds: [dataId],
        operation: {
          kind: 'sql',
          sql: `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(
            'items',
          )} ENABLE ROW LEVEL SECURITY`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Enable RLS after COPY.',
        diagnostics: [],
      },
      {
        entryId: policyId,
        archiveIdentity: `policy:${schema}:items_read`,
        objectType: 'policy',
        section: 'post-data',
        objectIdentity: `${schema}.items.items_read`,
        dependencyEntryIds: [rlsId],
        operation: {
          kind: 'sql',
          sql: `CREATE POLICY items_read ON ${quoteIdentifier(schema)}.${quoteIdentifier(
            'items',
          )} FOR SELECT TO PUBLIC USING (true)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Enable RLS and create policy after COPY.',
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

      expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe('success');
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
      expect(result.constraintsCreatedCount).toBe(1);
      expect(result.indexesCreatedCount).toBe(1);
      expect(result.triggersCreatedCount).toBe(1);
      expect(result.policiesCreatedCount).toBe(1);
      const relationState = await client.query<{ relrowsecurity: boolean }>(
        `
          SELECT relrowsecurity
          FROM pg_catalog.pg_class
          WHERE oid = $1::pg_catalog.regclass
        `,
        [`${quoteIdentifier(schema)}.${quoteIdentifier('items')}`],
      );
      expect(relationState.rows[0]?.relrowsecurity).toBe(true);
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

  it('restores exact standalone, serial, and identity sequence state semantics', async () => {
    const client = new Client({ connectionString: selectedUrl });
    await client.connect();
    const schema = `native_sequence_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const versionResult = await client.query<{ server_version_num: string }>(
      `SELECT pg_catalog.current_setting('server_version_num') AS server_version_num`,
    );
    const serverVersion = Number(versionResult.rows[0]?.server_version_num ?? '0');
    const supportsIdentity = serverVersion >= 100000;
    const schemaId = `schema-${schema}`;
    const entries: RestoreArchiveEntry[] = [
      {
        entryId: schemaId,
        archiveIdentity: `schema:${schema}`,
        objectType: 'schema',
        section: 'pre-data',
        objectIdentity: schema,
        dependencyEntryIds: [],
        operation: {
          kind: 'sql',
          sql: `CREATE SCHEMA ${quoteIdentifier(schema)}`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create sequence fixture schema.',
        diagnostics: [],
      },
    ];
    const sequenceDefinitions = [
      {
        name: 'never_called',
        definition: 'START WITH 42 INCREMENT BY 1',
        lastValue: '42',
        isCalled: false,
        nextValue: '42',
        increment: '1',
      },
      {
        name: 'increment_ten',
        definition: 'START WITH 10 INCREMENT BY 10',
        lastValue: '100',
        isCalled: true,
        nextValue: '110',
        increment: '10',
      },
      {
        name: 'descending',
        definition: 'MINVALUE -1000 MAXVALUE -1 START WITH -10 INCREMENT BY -10',
        lastValue: '-100',
        isCalled: true,
        nextValue: '-110',
        increment: '-10',
      },
      {
        name: 'large_value',
        definition: 'AS bigint',
        lastValue: '9007199254740993',
        isCalled: false,
        nextValue: '9007199254740993',
        increment: '1',
      },
      {
        name: 'cycling',
        definition: 'MINVALUE 1 MAXVALUE 3 START WITH 1 INCREMENT BY 1 CYCLE',
        lastValue: '3',
        isCalled: true,
        nextValue: '1',
        increment: '1',
      },
    ] as const;

    for (const fixture of sequenceDefinitions) {
      const definitionId = `sequence-${fixture.name}`;
      entries.push({
        entryId: definitionId,
        archiveIdentity: `sequence:${schema}:${fixture.name}`,
        objectType: 'sequence',
        section: 'pre-data',
        objectIdentity: `${schema}.${fixture.name}`,
        dependencyEntryIds: [schemaId],
        operation: {
          kind: 'sql',
          sql: `CREATE SEQUENCE ${quoteQualifiedIdentifier([
            schema,
            fixture.name,
          ])} ${fixture.definition}`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: `Create ${fixture.name}.`,
        diagnostics: [],
      });
      entries.push({
        entryId: `state-${fixture.name}`,
        archiveIdentity: `sequence-state:${schema}:${fixture.name}`,
        objectType: 'sequence-state',
        section: 'data',
        objectIdentity: `${schema}.${fixture.name}`,
        dependencyEntryIds: [definitionId],
        operation: {
          kind: 'sequence-state',
          schema,
          sequence: fixture.name,
          lastValue: fixture.lastValue,
          isCalled: fixture.isCalled,
          dataType: 'bigint',
          ownership: 'standalone',
          increment: fixture.increment,
          transactionRequirement: 'allowed',
        },
        description: `Restore ${fixture.name} state.`,
        diagnostics: [],
      });
    }

    const serialSequenceId = 'sequence-serial-items-id';
    const serialTableId = 'table-serial-items';
    const serialDataId = 'data-serial-items';
    entries.push(
      {
        entryId: serialSequenceId,
        archiveIdentity: `sequence:${schema}:serial_items_id_seq`,
        objectType: 'sequence',
        section: 'pre-data',
        objectIdentity: `${schema}.serial_items_id_seq`,
        dependencyEntryIds: [schemaId],
        operation: {
          kind: 'sql',
          sql: `CREATE SEQUENCE ${quoteQualifiedIdentifier([
            schema,
            'serial_items_id_seq',
          ])} AS bigint`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create serial sequence.',
        diagnostics: [],
      },
      {
        entryId: serialTableId,
        archiveIdentity: `table:${schema}:serial_items`,
        objectType: 'table',
        section: 'pre-data',
        objectIdentity: `${schema}.serial_items`,
        dependencyEntryIds: [schemaId, serialSequenceId],
        operation: {
          kind: 'sql',
          sql: `CREATE TABLE ${quoteQualifiedIdentifier([
            schema,
            'serial_items',
          ])} (id bigint DEFAULT nextval('${schema}.serial_items_id_seq'::pg_catalog.regclass), value text)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create serial table.',
        diagnostics: [],
      },
      {
        entryId: serialDataId,
        archiveIdentity: `table-data:${schema}:serial_items`,
        objectType: 'table-data',
        section: 'data',
        objectIdentity: `${schema}.serial_items`,
        dependencyEntryIds: [serialTableId],
        operation: {
          kind: 'table-data',
          table: { schema, table: 'serial_items' },
          columns: ['id', 'value'],
          format: 'copy-text',
          copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          dataSourceId: serialDataId,
          identityBehavior: 'preserve',
          partitionBehavior: 'target-table',
          transactionRequirement: 'allowed',
        },
        description: 'Load serial table.',
        diagnostics: [],
      },
      {
        entryId: 'state-serial-items',
        archiveIdentity: `sequence-state:${schema}:serial_items_id_seq`,
        objectType: 'sequence-state',
        section: 'data',
        objectIdentity: `${schema}.serial_items_id_seq`,
        dependencyEntryIds: [serialSequenceId, serialDataId],
        operation: {
          kind: 'sequence-state',
          schema,
          sequence: 'serial_items_id_seq',
          lastValue: '500',
          isCalled: true,
          dataType: 'bigint',
          ownership: 'serial',
          increment: '1',
          ownedBy: { schema, table: 'serial_items', column: 'id' },
          transactionRequirement: 'allowed',
        },
        description: 'Restore serial sequence state.',
        diagnostics: [],
      },
      {
        entryId: 'ownership-serial-items',
        archiveIdentity: `sequence-ownership:${schema}:serial_items_id_seq`,
        objectType: 'sequence-ownership',
        section: 'post-data',
        objectIdentity: `${schema}.serial_items_id_seq`,
        dependencyEntryIds: [serialTableId, serialSequenceId],
        operation: {
          kind: 'sql',
          sql: `ALTER SEQUENCE ${quoteQualifiedIdentifier([
            schema,
            'serial_items_id_seq',
          ])} OWNED BY ${quoteQualifiedIdentifier([schema, 'serial_items', 'id'])}`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Attach serial sequence ownership.',
        diagnostics: [],
      },
    );

    let identityDataId: string | undefined;
    if (supportsIdentity) {
      const identityTableId = 'table-identity-items';
      identityDataId = 'data-identity-items';
      entries.push(
        {
          entryId: identityTableId,
          archiveIdentity: `table:${schema}:identity_items`,
          objectType: 'table',
          section: 'pre-data',
          objectIdentity: `${schema}.identity_items`,
          dependencyEntryIds: [schemaId],
          operation: {
            kind: 'sql',
            sql: `CREATE TABLE ${quoteQualifiedIdentifier([
              schema,
              'identity_items',
            ])} (id bigint GENERATED ALWAYS AS IDENTITY, value text)`,
            transactionRequirement: 'allowed',
            privilegeRequirements: [],
          },
          description: 'Create identity table.',
          diagnostics: [],
        },
        {
          entryId: identityDataId,
          archiveIdentity: `table-data:${schema}:identity_items`,
          objectType: 'table-data',
          section: 'data',
          objectIdentity: `${schema}.identity_items`,
          dependencyEntryIds: [identityTableId],
          operation: {
            kind: 'table-data',
            table: { schema, table: 'identity_items' },
            columns: ['id', 'value'],
            format: 'copy-text',
            copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
            dataSourceId: identityDataId,
            identityBehavior: 'preserve',
            identityColumns: [{ name: 'id', generation: 'always' }],
            partitionBehavior: 'target-table',
            transactionRequirement: 'allowed',
          },
          description: 'Load identity table.',
          diagnostics: [],
        },
        {
          entryId: 'state-identity-items',
          archiveIdentity: `sequence-state:${schema}:identity_items_id_seq`,
          objectType: 'sequence-state',
          section: 'data',
          objectIdentity: `${schema}.identity_items_id_seq`,
          dependencyEntryIds: [identityTableId, identityDataId],
          operation: {
            kind: 'sequence-state',
            schema,
            sequence: 'identity_items_id_seq',
            lastValue: '700',
            isCalled: false,
            dataType: 'bigint',
            ownership: 'identity',
            identityGeneration: 'always',
            increment: '1',
            ownedBy: { schema, table: 'identity_items', column: 'id' },
            transactionRequirement: 'allowed',
          },
          description: 'Restore identity sequence state.',
          diagnostics: [],
        },
      );
    }

    const metadata: RestoreArchiveMetadata = {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: `sequence-integration-${schema}`,
      sourceVersion: {
        complete: `PostgreSQL ${String(Math.trunc(serverVersion / 10000))}`,
        number: serverVersion,
        normalizedMajor: String(Math.trunc(serverVersion / 10000)),
        major: Math.trunc(serverVersion / 10000),
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
    const data = new Map<string, string>([[serialDataId, '7\tserial\n']]);
    if (identityDataId !== undefined) data.set(identityDataId, '100\tidentity\n');

    try {
      const result = await createRestoreEngine().restore({
        archive: new InMemoryRestoreArchiveSource({ metadata, entries, data }),
        target: fromPgClient(client),
      });
      expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe('success');
      expect(result.sequencesRestoredCount).toBe(supportsIdentity ? 7 : 6);
      expect(result.sequencesFailedCount).toBe(0);

      const expected = [
        ...sequenceDefinitions.map((fixture) => ({
          name: fixture.name,
          lastValue: fixture.lastValue,
          isCalled: fixture.isCalled,
          nextValue: fixture.nextValue,
        })),
        {
          name: 'serial_items_id_seq',
          lastValue: '500',
          isCalled: true,
          nextValue: '501',
        },
        ...(supportsIdentity
          ? [
              {
                name: 'identity_items_id_seq',
                lastValue: '700',
                isCalled: false,
                nextValue: '700',
              },
            ]
          : []),
      ];
      for (const fixture of expected) {
        const state = await client.query<{ last_value: string; is_called: boolean }>(
          `SELECT last_value::pg_catalog.text, is_called FROM ${quoteQualifiedIdentifier([
            schema,
            fixture.name,
          ])}`,
        );
        expect(state.rows[0]).toEqual({
          last_value: fixture.lastValue,
          is_called: fixture.isCalled,
        });
        const next = await client.query<{ value: string }>(
          `SELECT pg_catalog.nextval($1::pg_catalog.regclass)::pg_catalog.text AS value`,
          [quoteQualifiedIdentifier([schema, fixture.name])],
        );
        expect(next.rows[0]?.value).toBe(fixture.nextValue);
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await client.end();
    }
  });

  it('loads cyclic foreign-key data before keys and foreign constraints', async () => {
    const client = new Client({ connectionString: selectedUrl });
    await client.connect();
    const schema = `native_fk_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const schemaId = 'schema';
    const tableAId = 'table-a';
    const tableBId = 'table-b';
    const dataAId = 'data-a';
    const dataBId = 'data-b';
    const entries: RestoreArchiveEntry[] = [
      {
        entryId: schemaId,
        archiveIdentity: `schema:${schema}`,
        objectType: 'schema',
        section: 'pre-data',
        objectIdentity: schema,
        dependencyEntryIds: [],
        operation: {
          kind: 'sql',
          sql: `CREATE SCHEMA ${quoteIdentifier(schema)}`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create cyclic FK schema.',
        diagnostics: [],
      },
      ...[
        { id: tableAId, table: 'a', reference: 'b_id' },
        { id: tableBId, table: 'b', reference: 'a_id' },
      ].map(({ id, table, reference }): RestoreArchiveEntry => ({
        entryId: id,
        archiveIdentity: `table:${schema}:${table}`,
        objectType: 'table',
        section: 'pre-data',
        objectIdentity: `${schema}.${table}`,
        dependencyEntryIds: [schemaId],
        operation: {
          kind: 'sql',
          sql: `CREATE TABLE ${quoteQualifiedIdentifier([
            schema,
            table,
          ])} (id integer NOT NULL, ${quoteIdentifier(reference)} integer NOT NULL)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: `Create table ${table}.`,
        diagnostics: [],
      })),
      ...[
        { id: dataAId, tableId: tableAId, table: 'a', reference: 'b_id' },
        { id: dataBId, tableId: tableBId, table: 'b', reference: 'a_id' },
      ].map(({ id, tableId, table, reference }): RestoreArchiveEntry => ({
        entryId: id,
        archiveIdentity: `table-data:${schema}:${table}`,
        objectType: 'table-data',
        section: 'data',
        objectIdentity: `${schema}.${table}`,
        dependencyEntryIds: [tableId],
        operation: {
          kind: 'table-data',
          table: { schema, table },
          columns: ['id', reference],
          format: 'copy-text',
          copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          dataSourceId: id,
          identityBehavior: 'preserve',
          partitionBehavior: 'target-table',
          transactionRequirement: 'allowed',
        },
        description: `Load table ${table}.`,
        diagnostics: [],
      })),
      ...[
        { id: 'pk-a', table: 'a', dataId: dataAId },
        { id: 'pk-b', table: 'b', dataId: dataBId },
      ].map(({ id, table, dataId }): RestoreArchiveEntry => ({
        entryId: id,
        archiveIdentity: `constraint:${schema}:${table}:pk`,
        objectType: 'constraint',
        section: 'post-data',
        objectIdentity: `${schema}.${table}.${table}_pkey`,
        dependencyEntryIds: [dataId],
        operation: {
          kind: 'sql',
          sql: `ALTER TABLE ${quoteQualifiedIdentifier([
            schema,
            table,
          ])} ADD CONSTRAINT ${quoteIdentifier(`${table}_pkey`)} PRIMARY KEY (id)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: `Create ${table} primary key.`,
        diagnostics: [],
      })),
      ...[
        {
          id: 'fk-a-b',
          table: 'a',
          column: 'b_id',
          targetTable: 'b',
          dependencies: [dataAId, dataBId, 'pk-b'],
        },
        {
          id: 'fk-b-a',
          table: 'b',
          column: 'a_id',
          targetTable: 'a',
          dependencies: [dataAId, dataBId, 'pk-a'],
        },
      ].map(({ id, table, column, targetTable, dependencies }): RestoreArchiveEntry => ({
        entryId: id,
        archiveIdentity: `foreign-key:${schema}:${table}:${id}`,
        objectType: 'foreign-key',
        section: 'post-data',
        objectIdentity: `${schema}.${table}.${id}`,
        dependencyEntryIds: dependencies,
        operation: {
          kind: 'sql',
          sql: `ALTER TABLE ${quoteQualifiedIdentifier([
            schema,
            table,
          ])} ADD CONSTRAINT ${quoteIdentifier(id)} FOREIGN KEY (${quoteIdentifier(
            column,
          )}) REFERENCES ${quoteQualifiedIdentifier([schema, targetTable])} (id)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: `Create ${id}.`,
        diagnostics: [],
      })),
    ];
    const metadata: RestoreArchiveMetadata = {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: `cyclic-${schema}`,
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

    try {
      const result = await createRestoreEngine().restore({
        archive: new InMemoryRestoreArchiveSource({
          metadata,
          entries,
          data: new Map([
            [dataAId, '1\t1\n'],
            [dataBId, '1\t1\n'],
          ]),
        }),
        target: fromPgClient(client),
      });
      expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe('success');
      expect(result.constraintsCreatedCount).toBe(4);
      const verification = await client.query<{ count: string }>(
        `
          SELECT pg_catalog.count(*)::pg_catalog.text AS count
          FROM ${quoteQualifiedIdentifier([schema, 'a'])} AS a
          JOIN ${quoteQualifiedIdentifier([schema, 'b'])} AS b
            ON b.id = a.b_id AND a.id = b.a_id
        `,
      );
      expect(verification.rows[0]?.count).toBe('1');
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await client.end();
    }
  });
});
