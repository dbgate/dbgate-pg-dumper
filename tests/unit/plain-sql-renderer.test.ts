/**
 * Renderer tests use hand-built normalized objects and archives. This keeps SQL
 * behavior independent from catalog mapping tests and makes compatibility
 * transformations explicit.
 */

import { describe, expect, it } from 'vitest';

import type {
  ArchiveEntry,
  ArchiveObjectType,
  DumpArchiveInspection,
  PlainSqlRenderContext,
  PostgresColumn,
  PostgresObjectReference,
} from '../../src/index.js';
import {
  detectSourceCapabilities,
  PlainSqlArchiveRenderer,
  PostgresSqlRenderer,
  PostgresVersionService,
  renderPlainSql,
  StringDumpWriter,
} from '../../src/index.js';
import { detectTargetCapabilities } from '../../src/compatibility/TargetCapabilities.js';
import {
  normalizePlainSqlRenderOptions,
  PlainSqlWarningCollector,
} from '../../src/renderer/RenderTypes.js';

const versionService = new PostgresVersionService();
const pg18 = versionService.parse(180000, 'PostgreSQL 18');
const pg9 = versionService.parse(90600, 'PostgreSQL 9.6');
const sourceCapabilities = detectSourceCapabilities(pg18);

function entry(
  objectType: ArchiveObjectType,
  name: string,
  sourceObject: unknown,
  overrides: Partial<ArchiveEntry> = {},
): ArchiveEntry {
  const schema = overrides.schema ?? (objectType === 'database' ? undefined : 'app');
  const archiveIdentity = overrides.archiveIdentity ?? `${objectType}:${schema ?? ''}:${name}`;
  return {
    dumpId: overrides.dumpId ?? `id-${archiveIdentity}`,
    archiveIdentity,
    objectType,
    ...(schema === undefined ? {} : { schema }),
    name,
    specificIdentity: overrides.specificIdentity ?? '',
    section: overrides.section ?? 'pre-data',
    dependencyDumpIds: overrides.dependencyDumpIds ?? [],
    dependencies: overrides.dependencies ?? [],
    selection: overrides.selection ?? {
      selected: true,
      reason: 'explicit',
      requiredByDumpIds: [],
    },
    sourceObject,
    diagnostics: overrides.diagnostics ?? [],
    ...overrides,
  };
}

function archive(entries: readonly ArchiveEntry[]): DumpArchiveInspection {
  return {
    valid: true,
    entries,
    orderedEntries: entries,
    orderedDumpIds: entries.map((item) => item.dumpId),
    diagnostics: [],
  };
}

function context(
  item: ArchiveEntry,
  all: readonly ArchiveEntry[] = [item],
  optionOverrides: Parameters<typeof normalizePlainSqlRenderOptions>[1] = {},
): PlainSqlRenderContext {
  const options = normalizePlainSqlRenderOptions(pg18, optionOverrides);
  return {
    sourceVersion: pg18,
    targetVersion: options.targetVersion,
    sourceCapabilities,
    targetCapabilities: detectTargetCapabilities(options.targetVersion),
    options,
    archive: archive(all),
    entry: item,
    identifierPolicy: { quoteAllIdentifiers: options.quoteAllIdentifiers },
    warnings: new PlainSqlWarningCollector(),
    writer: new StringDumpWriter({ lineEnding: options.lineEnding }),
  };
}

const tableReference = (oid: number, name: string): PostgresObjectReference => ({
  kind: 'table',
  oid,
  schema: 'app',
  name,
});

const column = (
  tableOid: number,
  name: string,
  ordinalPosition: number,
  overrides: Partial<PostgresColumn> = {},
): PostgresColumn => ({
  tableOid,
  attributeNumber: ordinalPosition,
  ordinalPosition,
  name,
  formattedType: 'integer',
  typeOid: 23,
  typeModifier: -1,
  nullable: true,
  storage: 'plain',
  ...overrides,
});

describe('individual schema object rendering', () => {
  const renderer = new PostgresSqlRenderer();

  it('creates extensions idempotently by default while allowing strict creation', () => {
    const extension = entry(
      'extension',
      'plpgsql',
      {
        oid: 13_591,
        name: 'plpgsql',
        schema: 'pg_catalog',
        version: '1.0',
        relocatable: false,
      },
      { schema: 'pg_catalog' },
    );

    expect(renderer.renderCreate(context(extension))).toEqual([
      "CREATE EXTENSION IF NOT EXISTS plpgsql WITH SCHEMA pg_catalog VERSION '1.0';",
    ]);
    expect(
      renderer.renderCreate(context(extension, [extension], { extensionIfNotExists: false })),
    ).toEqual(["CREATE EXTENSION plpgsql WITH SCHEMA pg_catalog VERSION '1.0';"]);
  });

  it('renders schemas, enums, domains, and sequences', () => {
    const schema = entry('schema', 'Order', {
      oid: 10,
      name: 'Order',
      owner: 'db owner',
      tables: [],
      sequences: [],
      enumTypes: [],
      domains: [],
    });
    expect(renderer.renderCreate(context(schema, [schema], { schemaAuthorization: true }))).toEqual(
      ['CREATE SCHEMA "Order" AUTHORIZATION "db owner";'],
    );
    const publicSchema = entry('schema', 'public', {
      oid: 9,
      name: 'public',
      owner: 'db owner',
      tables: [],
      sequences: [],
      enumTypes: [],
      domains: [],
    });
    expect(renderer.renderCreate(context(publicSchema))).toEqual([]);

    const enumEntry = entry('enum', 'mood', {
      oid: 11,
      schema: 'app',
      name: 'mood',
      labels: [
        { oid: 2, label: "can't", sortOrder: 2 },
        { oid: 1, label: 'ok', sortOrder: 1 },
      ],
      dependencies: [],
    });
    expect(renderer.renderCreate(context(enumEntry))).toEqual([
      "CREATE TYPE app.mood AS ENUM ('ok', 'can''t');",
    ]);

    const domain = entry('domain', 'positive_int', {
      oid: 12,
      schema: 'app',
      name: 'positive_int',
      formattedBaseType: 'integer',
      baseTypeOid: 23,
      nullable: false,
      defaultExpression: '1',
      constraints: [
        {
          name: 'positive',
          expression: 'VALUE > 0',
          validated: true,
        },
      ],
      dependencies: [],
    });
    expect(renderer.renderCreate(context(domain))[0]).toMatch(
      /CREATE DOMAIN app\.positive_int AS integer\s+DEFAULT 1/u,
    );
    expect(renderer.renderCreate(context(domain))[0]).toContain(
      'CONSTRAINT positive CHECK (VALUE > 0)',
    );
    const domainConstraint = entry(
      'constraint',
      'positive',
      {
        oid: 14,
        schema: 'app',
        name: 'positive',
        kind: 'check',
        expression: 'VALUE > 0',
        validated: true,
        domain: { kind: 'domain', oid: 12, schema: 'app', name: 'positive_int' },
        dependencies: [],
      },
      { parent: { kind: 'domain', oid: 12, schema: 'app', name: 'positive_int' } },
    );
    expect(renderer.renderDrop(context(domainConstraint))).toEqual([]);

    const sequence = entry('sequence', 'items_id_seq', {
      oid: 13,
      schema: 'app',
      name: 'items_id_seq',
      dataType: 'bigint',
      increment: '2',
      minimumValue: '1',
      maximumValue: '9223372036854775807',
      startValue: '5',
      cacheSize: '10',
      cycle: false,
      ownership: 'standalone',
      dependencies: [],
    });
    expect(renderer.renderCreate(context(sequence))[0]).toMatch(
      /CREATE SEQUENCE app\.items_id_seq[\s\S]*START WITH 5[\s\S]*NO CYCLE;/u,
    );
    expect(
      renderer.renderCreate(context(sequence, [sequence], { targetVersion: pg9 }))[0],
    ).not.toContain('AS bigint');

    const sequenceState = entry('sequence-state', 'items_id_seq', sequence.sourceObject, {
      section: 'data',
      dataExport: {
        kind: 'sequence-state',
        relationOid: 15,
        schema: 'app',
        name: 'items_id_seq',
        currentValue: '9223372036854775800',
        isCalled: false,
      },
    });
    expect(renderer.renderCreate(context(sequenceState))).toEqual([
      `SELECT pg_catalog.setval('"app"."items_id_seq"'::pg_catalog.regclass, 9223372036854775800, FALSE);`,
    ]);
  });

  it('renders identity, generated, partitioning, and storage clauses', () => {
    const table = entry('table', 'events', {
      oid: 20,
      schema: 'app',
      name: 'events',
      kind: 'partitioned',
      persistence: 'unlogged',
      owner: 'owner',
      dependencies: [],
      rowLevelSecurity: true,
      forceRowLevelSecurity: true,
      partition: {
        strategy: 'range',
        keyDefinition: 'RANGE (created_at)',
        keyAttributeNumbers: [3],
      },
      parents: [],
      children: [],
      columns: [
        column(20, 'id', 1, { nullable: false, identity: 'always' }),
        column(20, 'total', 2, {
          generatedExpression: '(id * 2)',
          compression: 'pglz',
          storage: 'extended',
        }),
        column(20, 'created_at', 3, {
          formattedType: 'timestamp with time zone',
          defaultExpression: 'CURRENT_TIMESTAMP',
        }),
      ],
    });
    const sql = renderer.renderCreate(context(table)).join('\n');
    expect(sql).toContain('CREATE UNLOGGED TABLE app.events');
    expect(sql).toContain('GENERATED ALWAYS AS IDENTITY');
    expect(sql).toContain('GENERATED ALWAYS AS ((id * 2)) STORED');
    expect(sql).toContain('PARTITION BY RANGE (created_at)');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER COLUMN total SET STORAGE EXTENDED');

    const defaults = entry('table', 'defaults', {
      oid: 22,
      schema: 'app',
      name: 'defaults',
      kind: 'ordinary',
      persistence: 'permanent',
      owner: 'owner',
      dependencies: [],
      accessMethod: 'heap',
      accessMethodIsDefault: true,
      rowLevelSecurity: false,
      forceRowLevelSecurity: false,
      parents: [],
      children: [],
      columns: [
        column(22, 'value', 1, {
          formattedType: 'text',
          collation: '"pg_catalog"."default"',
          collationIsDefault: true,
          storage: 'extended',
          storageIsDefault: true,
        }),
      ],
    });
    const defaultSql = renderer.renderCreate(context(defaults)).join('\n');
    expect(defaultSql).toBe('CREATE TABLE app.defaults (\n    value text\n);');
    expect(defaultSql).not.toContain('COLLATE');
    expect(defaultSql).not.toContain('USING heap');
    expect(defaultSql).not.toContain('SET STORAGE');

    const partition = entry('table', 'events_2026', {
      oid: 21,
      schema: 'app',
      name: 'events_2026',
      kind: 'partition',
      persistence: 'permanent',
      owner: 'owner',
      dependencies: [],
      rowLevelSecurity: false,
      forceRowLevelSecurity: false,
      parents: [{ oid: 20, schema: 'app', name: 'events' }],
      children: [],
      columns: [],
      bound: {
        expression: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
        default: false,
      },
    });
    expect(renderer.renderCreate(context(partition))[0]).toMatch(
      /PARTITION OF app\.events\s+FOR VALUES FROM \('2026-01-01'\) TO \('2027-01-01'\)/u,
    );
  });

  it('downgrades identity columns to owned sequences for PostgreSQL 9.6', () => {
    const identityColumn = column(23, 'id', 1, {
      nullable: false,
      identity: 'always',
    });
    const identitySequence = entry('sequence', 'items_id_seq', {
      oid: 24,
      schema: 'app',
      name: 'items_id_seq',
      owner: 'owner',
      dataType: 'bigint',
      increment: '1',
      minimumValue: '1',
      maximumValue: '9223372036854775807',
      startValue: '1',
      cacheSize: '1',
      cycle: false,
      ownership: 'identity',
      ownedBy: {
        kind: 'column',
        oid: 23,
        schema: 'app',
        name: 'items',
        subName: 'id',
      },
      dependencies: [],
    });
    const identityTable = entry('table', 'items', {
      oid: 23,
      schema: 'app',
      name: 'items',
      kind: 'ordinary',
      persistence: 'permanent',
      owner: 'owner',
      dependencies: [],
      rowLevelSecurity: false,
      forceRowLevelSecurity: false,
      parents: [],
      children: [],
      columns: [identityColumn],
    });
    const sequenceOwnership = entry(
      'sequence-ownership',
      'items_id_seq',
      identitySequence.sourceObject,
      {
        parent: {
          kind: 'column',
          oid: 23,
          schema: 'app',
          name: 'items',
          subName: 'id',
        },
      },
    );
    const identityColumnEntry = entry('column', 'id', identityColumn, {
      catalogOid: 23,
      parent: tableReference(23, 'items'),
    });
    const all = [identitySequence, identityTable, identityColumnEntry, sequenceOwnership];

    expect(
      renderer.renderCreate(
        context(identitySequence, all, {
          targetVersion: pg9,
          unsupportedFeaturePolicy: 'warn-skip',
        }),
      )[0],
    ).toContain('CREATE SEQUENCE app.items_id_seq');

    const tableContext = context(identityTable, all, {
      targetVersion: pg9,
      unsupportedFeaturePolicy: 'warn-skip',
    });
    expect(renderer.renderCreate(tableContext).join('\n')).toContain(
      `id integer DEFAULT pg_catalog.nextval('"app"."items_id_seq"'::pg_catalog.regclass) NOT NULL`,
    );
    expect(tableContext.warnings.getAll()).toMatchObject([
      {
        code: 'compatibility-downgrade',
        feature: 'identity columns',
        transformation:
          'identity semantics downgraded to sequence app.items_id_seq with a nextval default',
      },
    ]);
    expect(
      renderer.renderCreate(
        context(sequenceOwnership, all, {
          targetVersion: pg9,
          unsupportedFeaturePolicy: 'warn-skip',
        }),
      ),
    ).toEqual(['ALTER SEQUENCE app.items_id_seq OWNED BY app.items.id;']);

    expect(renderer.renderCreate(context(identitySequence, all))).toEqual([]);
  });

  it('qualifies serial sequence defaults independently of search_path', () => {
    const ownedBy: PostgresObjectReference = {
      kind: 'column',
      oid: 30,
      schema: 'public',
      name: 'big_bytea',
      subName: 'id',
    };
    const sequence = entry(
      'sequence',
      'big_bytea_id_seq',
      {
        oid: 31,
        schema: 'public',
        name: 'big_bytea_id_seq',
        owner: 'owner',
        dataType: 'integer',
        startValue: '1',
        increment: '1',
        minimumValue: '1',
        maximumValue: '2147483647',
        cacheSize: '1',
        cycle: false,
        ownership: 'serial',
        ownedBy,
        dependencies: [ownedBy],
      },
      { schema: 'public' },
    );
    const table = entry(
      'table',
      'big_bytea',
      {
        oid: 30,
        schema: 'public',
        name: 'big_bytea',
        kind: 'ordinary',
        persistence: 'permanent',
        owner: 'owner',
        dependencies: [],
        rowLevelSecurity: false,
        forceRowLevelSecurity: false,
        parents: [],
        children: [],
        columns: [
          column(30, 'id', 1, {
            nullable: false,
            defaultExpression: "nextval('big_bytea_id_seq'::regclass)",
          }),
          column(30, 'test', 2, { formattedType: 'bytea' }),
        ],
      },
      { schema: 'public' },
    );

    const sql = renderer.renderCreate(context(table, [sequence, table])).join('\n');
    expect(sql).toContain(
      `DEFAULT pg_catalog.nextval('"public"."big_bytea_id_seq"'::pg_catalog.regclass)`,
    );
  });

  it('renders constraints, foreign keys, expression/partial/INCLUDE indexes', () => {
    const unique = entry(
      'constraint',
      'items_code_key',
      {
        oid: 30,
        schema: 'app',
        name: 'items_code_key',
        kind: 'unique',
        validated: true,
        table: tableReference(31, 'items'),
        columns: [{ kind: 'column', oid: 31, schema: 'app', name: 'items', subName: 'code' }],
        deferrable: true,
        initiallyDeferred: true,
        backingIndexOid: 32,
        nullsNotDistinct: true,
        dependencies: [],
      },
      { parent: tableReference(31, 'items'), section: 'post-data' },
    );
    expect(renderer.renderCreate(context(unique))[0]).toContain(
      'UNIQUE NULLS NOT DISTINCT (code) DEFERRABLE INITIALLY DEFERRED',
    );

    const foreignKey = entry(
      'foreign-key',
      'items_parent_fk',
      {
        oid: 33,
        schema: 'app',
        name: 'items_parent_fk',
        kind: 'foreign-key',
        validated: false,
        sourceTable: tableReference(31, 'items'),
        targetTable: tableReference(34, 'parents'),
        sourceColumns: [
          { kind: 'column', oid: 31, schema: 'app', name: 'items', subName: 'parent_id' },
        ],
        targetColumns: [{ kind: 'column', oid: 34, schema: 'app', name: 'parents', subName: 'id' }],
        match: 'full',
        onUpdate: 'cascade',
        onDelete: 'set-null',
        deferrable: false,
        initiallyDeferred: false,
        dependencies: [],
      },
      { parent: tableReference(31, 'items'), section: 'post-data' },
    );
    expect(renderer.renderCreate(context(foreignKey))[0]).toContain(
      'MATCH FULL ON UPDATE CASCADE ON DELETE SET NULL NOT VALID',
    );

    const defaultForeignKey = entry(
      'foreign-key',
      'items_category_fk',
      {
        oid: 36,
        schema: 'app',
        name: 'items_category_fk',
        kind: 'foreign-key',
        validated: true,
        sourceTable: tableReference(31, 'items'),
        targetTable: tableReference(37, 'categories'),
        sourceColumns: [
          { kind: 'column', oid: 31, schema: 'app', name: 'items', subName: 'category_id' },
        ],
        targetColumns: [
          { kind: 'column', oid: 37, schema: 'app', name: 'categories', subName: 'id' },
        ],
        match: 'simple',
        onUpdate: 'no-action',
        onDelete: 'no-action',
        deferrable: false,
        initiallyDeferred: false,
        dependencies: [],
      },
      { parent: tableReference(31, 'items'), section: 'post-data' },
    );
    const defaultForeignKeySql = renderer.renderCreate(context(defaultForeignKey))[0];
    expect(defaultForeignKeySql).not.toContain('MATCH');
    expect(defaultForeignKeySql).not.toContain('ON UPDATE');
    expect(defaultForeignKeySql).not.toContain('ON DELETE');

    const index = entry(
      'index',
      'items_lower_idx',
      {
        oid: 35,
        schema: 'app',
        name: 'items_lower_idx',
        table: tableReference(31, 'items'),
        accessMethod: 'btree',
        unique: false,
        primary: false,
        valid: true,
        ready: true,
        live: true,
        exportable: true,
        clustered: false,
        replicaIdentity: false,
        storageParameters: ['fillfactor=80'],
        predicate: '(active = true)',
        definition: 'CREATE INDEX items_lower_idx ON app.items (lower(code))',
        elements: [
          {
            position: 1,
            key: true,
            expression: 'lower(code)',
            collation: 'pg_catalog.default',
            collationIsDefault: true,
            operatorClass: 'pg_catalog.text_ops',
            operatorClassIsDefault: true,
            direction: 'ascending',
            nulls: 'last',
          },
          {
            position: 2,
            key: false,
            column: { kind: 'column', oid: 31, name: 'items', subName: 'created_at' },
          },
        ],
        dependencies: [],
      },
      { parent: tableReference(31, 'items'), section: 'post-data' },
    );
    const indexSql = renderer.renderCreate(context(index))[0];
    expect(indexSql).toContain('(lower(code))');
    expect(indexSql).not.toContain('COLLATE');
    expect(indexSql).not.toContain('text_ops');
    expect(indexSql).not.toContain(' ASC');
    expect(indexSql).not.toContain('NULLS LAST');
    expect(indexSql).toContain('INCLUDE (created_at)');
    expect(indexSql).toContain('WHERE (active = true)');
  });

  it('renders views, routines, triggers, rules, policies, and metadata', () => {
    const view = entry('view', 'active_items', {
      oid: 40,
      schema: 'app',
      name: 'active_items',
      definition: ' SELECT id FROM app.items WHERE active;',
      columns: [],
      persistence: 'permanent',
      securityBarrier: true,
      securityInvoker: true,
      checkOption: 'local',
      dependencies: [],
    });
    expect(renderer.renderCreate(context(view, [view], { createOrReplaceViews: true }))[0]).toBe(
      'CREATE OR REPLACE VIEW app.active_items WITH (security_barrier=true, security_invoker=true, check_option=local) AS\nSELECT id FROM app.items WHERE active;',
    );

    const matview = entry('materialized-view', 'summary', {
      oid: 41,
      schema: 'app',
      name: 'summary',
      definition: 'SELECT count(*) FROM app.items;',
      columns: [],
      persistence: 'permanent',
      accessMethod: 'heap',
      storageParameters: ['fillfactor=90'],
      populated: false,
      indexes: [],
      dependencies: [],
    });
    expect(renderer.renderCreate(context(matview))[0]).toContain('WITH NO DATA;');

    for (const [type, definition] of [
      ['function', 'CREATE FUNCTION app.f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$'],
      ['procedure', 'CREATE PROCEDURE app.p() LANGUAGE sql AS $$ SELECT 1 $$'],
    ] as const) {
      const routine = entry(type, type === 'function' ? 'f' : 'p', {
        oid: type === 'function' ? 42 : 43,
        schema: 'app',
        name: type === 'function' ? 'f' : 'p',
        definition,
        identityArguments: '',
        dependencies: [],
      });
      expect(renderer.renderCreate(context(routine))[0]).toBe(`${definition};`);
    }

    const trigger = entry(
      'trigger',
      'audit',
      {
        oid: 44,
        schema: 'app',
        name: 'audit',
        table: tableReference(31, 'items'),
        definition: 'CREATE TRIGGER audit AFTER INSERT ON app.items EXECUTE FUNCTION app.audit()',
        enabled: 'always',
        dependencies: [],
      },
      { parent: tableReference(31, 'items'), section: 'post-data' },
    );
    expect(renderer.renderCreate(context(trigger))).toHaveLength(2);

    const rule = entry(
      'rule',
      'protect',
      {
        oid: 45,
        schema: 'app',
        name: 'protect',
        relation: tableReference(31, 'items'),
        definition: 'CREATE RULE protect AS ON DELETE TO app.items DO INSTEAD NOTHING',
        enabled: 'disabled',
        dependencies: [],
      },
      { parent: tableReference(31, 'items'), section: 'post-data' },
    );
    expect(renderer.renderCreate(context(rule))[1]).toContain('DISABLE RULE protect');

    const policy = entry(
      'policy',
      'tenant',
      {
        oid: 46,
        schema: 'app',
        name: 'tenant',
        table: tableReference(31, 'items'),
        command: 'select',
        permissive: false,
        roles: ['PUBLIC', 'report reader'],
        usingExpression: "(tenant_id = current_setting('app.tenant')::integer)",
        dependencies: [],
      },
      { parent: tableReference(31, 'items'), section: 'post-data' },
    );
    expect(renderer.renderCreate(context(policy))[0]).toMatch(
      /AS RESTRICTIVE\s+FOR SELECT\s+TO PUBLIC, "report reader"/u,
    );

    const comment = entry(
      'comment',
      'audit',
      {
        object: { kind: 'trigger', oid: 44, schema: 'app', name: 'audit' },
        text: "owner's audit",
      },
      { section: 'post-data' },
    );
    expect(renderer.renderCreate(context(comment, [trigger, comment]))[0]).toBe(
      "COMMENT ON TRIGGER audit ON app.items IS 'owner''s audit';",
    );

    const ownership = entry('ownership', 'items', {
      object: tableReference(31, 'items'),
      owner: 'db owner',
    });
    expect(renderer.renderCreate(context(ownership))[0]).toBe(
      'ALTER TABLE app.items OWNER TO "db owner";',
    );

    const publicSchemaOwnership = entry('ownership', 'public', {
      object: { kind: 'schema', oid: 2200, name: 'public' },
      owner: 'pg_database_owner',
    });
    const oldTargetContext = context(publicSchemaOwnership, [publicSchemaOwnership], {
      targetVersion: pg9,
      unsupportedFeaturePolicy: 'warn-skip',
    });
    expect(renderer.renderCreate(oldTargetContext)).toEqual([]);
    expect(oldTargetContext.warnings.getAll()).toMatchObject([
      {
        code: 'compatibility-downgrade',
        feature: 'the predefined pg_database_owner role',
        transformation: 'ownership command omitted',
      },
    ]);
    expect(
      renderer.renderCreate(
        context(publicSchemaOwnership, [publicSchemaOwnership], {
          targetVersion: pg9,
          roleMappings: { pg_database_owner: 'postgres' },
        }),
      ),
    ).toEqual(['ALTER SCHEMA public OWNER TO postgres;']);

    const acl = entry('acl', 'items', {
      object: tableReference(31, 'items'),
      grantor: 'owner',
      grantee: 'PUBLIC',
      privilege: 'select',
      grantOption: false,
      rawAcl: [],
    });
    expect(renderer.renderCreate(context(acl))).toEqual([
      'REVOKE ALL ON TABLE app.items FROM PUBLIC;',
      'GRANT SELECT ON TABLE app.items TO PUBLIC;',
    ]);
  });

  it('renders clean drops and attaches compatibility warnings to entries', () => {
    const schema = entry('schema', 'app', {
      oid: 50,
      name: 'app',
      owner: 'owner',
      tables: [],
      sequences: [],
      enumTypes: [],
      domains: [],
    });
    expect(
      renderer.renderDrop(context(schema, [schema], { ifExists: true, cascade: true })),
    ).toEqual(['DROP SCHEMA IF EXISTS app CASCADE;']);

    const generatedTable = entry('table', 'generated_table', {
      oid: 51,
      schema: 'app',
      name: 'generated_table',
      kind: 'ordinary',
      persistence: 'permanent',
      owner: 'owner',
      dependencies: [],
      rowLevelSecurity: false,
      forceRowLevelSecurity: false,
      parents: [],
      children: [],
      columns: [
        column(51, 'value', 1, {
          generatedExpression: '1 + 1',
          compression: 'pglz',
        }),
      ],
    });
    const pg13 = versionService.parse(130000, 'PostgreSQL 13');
    expect(() =>
      renderer.renderCreate(
        context(generatedTable, [generatedTable], {
          targetVersion: pg13,
          unsupportedFeaturePolicy: 'warn-omit',
        }),
      ),
    ).not.toThrow();
    const warningContext = context(generatedTable, [generatedTable], {
      targetVersion: pg13,
      unsupportedFeaturePolicy: 'warn-omit',
    });
    renderer.renderCreate(warningContext);
    expect(warningContext.warnings.getAll()).toMatchObject([
      {
        code: 'compatibility-omission',
        dumpId: generatedTable.dumpId,
        feature: 'column compression',
      },
    ]);

    const pg11 = versionService.parse(110000, 'PostgreSQL 11');
    expect(() =>
      renderer.renderCreate(
        context(generatedTable, [generatedTable], {
          targetVersion: pg11,
          unsupportedFeaturePolicy: 'warn-omit',
        }),
      ),
    ).toThrow(/generated columns/u);
    expect(() =>
      renderer.renderCreate(
        context(generatedTable, [generatedTable], {
          targetVersion: pg11,
          unsupportedFeaturePolicy: 'error',
        }),
      ),
    ).toThrow(/column compression/u);

    const bestEffortContext = context(generatedTable, [generatedTable], {
      targetVersion: pg11,
      unsupportedFeaturePolicy: 'warn-skip',
    });
    const bestEffortSql = renderer.renderCreate(bestEffortContext);
    expect(bestEffortSql).not.toHaveLength(0);
    expect(bestEffortSql.join('\n')).not.toMatch(/\b(?:COMPRESSION|GENERATED)\b/u);
    expect(bestEffortContext.warnings.getAll()).toMatchObject([
      { code: 'compatibility-omission', feature: 'column compression' },
      { code: 'compatibility-omission', feature: 'generated columns' },
    ]);
  });
});

describe('plain archive orchestration', () => {
  it('is deterministic, section ordered, and snapshots a complete small schema', async () => {
    const database = entry('database', 'source_db', {
      oid: 1,
      name: 'source_db',
      owner: 'owner',
      encoding: 'UTF8',
      collation: 'C',
      characterType: 'C',
    });
    const schema = entry('schema', 'app', {
      oid: 2,
      name: 'app',
      owner: 'owner',
      tables: [],
      sequences: [],
      enumTypes: [],
      domains: [],
    });
    const enumEntry = entry('enum', 'mood', {
      oid: 3,
      schema: 'app',
      name: 'mood',
      labels: [
        { oid: 4, label: 'happy', sortOrder: 1 },
        { oid: 5, label: 'sad', sortOrder: 2 },
      ],
      dependencies: [],
    });
    const data = entry(
      'table-data',
      'items',
      {},
      { section: 'data', parent: tableReference(6, 'items') },
    );
    const items = [database, schema, enumEntry, data];
    const render = async (): Promise<{ sql: string; skipped: readonly string[] }> => {
      const writer = new StringDumpWriter();
      const result = await renderPlainSql({
        archive: archive(items),
        sourceVersion: pg18,
        sourceCapabilities,
        writer,
        options: { statementComments: true },
      });
      return { sql: writer.toString(), skipped: result.skippedDumpIds };
    };
    const first = await render();
    const second = await render();
    expect(second).toEqual(first);
    expect(first.skipped).toContain(data.dumpId);
    expect(first.sql).toMatchSnapshot();
  });

  it('returns cancellation state and does not require a complete in-memory dump', async () => {
    const controller = new AbortController();
    controller.abort();
    const writer = new StringDumpWriter();
    const result = await new PlainSqlArchiveRenderer().render({
      archive: archive([]),
      sourceVersion: pg18,
      sourceCapabilities,
      writer,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.bytesWritten).toBe(0);
  });

  it('skips hard dependants of target-incompatible objects in best-effort mode', async () => {
    const partitionedTable = entry('table', 'events', {
      oid: 20,
      schema: 'app',
      name: 'events',
      kind: 'partitioned',
    });
    const data = entry(
      'table-data',
      'events',
      {},
      {
        section: 'data',
        dependencyDumpIds: [partitionedTable.dumpId],
        dependencies: [
          {
            dumpId: partitionedTable.dumpId,
            strength: 'hard',
            source: 'data-owner',
          },
        ],
      },
    );
    let dataHookCalled = false;
    const result = await renderPlainSql({
      archive: archive([partitionedTable, data]),
      sourceVersion: pg18,
      sourceCapabilities,
      writer: new StringDumpWriter(),
      options: {
        targetVersion: pg9,
      },
      renderTableData: () => {
        dataHookCalled = true;
      },
    });

    expect(dataHookCalled).toBe(false);
    expect(result.skippedDumpIds).toEqual([partitionedTable.dumpId, data.dumpId]);
    expect(result.warnings).toMatchObject([
      {
        code: 'compatibility-omission',
        dumpId: partitionedTable.dumpId,
        feature: 'declarative partitioning',
      },
      {
        code: 'unsupported-object',
        dumpId: data.dumpId,
      },
    ]);
  });
});
