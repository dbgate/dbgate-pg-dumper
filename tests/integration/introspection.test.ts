import { Client } from 'pg';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { dumpPostgres, introspectPostgres, type PostgresDatabase } from '../../src/index.js';
import { fromPgClient } from '../../src/pg.js';

interface TestServer {
  readonly major: number;
  readonly url: string;
}

const configuredServers: readonly TestServer[] = [
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
const selectedUrl = process.env.PG_TEST_URL;
const servers =
  selectedMajor === undefined
    ? configuredServers
    : configuredServers
        .filter((server) => server.major === Number(selectedMajor))
        .map((server) => ({ ...server, url: selectedUrl ?? server.url }));

const connectedClients: Client[] = [];

afterEach(async () => {
  await Promise.all(connectedClients.splice(0).map((client) => client.end()));
});

async function createFixtures(client: Client, major: number): Promise<void> {
  await client.query(`
    DROP SCHEMA IF EXISTS fixture CASCADE;
    DROP SCHEMA IF EXISTS "MixedCase" CASCADE;
    DROP SCHEMA IF EXISTS "データ" CASCADE;

    CREATE SCHEMA fixture;
    CREATE SCHEMA "MixedCase";
    CREATE SCHEMA "データ";

    CREATE TYPE fixture.mood AS ENUM ('sad', 'ok', 'happy');
    CREATE DOMAIN fixture.positive_integer AS integer
      DEFAULT 1
      CHECK (VALUE > 0);

    CREATE SEQUENCE fixture.standalone_sequence
      START WITH 10 INCREMENT BY 5 CACHE 3 CYCLE;

    CREATE TABLE fixture.normal_table (
      id serial NOT NULL,
      label text DEFAULT 'hello' CHECK (length(label) > 0),
      mood fixture.mood DEFAULT 'ok',
      score fixture.positive_integer,
      dropped_value text
    );
    ALTER TABLE fixture.normal_table DROP COLUMN dropped_value;
    CREATE INDEX normal_table_lower_label_idx
      ON fixture.normal_table (lower(label));
    CREATE INDEX normal_table_partial_idx
      ON fixture.normal_table (id)
      WHERE score > 10;

    CREATE TABLE fixture.parent_keys (
      left_id integer NOT NULL,
      right_id integer NOT NULL,
      alternate_name text NOT NULL,
      CONSTRAINT parent_keys_pk PRIMARY KEY (left_id, right_id),
      CONSTRAINT parent_keys_name_unique UNIQUE (alternate_name)
    );

    CREATE TABLE fixture.child_keys (
      id integer PRIMARY KEY,
      parent_left integer,
      parent_right integer,
      CONSTRAINT child_parent_fk
        FOREIGN KEY (parent_left, parent_right)
        REFERENCES fixture.parent_keys (left_id, right_id)
        MATCH FULL
        ON UPDATE CASCADE
        ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE "MixedCase"."Order" (
      "Primary Key" integer NOT NULL,
      "Display Name" text COLLATE "C"
    );

    CREATE TABLE "データ"."項目" (
      "識別子" integer NOT NULL,
      "値" text
    );
    INSERT INTO "データ"."項目" VALUES (1, 'Žluťoučký kůň');

    CREATE TABLE fixture.data_types (
      id integer PRIMARY KEY,
      exact_numeric numeric(40, 20),
      signed_bigint bigint,
      bytes bytea,
      identifier uuid,
      json_value json,
      jsonb_value jsonb,
      integer_array integer[],
      text_array text[],
      local_time timestamp,
      absolute_time timestamptz,
      duration interval,
      integer_range int4range,
      address inet,
      network cidr,
      flags bit varying,
      payload text
    );
    INSERT INTO fixture.data_types VALUES (
      1, 9007199254740993.00000000000000000001, -9223372036854775808,
      decode('00017fff', 'hex'), '123e4567-e89b-12d3-a456-426614174000',
      '{"text": "literal \\\\N and unicode 🦊", "number": 9007199254740993}',
      '{"nested": [true, null, {"quote": "''"}]}',
      ARRAY[1, NULL, 3], ARRAY['comma,value', NULL, 'quote"value', E'line\\nbreak'],
      '2024-03-31 02:30:00', '2024-10-27 02:30:00+02',
      '2 years 3 mons 4 days 05:06:07.890123', '[1,10)',
      '2001:db8::1/64', '10.0.0.0/8', B'00101101',
      E'first\\r\\nsecond\\n\\\\N\\n\\\\.\\ntrailing\\\\'
    );
    INSERT INTO fixture.data_types
      SELECT 2, NULL, 9223372036854775807, decode('', 'hex'), NULL, NULL, '{}'::jsonb,
             '{}'::integer[], ARRAY[]::text[], NULL, NULL, NULL, 'empty'::int4range,
             NULL, NULL, B'', repeat('toast-🦊', 150000);
    INSERT INTO fixture.normal_table (id, label, mood, score)
      VALUES (10, 'multiline' || E'\\n' || 'label', 'happy', 12);
    SELECT pg_catalog.setval('fixture.normal_table_id_seq', 42, false);
    SELECT pg_catalog.setval('fixture.standalone_sequence', 25, true);
    INSERT INTO fixture.parent_keys VALUES (1, 2, 'parent');
    INSERT INTO fixture.child_keys VALUES (3, 1, 2);
    INSERT INTO "MixedCase"."Order" VALUES (7, 'quoted');
  `);

  await client.query(`
    DO $block$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fixture_reader') THEN
        CREATE ROLE fixture_reader;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'Read Only') THEN
        CREATE ROLE "Read Only";
      END IF;
    END
    $block$;

    CREATE VIEW fixture.normal_view AS
      SELECT id, label FROM fixture.normal_table;
    CREATE VIEW fixture.secure_view WITH (security_barrier=true) AS
      SELECT id, label FROM fixture.normal_table WHERE score > 0;
    CREATE MATERIALIZED VIEW fixture.normal_materialized_view AS
      SELECT mood, count(*) AS item_count
      FROM fixture.normal_table
      GROUP BY mood
      WITH NO DATA;
    CREATE UNIQUE INDEX normal_materialized_view_mood_idx
      ON fixture.normal_materialized_view (mood);

    CREATE FUNCTION fixture.add_one(value integer)
      RETURNS integer
      LANGUAGE sql
      IMMUTABLE STRICT PARALLEL SAFE
      AS 'SELECT value + 1';
    CREATE FUNCTION fixture.overloaded(value integer)
      RETURNS text
      LANGUAGE sql
      AS 'SELECT value::text';
    CREATE FUNCTION fixture.overloaded(value text)
      RETURNS text
      LANGUAGE sql
      AS 'SELECT value';
    CREATE FUNCTION fixture.decorate(value text)
      RETURNS text
      LANGUAGE plpgsql
      STABLE
      AS $function$
      BEGIN
        RETURN '[' || value || ']';
      END
      $function$;
    CREATE AGGREGATE fixture.concat_text(text) (
      SFUNC = pg_catalog.textcat,
      STYPE = text,
      INITCOND = ''
    );

    CREATE TABLE fixture.rule_log (item_id integer);
    CREATE RULE normal_table_update_log AS
      ON UPDATE TO fixture.normal_table
      DO ALSO INSERT INTO fixture.rule_log(item_id) VALUES (NEW.id);

    CREATE FUNCTION fixture.normalize_label()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        NEW.label := trim(NEW.label);
        RETURN NEW;
      END
      $function$;
    CREATE TRIGGER normal_table_before_update
      BEFORE UPDATE ON fixture.normal_table
      FOR EACH ROW
      WHEN (OLD.label IS DISTINCT FROM NEW.label)
      EXECUTE PROCEDURE fixture.normalize_label();
    CREATE TRIGGER normal_table_after_insert
      AFTER INSERT ON fixture.normal_table
      FOR EACH STATEMENT
      EXECUTE PROCEDURE fixture.normalize_label();
    ALTER TABLE fixture.normal_table DISABLE TRIGGER normal_table_after_insert;

    COMMENT ON SCHEMA fixture IS 'integration schema';
    COMMENT ON TABLE fixture.normal_table IS 'table comment';
    COMMENT ON COLUMN fixture.normal_table.label IS '';
    COMMENT ON VIEW fixture.normal_view IS 'ordinary view';
    COMMENT ON MATERIALIZED VIEW fixture.normal_materialized_view IS 'cached summary';
    COMMENT ON FUNCTION fixture.overloaded(integer) IS 'integer overload';
    COMMENT ON TRIGGER normal_table_before_update ON fixture.normal_table IS 'normalizes labels';
    COMMENT ON RULE normal_table_update_log ON fixture.normal_table IS 'audit rewrite rule';

    GRANT USAGE ON SCHEMA fixture TO fixture_reader;
    GRANT SELECT ON fixture.normal_table TO fixture_reader;
    GRANT SELECT ON fixture.normal_view TO PUBLIC;
    GRANT EXECUTE ON FUNCTION fixture.overloaded(integer) TO "Read Only";
    ALTER DEFAULT PRIVILEGES IN SCHEMA fixture
      GRANT SELECT ON TABLES TO fixture_reader;

    ALTER TABLE fixture.normal_table ENABLE ROW LEVEL SECURITY;
    CREATE POLICY normal_table_read_policy ON fixture.normal_table
      FOR SELECT TO fixture_reader
      USING (score > 0);
    CREATE POLICY normal_table_public_policy ON fixture.normal_table
      FOR SELECT TO PUBLIC
      USING (score > 0);
  `);

  if (major >= 10) {
    await client.query(`
      CREATE TABLE fixture.identity_table (
        id bigint GENERATED ALWAYS AS IDENTITY,
        payload text
      );
      INSERT INTO fixture.identity_table (id, payload)
        OVERRIDING SYSTEM VALUE VALUES (101, 'identity');
      CREATE TABLE fixture.partitioned_events (
        event_id integer NOT NULL,
        created_on date NOT NULL
      ) PARTITION BY RANGE (created_on);
      CREATE TABLE fixture.events_2025
        PARTITION OF fixture.partitioned_events
        FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
      INSERT INTO fixture.partitioned_events VALUES (1, '2025-04-05');

      CREATE FUNCTION fixture.capture_transition()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          RETURN NULL;
        END
        $function$;
      CREATE TRIGGER normal_table_transition
        AFTER UPDATE ON fixture.normal_table
        REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
        FOR EACH STATEMENT
        EXECUTE PROCEDURE fixture.capture_transition();

      CREATE POLICY normal_table_write_policy ON fixture.normal_table
        AS RESTRICTIVE
        FOR UPDATE TO fixture_reader
        USING (score > 0)
        WITH CHECK (score > 0);
    `);
  }

  if (major >= 11) {
    await client.query(`
      CREATE TABLE fixture.events_default
        PARTITION OF fixture.partitioned_events DEFAULT;
      CREATE INDEX partitioned_events_event_id_idx
        ON fixture.partitioned_events (event_id);
      CREATE INDEX normal_table_label_include_idx
        ON fixture.normal_table (label) INCLUDE (score);

      CREATE PROCEDURE fixture.refresh_fixture()
        LANGUAGE plpgsql
        AS $procedure$
        BEGIN
          REFRESH MATERIALIZED VIEW fixture.normal_materialized_view;
        END
        $procedure$;
      COMMENT ON PROCEDURE fixture.refresh_fixture() IS 'refreshes fixture cache';
    `);
  }

  if (major >= 12) {
    await client.query(`
      CREATE TABLE fixture.generated_table (
        base_value integer NOT NULL,
        doubled integer GENERATED ALWAYS AS (base_value * 2) STORED
      );
      INSERT INTO fixture.generated_table (base_value) VALUES (21);
    `);
  }

  if (major >= 15) {
    await client.query(`
      CREATE VIEW fixture.invoker_view WITH (security_invoker=true) AS
        SELECT id FROM fixture.normal_table;
    `);
  }
}

async function restoreWithPsql(connectionString: string, sql: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.env.PG_PSQL ?? 'psql',
      ['--set', 'ON_ERROR_STOP=1', '--no-psqlrc', '--dbname', connectionString],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql restore failed with exit code ${String(code)}: ${stderr}`));
    });
    child.stdin.end(sql);
  });
}

function structuralFingerprint(database: PostgresDatabase): unknown {
  return {
    schemas: database.schemas.map((schema) => ({
      name: schema.name,
      enums: schema.enumTypes.map((type) => ({
        name: type.name,
        labels: type.labels.map((label) => label.label),
      })),
      domains: schema.domains.map((domain) => ({
        name: domain.name,
        baseType: domain.formattedBaseType,
        nullable: domain.nullable,
        defaultExpression: domain.defaultExpression,
        constraints: domain.constraints.map((constraint) => constraint.expression),
      })),
      sequences: schema.sequences.map((sequence) => ({
        name: sequence.name,
        dataType: sequence.dataType,
        increment: sequence.increment,
        minimumValue: sequence.minimumValue,
        maximumValue: sequence.maximumValue,
        startValue: sequence.startValue,
        cacheSize: sequence.cacheSize,
        cycle: sequence.cycle,
        ownership: sequence.ownership,
        ownedBy: sequence.ownedBy?.subName,
      })),
      tables: schema.tables.map((table) => ({
        name: table.name,
        kind: table.kind,
        persistence: table.persistence,
        rowLevelSecurity: table.rowLevelSecurity,
        forceRowLevelSecurity: table.forceRowLevelSecurity,
        partitionKey: table.partition?.keyDefinition,
        bound: table.bound?.expression,
        parents: table.parents.map((parent) => parent.name),
        columns: table.columns.map((item) => ({
          name: item.name,
          formattedType: item.formattedType,
          nullable: item.nullable,
          defaultExpression: item.identity === undefined ? item.defaultExpression : undefined,
          identity: item.identity,
          generatedExpression: item.generatedExpression,
          collation: item.collation,
          storage: item.storage,
        })),
      })),
    })),
    constraints: database.constraints.map((constraint) => ({
      name: constraint.name,
      kind: constraint.kind,
      validated: constraint.validated,
    })),
    indexes: database.indexes
      .filter((index) => index.exportable)
      .map((index) => ({
        name: index.name,
        table: index.table.name,
        unique: index.unique,
        primary: index.primary,
        predicate: index.predicate,
        elements: index.elements.map((element) => ({
          key: element.key,
          column: element.column?.subName,
          expression: element.expression,
        })),
      })),
    views: database.views.map((view) => ({
      name: view.name,
      securityBarrier: view.securityBarrier,
      securityInvoker: view.securityInvoker,
      checkOption: view.checkOption,
    })),
    materializedViews: database.materializedViews.map((view) => ({
      name: view.name,
      populated: view.populated,
      indexes: view.indexes.map((index) => index.name),
    })),
    functions: database.functions.map((routine) => ({
      name: routine.name,
      identityArguments: routine.identityArguments,
    })),
    procedures: database.procedures.map((routine) => ({
      name: routine.name,
      identityArguments: routine.identityArguments,
    })),
    aggregates: database.aggregates.map((routine) => ({
      name: routine.name,
      identityArguments: routine.identityArguments,
    })),
    triggers: database.triggers.map((trigger) => ({
      name: trigger.name,
      table: trigger.table.name,
      enabled: trigger.enabled,
    })),
    rules: database.rules.map((rule) => ({ name: rule.name, relation: rule.relation.name })),
    policies: database.policies.map((policy) => ({
      name: policy.name,
      table: policy.table.name,
      command: policy.command,
      permissive: policy.permissive,
      roles: policy.roles,
    })),
  };
}

describe.each(servers)('PostgreSQL $major introspection', ({ major, url }) => {
  it('returns the normalized structural database model', async () => {
    const client = new Client({ connectionString: url });
    connectedClients.push(client);
    await client.connect();
    await createFixtures(client, major);

    const result = await introspectPostgres(fromPgClient(client), {
      selection: {
        includeSchemas: ['fixture', 'MixedCase', 'データ'],
      },
    });

    expect(result.metadata.source.version.major).toBe(major);
    expect(result.metadata.session).toMatchObject({
      transactionMode: 'managed',
      consistentSnapshot: true,
    });

    const schemaNames = result.database.schemas.map((schema) => schema.name);
    expect(schemaNames).toEqual(['MixedCase', 'fixture', 'データ']);

    const fixture = result.database.schemas.find((schema) => schema.name === 'fixture');
    expect(fixture).toBeDefined();
    const normal = fixture?.tables.find((table) => table.name === 'normal_table');
    expect(normal?.columns.map((column) => column.name)).toEqual(['id', 'label', 'mood', 'score']);
    expect(normal?.columns.find((column) => column.name === 'mood')?.typeDependency).toMatchObject({
      kind: 'enum',
      name: 'mood',
    });
    expect(normal?.columns.find((column) => column.name === 'score')?.typeDependency).toMatchObject(
      { kind: 'domain', name: 'positive_integer' },
    );

    expect(fixture?.enumTypes[0]?.labels.map((label) => label.label)).toEqual([
      'sad',
      'ok',
      'happy',
    ]);
    expect(fixture?.domains[0]).toMatchObject({
      name: 'positive_integer',
      defaultExpression: '1',
      constraints: [{ kind: 'check' }],
    });

    expect(
      fixture?.sequences.find((sequence) => sequence.name === 'standalone_sequence'),
    ).toMatchObject({
      ownership: 'standalone',
      startValue: '10',
      increment: '5',
      cacheSize: major >= 10 ? '3' : '1',
      cycle: true,
    });
    expect(
      fixture?.sequences.find((sequence) => sequence.name === 'normal_table_id_seq'),
    ).toMatchObject({
      ownership: 'serial',
      ownedBy: { name: 'normal_table', subName: 'id' },
    });

    const primaryKey = result.database.constraints.find(
      (constraint) => constraint.name === 'parent_keys_pk',
    );
    expect(
      primaryKey?.kind === 'primary-key' ? primaryKey.columns.map((column) => column.subName) : [],
    ).toEqual(['left_id', 'right_id']);
    expect(
      result.database.constraints.find(
        (constraint) => constraint.name === 'parent_keys_name_unique',
      ),
    ).toMatchObject({ kind: 'unique' });
    expect(
      result.database.constraints.find((constraint) => constraint.name === 'child_parent_fk'),
    ).toMatchObject({
      kind: 'foreign-key',
      match: 'full',
      onUpdate: 'cascade',
      onDelete: 'set-null',
      deferrable: true,
      initiallyDeferred: true,
    });
    expect(
      result.database.constraints.find(
        (constraint) => constraint.kind === 'check' && constraint.table?.name === 'normal_table',
      ),
    ).toBeDefined();

    const expressionIndex = result.database.indexes.find(
      (index) => index.name === 'normal_table_lower_label_idx',
    );
    expect(expressionIndex?.expressions).toContain('lower');
    expect(expressionIndex?.elements[0]?.expression).toContain('lower');
    expect(
      result.database.indexes.find((index) => index.name === 'normal_table_partial_idx')?.predicate,
    ).toContain('score');

    const mixed = result.database.schemas.find((schema) => schema.name === 'MixedCase');
    expect(mixed?.tables[0]?.columns.map((column) => column.name)).toEqual([
      'Primary Key',
      'Display Name',
    ]);

    const unicode = result.database.schemas.find((schema) => schema.name === 'データ');
    expect(unicode?.tables[0]?.name).toBe('項目');

    if (major >= 10) {
      expect(
        fixture?.tables
          .find((table) => table.name === 'identity_table')
          ?.columns.find((column) => column.name === 'id')?.identity,
      ).toBe('always');
      expect(
        fixture?.sequences.find((sequence) => sequence.name === 'identity_table_id_seq'),
      ).toMatchObject({ ownership: 'identity' });

      const parent = fixture?.tables.find((table) => table.name === 'partitioned_events');
      const child = fixture?.tables.find((table) => table.name === 'events_2025');
      expect(parent?.kind).toBe('partitioned');
      expect(parent?.children.map((table) => table.name)).toContain('events_2025');
      expect(parent?.partition?.strategy).toBe('range');
      expect(parent?.partition?.keyDefinition).toContain('created_on');
      expect(child?.kind).toBe('partition');
      expect(child?.parents.map((table) => table.name)).toContain('partitioned_events');
      expect(child?.bound?.expression).toContain('2025-01-01');
    }

    if (major >= 11) {
      expect(fixture?.tables.find((table) => table.name === 'events_default')?.bound).toEqual({
        expression: 'DEFAULT',
        default: true,
      });
      const includeIndex = result.database.indexes.find(
        (index) => index.name === 'normal_table_label_include_idx',
      );
      expect(includeIndex?.elements[0]).toMatchObject({ key: true });
      expect(includeIndex?.elements[0]?.column?.subName).toBe('label');
      expect(includeIndex?.elements[1]).toMatchObject({ key: false });
      expect(includeIndex?.elements[1]?.column?.subName).toBe('score');
      expect(
        result.database.indexes.some(
          (index) => index.name.startsWith('events_2025') && index.parentIndexOid !== undefined,
        ),
      ).toBe(true);
    }

    if (major >= 12) {
      expect(
        fixture?.tables
          .find((table) => table.name === 'generated_table')
          ?.columns.find((column) => column.name === 'doubled')?.generatedExpression,
      ).toContain('base_value');
    }

    expect(result.database.views.find((view) => view.name === 'normal_view')).toMatchObject({
      owner: 'dumper',
      columns: [
        { name: 'id', formattedType: 'integer' },
        { name: 'label', formattedType: 'text' },
      ],
    });
    expect(result.database.views.find((view) => view.name === 'secure_view')).toMatchObject({
      securityBarrier: true,
    });
    expect(
      result.database.materializedViews.find((view) => view.name === 'normal_materialized_view'),
    ).toMatchObject({
      populated: false,
      indexes: [{ name: 'normal_materialized_view_mood_idx' }],
    });

    expect(
      result.database.functions
        .filter((item) => item.name === 'overloaded')
        .map((item) => item.identityArguments),
    ).toEqual(['value integer', 'value text']);
    expect(result.database.functions.find((item) => item.name === 'add_one')).toMatchObject({
      volatility: 'immutable',
      strict: true,
      parallelSafety: 'safe',
    });
    expect(result.database.functions.find((item) => item.name === 'decorate')?.language).toBe(
      'plpgsql',
    );
    expect(result.database.aggregates.find((item) => item.name === 'concat_text')).toMatchObject({
      stateTypeName: 'text',
      initialCondition: '',
    });

    const beforeUpdateTrigger = result.database.triggers.find(
      (trigger) => trigger.name === 'normal_table_before_update',
    );
    expect(beforeUpdateTrigger).toMatchObject({
      timing: 'before',
      events: ['update'],
      level: 'row',
    });
    expect(beforeUpdateTrigger?.when).toContain('label');
    expect(
      result.database.triggers.find((trigger) => trigger.name === 'normal_table_after_insert'),
    ).toMatchObject({ enabled: 'disabled', timing: 'after', events: ['insert'] });
    expect(
      result.database.rules.find((rule) => rule.name === 'normal_table_update_log'),
    ).toMatchObject({ event: 'update', instead: false });
    expect(result.database.rules.some((rule) => rule.name === '_RETURN')).toBe(false);

    expect(
      result.database.comments.find((comment) => comment.object.name === 'normal_table'),
    ).toMatchObject({ text: 'table comment' });
    expect(
      result.database.accessControls.find(
        (acl) => acl.object.name === 'normal_view' && acl.grantee === 'PUBLIC',
      ),
    ).toMatchObject({ privilege: 'SELECT' });
    expect(
      result.database.accessControls.find(
        (acl) =>
          acl.object.name === 'overloaded' &&
          acl.object.subName === 'value integer' &&
          acl.grantee === 'Read Only',
      ),
    ).toMatchObject({ privilege: 'EXECUTE' });
    expect(result.database.defaultPrivileges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: 'fixture',
          objectType: 'table',
          grantee: 'fixture_reader',
          privilege: 'SELECT',
        }),
      ]),
    );
    expect(
      result.database.policies.find((policy) => policy.name === 'normal_table_read_policy'),
    ).toMatchObject({
      command: 'select',
      permissive: true,
      roles: ['fixture_reader'],
    });
    expect(
      result.database.policies.find((policy) => policy.name === 'normal_table_public_policy'),
    ).toMatchObject({ roles: ['PUBLIC'] });

    if (major >= 10) {
      expect(
        result.database.triggers.find((trigger) => trigger.name === 'normal_table_transition'),
      ).toMatchObject({
        oldTransitionTable: 'old_rows',
        newTransitionTable: 'new_rows',
      });
      expect(
        result.database.policies.find((policy) => policy.name === 'normal_table_write_policy'),
      ).toMatchObject({ command: 'update', permissive: false });
    }

    if (major >= 11) {
      expect(
        result.database.procedures.find((item) => item.name === 'refresh_fixture'),
      ).toBeDefined();
    } else {
      expect(result.database.procedures).toEqual([]);
    }

    if (major >= 15) {
      expect(result.database.views.find((view) => view.name === 'invoker_view')).toMatchObject({
        securityInvoker: true,
      });
    } else {
      expect(result.database.views.every((view) => view.securityInvoker === undefined)).toBe(true);
    }
  });

  it.each(['copy', 'insert'] as const)(
    'renders and restores a complete %s dump into a clean database',
    async (dataFormat) => {
      const source = new Client({ connectionString: url });
      connectedClients.push(source);
      await source.connect();
      await createFixtures(source, major);
      await source.query('DROP DATABASE IF EXISTS dumper_restore');
      await source.query('CREATE DATABASE dumper_restore');

      const chunks: Uint8Array[] = [];
      const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Uint8Array.from(chunk));
          callback();
        },
      });
      const selection = {
        includeSchemas: ['fixture', 'MixedCase', 'ãƒ‡ãƒ¼ã‚¿'],
      };
      const dumpResult = await dumpPostgres(
        fromPgClient(source),
        {
          mode: 'full',
          dataFormat,
          selection,
          unsupportedFeaturePolicy: 'error',
        },
        output,
      );
      expect(dumpResult.rowsWritten).toBeGreaterThan(0);

      const targetUrl = new URL(url);
      targetUrl.pathname = '/dumper_restore';
      await restoreWithPsql(targetUrl.toString(), Buffer.concat(chunks).toString('utf8'));
      const target = new Client({ connectionString: targetUrl.toString() });
      connectedClients.push(target);
      await target.connect();
      const [sourceModel, restoredModel] = await Promise.all([
        introspectPostgres(fromPgClient(source), { selection }),
        introspectPostgres(fromPgClient(target), { selection }),
      ]);
      expect(structuralFingerprint(restoredModel.database)).toEqual(
        structuralFingerprint(sourceModel.database),
      );
      const dataSql = `
      SELECT id, exact_numeric::text, signed_bigint::text, encode(bytes, 'hex') AS bytes,
             identifier::text, json_value::text, jsonb_value::text,
             integer_array::text, text_array::text, local_time::text,
             absolute_time::text, duration::text, integer_range::text,
             address::text, network::text, flags::text, md5(payload) AS payload_hash
      FROM fixture.data_types ORDER BY id
    `;
      const [sourceData, restoredData] = await Promise.all([
        source.query(dataSql),
        target.query(dataSql),
      ]);
      expect(restoredData.rows).toEqual(sourceData.rows);

      const sequenceSql = `
      SELECT 'normal' AS name, last_value::text, is_called
      FROM fixture.normal_table_id_seq
      UNION ALL
      SELECT 'standalone', last_value::text, is_called
      FROM fixture.standalone_sequence
      ORDER BY name
    `;
      const [sourceSequences, restoredSequences] = await Promise.all([
        source.query(sequenceSql),
        target.query(sequenceSql),
      ]);
      expect(restoredSequences.rows).toEqual(sourceSequences.rows);
    },
  );
});
