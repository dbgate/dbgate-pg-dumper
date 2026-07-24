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

  it('restores mapped ownership, comments, ACLs, and default privileges natively', async () => {
    const client = new Client({ connectionString: selectedUrl });
    await client.connect();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const schema = `native_acl_${suffix}`;
    const owner = `native_owner_${suffix}`;
    const grantee = `native_grantee_${suffix}`;
    await client.query(`CREATE ROLE ${quoteIdentifier(owner)}`);
    await client.query(`CREATE ROLE ${quoteIdentifier(grantee)}`);
    const entries: RestoreArchiveEntry[] = [
      {
        entryId: 'schema',
        archiveIdentity: `schema:${schema}`,
        objectType: 'schema',
        section: 'pre-data',
        dependencyEntryIds: [],
        operation: {
          kind: 'sql',
          sql: `CREATE SCHEMA ${quoteIdentifier(schema)}`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create finalization test schema.',
        diagnostics: [],
      },
      {
        entryId: 'table',
        archiveIdentity: `table:${schema}:items`,
        objectType: 'table',
        section: 'pre-data',
        dependencyEntryIds: ['schema'],
        operation: {
          kind: 'sql',
          sql: `CREATE TABLE ${quoteQualifiedIdentifier([schema, 'items'])} (${quoteIdentifier(
            'Odd "column',
          )} text)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create finalization test table.',
        diagnostics: [],
      },
      ...[
        {
          entryId: 'owner-schema',
          archiveIdentity: `ownership:${schema}`,
          target: { kind: 'schema' as const, name: schema },
          dependencyEntryIds: ['schema'],
        },
        {
          entryId: 'owner-table',
          archiveIdentity: `ownership:${schema}:items`,
          target: { kind: 'table' as const, schema, name: 'items' },
          dependencyEntryIds: ['table'],
        },
      ].map(({ entryId, archiveIdentity, target, dependencyEntryIds }): RestoreArchiveEntry => ({
        entryId,
        archiveIdentity,
        objectType: 'ownership',
        section: 'post-data',
        dependencyEntryIds,
        operation: {
          kind: 'ownership',
          target,
          owner: 'source_owner',
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Restore mapped ownership.',
        diagnostics: [],
      })),
      {
        entryId: 'comment-column',
        archiveIdentity: `comment:${schema}:items:column`,
        objectType: 'comment',
        section: 'post-data',
        dependencyEntryIds: ['table'],
        operation: {
          kind: 'comment',
          target: {
            kind: 'column',
            name: 'Odd "column',
            subName: 'Odd "column',
            parent: { kind: 'table', schema, name: 'items' },
          },
          text: "Unicode 🦊\nO'Brien",
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Restore quoted Unicode column comment.',
        diagnostics: [],
      },
      {
        entryId: 'grant-table',
        archiveIdentity: `acl:${schema}:items:select`,
        objectType: 'acl',
        section: 'post-data',
        dependencyEntryIds: ['owner-table'],
        operation: {
          kind: 'acl',
          target: { kind: 'table', schema, name: 'items' },
          grantee: 'source_grantee',
          grantor: 'source_owner',
          privilege: 'SELECT',
          grantOption: true,
          action: 'grant',
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Restore mapped table grant.',
        diagnostics: [],
      },
      {
        entryId: 'default-grant',
        archiveIdentity: `default-privilege:${schema}:tables`,
        objectType: 'default-privilege',
        section: 'post-data',
        dependencyEntryIds: ['owner-schema'],
        operation: {
          kind: 'default-privilege',
          owner: 'source_owner',
          schema,
          objectType: 'table',
          grantee: 'source_grantee',
          grantor: 'source_owner',
          privilege: 'SELECT',
          grantOption: false,
          action: 'grant',
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Restore mapped default table grant.',
        diagnostics: [],
      },
    ];
    const metadata: RestoreArchiveMetadata = {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: `finalization-${schema}`,
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
        archive: new InMemoryRestoreArchiveSource({ metadata, entries }),
        target: fromPgClient(client),
        options: {
          ownershipMode: 'map',
          roleMappings: [
            {
              kind: 'role',
              sourceRole: 'source_owner',
              action: 'map',
              targetRole: owner,
            },
            {
              kind: 'role',
              sourceRole: 'source_grantee',
              action: 'map',
              targetRole: grantee,
            },
          ],
        },
      });
      expect(result.status, JSON.stringify(result.diagnostics, null, 2)).toBe('success');
      const verification = await client.query<{
        owner: string;
        comment: string;
        table_select: boolean;
      }>(
        `
          SELECT
            role.rolname AS owner,
            pg_catalog.col_description(class.oid, attribute.attnum) AS comment,
            pg_catalog.has_table_privilege($1, class.oid, 'SELECT') AS table_select
          FROM pg_catalog.pg_class AS class
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
          JOIN pg_catalog.pg_roles AS role ON role.oid = class.relowner
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = class.oid AND attribute.attname = $2
          WHERE namespace.nspname = $3 AND class.relname = 'items'
        `,
        [grantee, 'Odd "column', schema],
      );
      expect(verification.rows[0]).toEqual({
        owner,
        comment: "Unicode 🦊\nO'Brien",
        table_select: true,
      });
      await client.query(`SET ROLE ${quoteIdentifier(owner)}`);
      await client.query(
        `CREATE TABLE ${quoteQualifiedIdentifier([schema, 'future'])} (id integer)`,
      );
      await client.query('RESET ROLE');
      const defaults = await client.query<{ allowed: boolean }>(
        `SELECT pg_catalog.has_table_privilege($1, $2, 'SELECT') AS allowed`,
        [grantee, `${quoteIdentifier(schema)}.${quoteIdentifier('future')}`],
      );
      expect(defaults.rows[0]?.allowed).toBe(true);
    } finally {
      await client.query('RESET ROLE');
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await client.query(`DROP OWNED BY ${quoteIdentifier(owner)}, ${quoteIdentifier(grantee)}`);
      await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(owner)}`);
      await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(grantee)}`);
      await client.end();
    }
  });

  it('remaps structured schemas and repeats restore with dependency-aware clean', async () => {
    const client = new Client({ connectionString: selectedUrl });
    await client.connect();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const sourceSchema = `source_${suffix}`;
    const targetSchema = `mapped_${suffix}`;
    const schemaEntryId = 'mapped-schema';
    const tableEntryId = 'mapped-table';
    const dataEntryId = 'mapped-data';
    const entries: RestoreArchiveEntry[] = [
      {
        entryId: schemaEntryId,
        archiveIdentity: `schema:${sourceSchema}`,
        objectType: 'schema',
        section: 'pre-data',
        objectIdentity: sourceSchema,
        dependencyEntryIds: [],
        operation: {
          kind: 'sql',
          sql: `CREATE SCHEMA ${quoteIdentifier(sourceSchema)}`,
          target: { kind: 'schema', name: sourceSchema },
          structuredFragments: [
            { kind: 'sql', text: 'CREATE SCHEMA ' },
            { kind: 'identifier', parts: [sourceSchema], schemaPart: 0 },
          ],
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create mapped schema.',
        diagnostics: [],
      },
      {
        entryId: tableEntryId,
        archiveIdentity: `table:${sourceSchema}:items`,
        objectType: 'table',
        section: 'pre-data',
        objectIdentity: `${sourceSchema}.items`,
        dependencyEntryIds: [schemaEntryId],
        operation: {
          kind: 'sql',
          sql: `CREATE TABLE ${quoteQualifiedIdentifier([
            sourceSchema,
            'items',
          ])} (id integer, value text)`,
          target: { kind: 'table', schema: sourceSchema, name: 'items' },
          structuredFragments: [
            { kind: 'sql', text: 'CREATE TABLE ' },
            {
              kind: 'identifier',
              parts: [sourceSchema, 'items'],
              schemaPart: 0,
            },
            { kind: 'sql', text: ' (id integer, value text)' },
          ],
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Create mapped table.',
        diagnostics: [],
      },
      {
        entryId: dataEntryId,
        archiveIdentity: `table-data:${sourceSchema}:items`,
        objectType: 'table-data',
        section: 'data',
        objectIdentity: `${sourceSchema}.items`,
        dependencyEntryIds: [tableEntryId],
        operation: {
          kind: 'table-data',
          table: { schema: sourceSchema, table: 'items' },
          columns: ['id', 'value'],
          format: 'copy-text',
          copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          dataSourceId: dataEntryId,
          identityBehavior: 'preserve',
          partitionBehavior: 'target-table',
          transactionRequirement: 'allowed',
        },
        description: 'Load mapped table data.',
        diagnostics: [],
      },
      {
        entryId: 'mapped-comment',
        archiveIdentity: `comment:${sourceSchema}:items`,
        objectType: 'comment',
        section: 'post-data',
        objectIdentity: `${sourceSchema}.items`,
        dependencyEntryIds: [tableEntryId],
        operation: {
          kind: 'comment',
          target: { kind: 'table', schema: sourceSchema, name: 'items' },
          text: 'mapped comment 🦊',
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Comment mapped table.',
        diagnostics: [],
      },
      {
        entryId: 'mapped-defaults',
        archiveIdentity: `default-privilege:${sourceSchema}:tables`,
        objectType: 'default-privilege',
        section: 'post-data',
        dependencyEntryIds: [schemaEntryId],
        operation: {
          kind: 'default-privilege',
          owner: 'dumper',
          schema: sourceSchema,
          objectType: 'table',
          grantee: 'PUBLIC',
          privilege: 'SELECT',
          grantOption: false,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Apply mapped default privileges.',
        diagnostics: [],
      },
    ];
    const metadata: RestoreArchiveMetadata = {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: `mapped-clean-${suffix}`,
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
    const mapping = {
      schemaMappings: [
        {
          kind: 'schema' as const,
          sourceSchema,
          action: 'map' as const,
          targetSchema,
        },
      ],
    };
    const makeArchive = () =>
      new InMemoryRestoreArchiveSource({
        metadata,
        entries,
        data: new Map([[dataEntryId, '1\toriginal\n2\tstable\n']]),
      });

    try {
      const first = await createRestoreEngine().restore({
        archive: makeArchive(),
        target: fromPgClient(client),
        options: mapping,
      });
      expect(first.status, JSON.stringify(first.diagnostics, null, 2)).toBe('success');
      expect(first.schemasRemappedCount).toBe(1);
      await client.query(
        `INSERT INTO ${quoteQualifiedIdentifier([targetSchema, 'items'])} VALUES (99, 'modified')`,
      );

      const externalView = `outside_${suffix}`;
      await client.query(
        `CREATE VIEW ${quoteQualifiedIdentifier([
          'public',
          externalView,
        ])} AS SELECT * FROM ${quoteQualifiedIdentifier([targetSchema, 'items'])}`,
      );
      const blocked = await createRestoreEngine().restore({
        archive: makeArchive(),
        target: fromPgClient(client),
        options: {
          ...mapping,
          preflightOnly: true,
          cleanMode: 'clean',
          existingObjectPolicy: 'clean',
        },
      });
      expect(blocked.status).toBe('preflight-failed');
      expect(blocked.diagnostics.some((item) => item.code === 'external-dependent-object')).toBe(
        true,
      );
      await client.query(`DROP VIEW ${quoteQualifiedIdentifier(['public', externalView])}`);

      const second = await createRestoreEngine().restore({
        archive: makeArchive(),
        target: fromPgClient(client),
        options: {
          ...mapping,
          cleanMode: 'clean',
          existingObjectPolicy: 'clean',
        },
      });
      expect(second.status, JSON.stringify(second.diagnostics, null, 2)).toBe('success');
      expect(second.objectsDroppedCount).toBe(2);
      const verification = await client.query<{
        values: string[];
        comment: string;
      }>(
        `
          SELECT
            pg_catalog.array_agg(value ORDER BY id) AS values,
            pg_catalog.obj_description($1::pg_catalog.regclass, 'pg_class') AS comment
          FROM ${quoteQualifiedIdentifier([targetSchema, 'items'])}
        `,
        [quoteQualifiedIdentifier([targetSchema, 'items'])],
      );
      expect(verification.rows[0]).toEqual({
        values: ['original', 'stable'],
        comment: 'mapped comment 🦊',
      });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(targetSchema)} CASCADE`);
      await client.end();
    }
  });

  it('fails mapped collisions and existing-object conflicts before target modification', async () => {
    const client = new Client({ connectionString: selectedUrl });
    await client.connect();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const targetSchema = `collision_${suffix}`;
    const makeTable = (entryId: string, sourceSchema: string): RestoreArchiveEntry => ({
      entryId,
      archiveIdentity: `table:${sourceSchema}:items`,
      objectType: 'table',
      section: 'pre-data',
      objectIdentity: `${sourceSchema}.items`,
      dependencyEntryIds: [],
      operation: {
        kind: 'sql',
        sql: `CREATE TABLE ${quoteQualifiedIdentifier([sourceSchema, 'items'])} (id integer)`,
        target: { kind: 'table', schema: sourceSchema, name: 'items' },
        structuredFragments: [
          { kind: 'sql', text: 'CREATE TABLE ' },
          { kind: 'identifier', parts: [sourceSchema, 'items'], schemaPart: 0 },
          { kind: 'sql', text: ' (id integer)' },
        ],
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
      description: 'Collision candidate.',
      diagnostics: [],
    });
    const entries = [makeTable('one', 'source_one'), makeTable('two', 'source_two')];
    const metadata: RestoreArchiveMetadata = {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: `collision-${suffix}`,
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
      const collision = await createRestoreEngine().restore({
        archive: new InMemoryRestoreArchiveSource({ metadata, entries }),
        target: fromPgClient(client),
        options: {
          preflightOnly: true,
          schemaMappingPolicy: 'single-target-schema',
          singleTargetSchema: targetSchema,
        },
      });
      expect(collision.status).toBe('preflight-failed');
      expect(collision.diagnostics.some((item) => item.code === 'schema-mapping-collision')).toBe(
        true,
      );
      const exists = await client.query<{ exists: boolean }>(
        `SELECT pg_catalog.to_regnamespace($1) IS NOT NULL AS exists`,
        [targetSchema],
      );
      expect(exists.rows[0]?.exists).toBe(false);

      await client.query(`CREATE SCHEMA ${quoteIdentifier(targetSchema)}`);
      await client.query(
        `CREATE TABLE ${quoteQualifiedIdentifier([targetSchema, 'items'])} (id integer)`,
      );
      const conflict = await createRestoreEngine().restore({
        archive: new InMemoryRestoreArchiveSource({ metadata, entries: [entries[0]!] }),
        target: fromPgClient(client),
        options: {
          schemaMappings: [
            {
              kind: 'schema',
              sourceSchema: 'source_one',
              action: 'map',
              targetSchema,
            },
          ],
        },
      });
      expect(conflict.status).toBe('preflight-failed');
      expect(conflict.conflictsDetectedCount).toBe(1);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(targetSchema)} CASCADE`);
      await client.end();
    }
  });

  it('enforces explicit non-empty target table data policies', async () => {
    const client = new Client({ connectionString: selectedUrl });
    await client.connect();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const schema = `existing_data_${suffix}`;
    const tableEntry: RestoreArchiveEntry = {
      entryId: 'existing-table',
      archiveIdentity: `table:${schema}:items`,
      objectType: 'table',
      section: 'pre-data',
      objectIdentity: `${schema}.items`,
      dependencyEntryIds: [],
      operation: {
        kind: 'sql',
        sql: `CREATE TABLE ${quoteQualifiedIdentifier([schema, 'items'])} (id integer, value text)`,
        target: { kind: 'table', schema, name: 'items' },
        structuredFragments: [
          { kind: 'sql', text: 'CREATE TABLE ' },
          { kind: 'identifier', parts: [schema, 'items'], schemaPart: 0 },
          { kind: 'sql', text: ' (id integer, value text)' },
        ],
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
      description: 'Existing table definition.',
      diagnostics: [],
    };
    const dataEntry: RestoreArchiveEntry = {
      entryId: 'existing-data',
      archiveIdentity: `table-data:${schema}:items`,
      objectType: 'table-data',
      section: 'data',
      objectIdentity: `${schema}.items`,
      dependencyEntryIds: [tableEntry.entryId],
      operation: {
        kind: 'table-data',
        table: { schema, table: 'items' },
        columns: ['id', 'value'],
        format: 'copy-text',
        copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
        dataSourceId: 'existing-data',
        identityBehavior: 'preserve',
        partitionBehavior: 'target-table',
        transactionRequirement: 'allowed',
      },
      description: 'Existing table data.',
      diagnostics: [],
    };
    const metadata: RestoreArchiveMetadata = {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: `existing-data-${suffix}`,
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
    const makeArchive = () =>
      new InMemoryRestoreArchiveSource({
        metadata,
        entries: [tableEntry, dataEntry],
        data: new Map([['existing-data', '1\tarchive\n']]),
      });
    const rows = async () =>
      (
        await client.query<{ id: number; value: string }>(
          `SELECT id, value FROM ${quoteQualifiedIdentifier([schema, 'items'])} ORDER BY id, value`,
        )
      ).rows;

    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await client.query(
        `CREATE TABLE ${quoteQualifiedIdentifier([schema, 'items'])} (id integer, value text)`,
      );
      await client.query(
        `INSERT INTO ${quoteQualifiedIdentifier([schema, 'items'])} VALUES (9, 'target')`,
      );

      const blocked = await createRestoreEngine().restore({
        archive: makeArchive(),
        target: fromPgClient(client),
        options: { existingObjectPolicy: 'skip' },
      });
      expect(blocked.status).toBe('failed');
      expect(await rows()).toEqual([{ id: 9, value: 'target' }]);

      const skipped = await createRestoreEngine().restore({
        archive: makeArchive(),
        target: fromPgClient(client),
        options: {
          existingObjectPolicy: 'skip',
          existingTableDataPolicy: 'skip-data',
        },
      });
      expect(skipped.status).toBe('success');
      expect(await rows()).toEqual([{ id: 9, value: 'target' }]);

      const truncated = await createRestoreEngine().restore({
        archive: makeArchive(),
        target: fromPgClient(client),
        options: {
          existingObjectPolicy: 'skip',
          existingTableDataPolicy: 'truncate',
        },
      });
      expect(truncated.status, JSON.stringify(truncated.diagnostics, null, 2)).toBe('success');
      expect(truncated.tablesTruncatedCount).toBe(1);
      expect(await rows()).toEqual([{ id: 1, value: 'archive' }]);

      const appended = await createRestoreEngine().restore({
        archive: makeArchive(),
        target: fromPgClient(client),
        options: {
          existingObjectPolicy: 'skip',
          existingTableDataPolicy: 'append',
          existingSequenceStatePolicy: 'preserve-target',
        },
      });
      expect(appended.status, JSON.stringify(appended.diagnostics, null, 2)).toBe('success');
      expect(appended.tablesAppendedCount).toBe(1);
      expect(await rows()).toEqual([
        { id: 1, value: 'archive' },
        { id: 1, value: 'archive' },
      ]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await client.end();
    }
  });
});
