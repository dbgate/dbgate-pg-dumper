import { describe, expect, it } from 'vitest';

import {
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  mapRestoreArchiveEntry,
  normalizeRestoreOptions,
  resolveRestoreSchema,
  resolveRestoreTablespace,
  RESTORE_ARCHIVE_FORMAT,
  RESTORE_ARCHIVE_FORMAT_VERSION,
  type PostgresVersion,
  type RestoreArchiveEntry,
  type RestoreArchiveMetadata,
  type RestoreTargetObject,
  type RestoreTargetSnapshot,
} from '../../src/index.js';
import { RestorePlanner } from '../../src/restore/RestorePlanner.js';
import { RestorePreflightAnalyzer } from '../../src/restore/RestorePreflight.js';

const version: PostgresVersion = {
  complete: 'PostgreSQL 18',
  number: 180000,
  normalizedMajor: '18',
  major: 18,
  minor: 0,
  patch: 0,
};

const metadata: RestoreArchiveMetadata = {
  format: RESTORE_ARCHIVE_FORMAT,
  formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
  archiveId: 'mapping-clean',
  sourceVersion: version,
  requiredExtensions: [],
  requiredRoles: [],
  requiredPrivileges: [],
  requiredTablespaces: [],
  transactionCompatibility: 'compatible',
  diagnostics: [],
};

function target(objects: readonly RestoreTargetObject[] = []): RestoreTargetSnapshot {
  return {
    version,
    serverCapabilities: {} as RestoreTargetSnapshot['serverCapabilities'],
    driverCapabilities: {
      parameterizedQueries: true,
      abortSignalCancellation: true,
      copyFromStdin: true,
      explicitCancellation: true,
      noticeReporting: false,
      identifierQuoting: 'library',
    },
    clientEncoding: 'UTF8',
    schemas: ['public', 'tenant'],
    extensions: ['plpgsql'],
    roles: ['runner'],
    setRoleTargets: ['runner'],
    tablespaces: ['pg_default', 'target_fast'],
    currentUser: {
      name: 'runner',
      superuser: true,
      createRole: true,
      createDatabase: true,
    },
    objects,
  };
}

function tableEntry(
  entryId: string,
  schema: string,
  name = 'items',
  dependencies: readonly string[] = [],
): RestoreArchiveEntry {
  return {
    entryId,
    archiveIdentity: `table:${schema}:${name}`,
    objectType: 'table',
    section: 'pre-data',
    objectIdentity: `${schema}.${name}`,
    dependencyEntryIds: dependencies,
    operation: {
      kind: 'sql',
      sql: `CREATE TABLE "${schema}"."${name}" (id integer)`,
      target: { kind: 'table', schema, name },
      structuredFragments: [
        { kind: 'sql', text: 'CREATE TABLE ' },
        { kind: 'identifier', parts: [schema, name], schemaPart: 0 },
        { kind: 'sql', text: ' (id integer)' },
      ],
      transactionRequirement: 'allowed',
      privilegeRequirements: [],
    },
    description: `Create ${schema}.${name}.`,
    diagnostics: [],
  };
}

describe('restore schema/tablespace mapping and clean planning', () => {
  it('maps structured SQL, COPY, finalization, and default-privilege schemas', () => {
    const options = normalizeRestoreOptions({
      schemaMappings: [
        { kind: 'schema', sourceSchema: 'app', action: 'map', targetSchema: 'tenant' },
      ],
    });
    const context = {
      options,
      availableSchemas: new Set(['tenant']),
      availableTablespaces: new Set(['pg_default']),
    };
    const sql = mapRestoreArchiveEntry(tableEntry('table', 'app'), context);
    expect(sql?.operation.kind === 'sql' ? sql.operation.sql : undefined).toBe(
      'CREATE TABLE "tenant"."items" (id integer)',
    );

    const data = mapRestoreArchiveEntry(
      {
        entryId: 'data',
        archiveIdentity: 'data:app:items',
        objectType: 'table-data',
        section: 'data',
        dependencyEntryIds: ['table'],
        operation: {
          kind: 'table-data',
          table: { schema: 'app', table: 'items' },
          columns: ['id'],
          format: 'copy-text',
          copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          dataSourceId: 'data',
          identityBehavior: 'preserve',
          partitionBehavior: 'target-table',
          transactionRequirement: 'allowed',
        },
        description: 'Data.',
        diagnostics: [],
      },
      context,
    );
    expect(data?.operation.kind === 'table-data' ? data.operation.table.schema : undefined).toBe(
      'tenant',
    );

    const defaults = mapRestoreArchiveEntry(
      {
        entryId: 'defaults',
        archiveIdentity: 'defaults:app',
        objectType: 'default-privilege',
        section: 'post-data',
        dependencyEntryIds: [],
        operation: {
          kind: 'default-privilege',
          owner: 'runner',
          schema: 'app',
          objectType: 'table',
          grantee: 'PUBLIC',
          privilege: 'SELECT',
          grantOption: false,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'Defaults.',
        diagnostics: [],
      },
      context,
    );
    expect(
      defaults?.operation.kind === 'default-privilege' ? defaults.operation.schema : undefined,
    ).toBe('tenant');
  });

  it('supports single-target-schema and rejects mapped identity collisions', () => {
    const entries = [tableEntry('a', 'one'), tableEntry('b', 'two')];
    const options = normalizeRestoreOptions({
      schemaMappingPolicy: 'single-target-schema',
      singleTargetSchema: 'tenant',
    });
    const report = new RestorePreflightAnalyzer().analyze(metadata, entries, target(), options);
    expect(report.canProceed).toBe(false);
    expect(report.diagnostics.some((item) => item.code === 'schema-mapping-collision')).toBe(true);
  });

  it('protects system schemas and reports opaque remapped references', () => {
    const unsafe = resolveRestoreSchema('pg_catalog', {
      options: normalizeRestoreOptions({
        schemaMappings: [
          {
            kind: 'schema',
            sourceSchema: 'pg_catalog',
            action: 'map',
            targetSchema: 'tenant',
          },
        ],
      }),
    });
    expect(unsafe.kind).toBe('unresolved');

    const entry = tableEntry('opaque', 'app');
    if (entry.operation.kind !== 'sql') throw new Error('Expected SQL operation.');
    const opaque: RestoreArchiveEntry = {
      ...entry,
      operation: {
        ...entry.operation,
        opaqueSchemaReferences: [{ schema: 'app', context: 'function-body' }],
      },
    };
    const report = new RestorePreflightAnalyzer().analyze(
      metadata,
      [opaque],
      target(),
      normalizeRestoreOptions({
        schemaMappings: [
          { kind: 'schema', sourceSchema: 'app', action: 'map', targetSchema: 'tenant' },
        ],
      }),
    );
    expect(report.diagnostics.some((item) => item.code === 'opaque-schema-reference')).toBe(true);
  });

  it('resolves tablespaces for preserve, map, omit, default, and missing-target policies', () => {
    const availableTablespaces = new Set(['pg_default', 'target_fast']);
    const mapped = resolveRestoreTablespace('source_fast', {
      options: normalizeRestoreOptions({
        tablespaceMappings: [
          {
            kind: 'tablespace',
            sourceTablespace: 'source_fast',
            action: 'map',
            targetTablespace: 'target_fast',
          },
        ],
      }),
      availableTablespaces,
    });
    expect(mapped).toMatchObject({ kind: 'mapped', targetTablespace: 'target_fast' });
    expect(
      resolveRestoreTablespace('source_fast', {
        options: normalizeRestoreOptions({ tablespaceMappingPolicy: 'omit' }),
        availableTablespaces,
      }).kind,
    ).toBe('omitted');
    expect(
      resolveRestoreTablespace('source_fast', {
        options: normalizeRestoreOptions({ tablespaceMappingPolicy: 'default-target' }),
        availableTablespaces,
      }).kind,
    ).toBe('default-target');
    expect(
      resolveRestoreTablespace('missing', {
        options: normalizeRestoreOptions(),
        availableTablespaces,
      }).kind,
    ).toBe('unresolved');

    const tablespaceEntry = tableEntry('tablespace-table', 'public');
    if (tablespaceEntry.operation.kind !== 'sql') throw new Error('Expected SQL operation.');
    const mappedEntry = mapRestoreArchiveEntry(
      {
        ...tablespaceEntry,
        operation: {
          ...tablespaceEntry.operation,
          sql: 'CREATE TABLE public.items (id integer) TABLESPACE source_fast',
          tablespace: 'source_fast',
          structuredFragments: [
            { kind: 'sql', text: 'CREATE TABLE ' },
            { kind: 'identifier', parts: ['public', 'items'], schemaPart: 0 },
            { kind: 'sql', text: ' (id integer)' },
            { kind: 'tablespace-clause', name: 'source_fast' },
          ],
        },
      },
      {
        options: normalizeRestoreOptions({
          tablespaceMappings: [
            {
              kind: 'tablespace',
              sourceTablespace: 'source_fast',
              action: 'map',
              targetTablespace: 'target_fast',
            },
          ],
        }),
        availableTablespaces,
      },
    );
    expect(mappedEntry?.operation.kind === 'sql' ? mappedEntry.operation.sql : undefined).toContain(
      'TABLESPACE "target_fast"',
    );
  });

  it('fails conflicts without modification and builds reverse dependency clean drops without CASCADE', () => {
    const table = tableEntry('table', 'public');
    const view: RestoreArchiveEntry = {
      ...tableEntry('view', 'public', 'items_view', ['table']),
      objectType: 'view',
      section: 'post-data',
      operation: {
        ...(() => {
          const operation = tableEntry('view-source', 'public', 'items_view').operation;
          if (operation.kind !== 'sql') throw new Error('Expected SQL operation.');
          return operation;
        })(),
        target: { kind: 'view', schema: 'public', name: 'items_view' },
      },
    };
    const existingTable: RestoreTargetObject = {
      catalogOid: 1,
      kind: 'table',
      schema: 'public',
      name: 'items',
    };
    const existingView: RestoreTargetObject = {
      catalogOid: 2,
      kind: 'view',
      schema: 'public',
      name: 'items_view',
    };
    const snapshot = {
      ...target([existingTable, existingView]),
      objectDependencies: [{ dependent: existingView, referenced: existingTable }],
    };
    const failed = new RestorePreflightAnalyzer().analyze(
      metadata,
      [table, view],
      snapshot,
      normalizeRestoreOptions(),
    );
    expect(failed.canProceed).toBe(false);

    const options = normalizeRestoreOptions({
      transactionMode: 'none',
      existingObjectPolicy: 'clean',
      cleanMode: 'clean',
    });
    const clean = new RestorePreflightAnalyzer().analyze(
      metadata,
      [table, view],
      snapshot,
      options,
    );
    expect(clean.canProceed).toBe(true);
    const plan = new RestorePlanner().createPlan(metadata, [table, view], clean, options);
    const drops = plan.steps.filter((step) => step.kind === 'drop-object');
    expect(drops.map((step) => (step.kind === 'drop-object' ? step.target.kind : ''))).toEqual([
      'view',
      'table',
    ]);
    expect(
      drops.every((step) => step.kind !== 'drop-object' || !step.sql.includes('CASCADE')),
    ).toBe(true);
  });

  it('blocks unsafe replacement, destructive schema clean, and plans table emptiness checks', () => {
    const table = tableEntry('table', 'public');
    const existing: RestoreTargetObject = {
      catalogOid: 1,
      kind: 'table',
      schema: 'public',
      name: 'items',
      columns: [
        {
          name: 'id',
          position: 1,
          formattedType: 'integer',
          notNull: false,
          generated: false,
          identity: '',
        },
      ],
    };
    const replacement = new RestorePreflightAnalyzer().analyze(
      metadata,
      [table],
      target([existing]),
      normalizeRestoreOptions({ existingObjectPolicy: 'replace-safe' }),
    );
    expect(replacement.diagnostics.some((item) => item.code === 'unsafe-replacement')).toBe(true);

    const schemaEntry: RestoreArchiveEntry = {
      ...tableEntry('schema', 'shared', 'shared'),
      objectType: 'schema',
      operation: {
        ...(() => {
          const operation = tableEntry('schema-source', 'shared', 'shared').operation;
          if (operation.kind !== 'sql') throw new Error('Expected SQL operation.');
          return operation;
        })(),
        target: { kind: 'schema', name: 'shared' },
      },
    };
    const schemaObject: RestoreTargetObject = { catalogOid: 10, kind: 'schema', name: 'shared' };
    const external: RestoreTargetObject = {
      catalogOid: 11,
      kind: 'table',
      schema: 'shared',
      name: 'external',
    };
    const schemaClean = new RestorePreflightAnalyzer().analyze(
      metadata,
      [schemaEntry],
      target([schemaObject, external]),
      normalizeRestoreOptions({ existingObjectPolicy: 'clean', cleanMode: 'clean' }),
    );
    expect(schemaClean.diagnostics.some((item) => item.code === 'external-dependent-object')).toBe(
      true,
    );

    const data: RestoreArchiveEntry = {
      entryId: 'data',
      archiveIdentity: 'data:public:items',
      objectType: 'table-data',
      section: 'data',
      dependencyEntryIds: ['table'],
      operation: {
        kind: 'table-data',
        table: { schema: 'public', table: 'items' },
        columns: ['id'],
        format: 'copy-text',
        copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
        dataSourceId: 'data',
        identityBehavior: 'preserve',
        partitionBehavior: 'target-table',
        transactionRequirement: 'allowed',
      },
      description: 'Data.',
      diagnostics: [],
    };
    const skipOptions = normalizeRestoreOptions({
      transactionMode: 'none',
      existingObjectPolicy: 'skip',
      existingTableDataPolicy: 'fail-if-not-empty',
    });
    const skip = new RestorePreflightAnalyzer().analyze(
      metadata,
      [table, data],
      target([existing]),
      skipOptions,
    );
    expect(skip.canProceed).toBe(true);
    const plan = new RestorePlanner().createPlan(metadata, [table, data], skip, skipOptions);
    expect(plan.steps.some((step) => step.kind === 'assert-table-empty')).toBe(true);
  });

  it('matches overloaded routines by exact identity and permits only shape-compatible view replacement', () => {
    const functionEntry: RestoreArchiveEntry = {
      ...tableEntry('function', 'public', 'calculate'),
      objectType: 'function',
      operation: {
        kind: 'sql',
        sql: 'CREATE FUNCTION "public"."calculate"(integer) RETURNS integer LANGUAGE sql AS $$ SELECT $1 $$',
        target: {
          kind: 'function',
          schema: 'public',
          name: 'calculate',
          identityArguments: 'integer',
        },
        createsTarget: true,
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
    };
    const routines: readonly RestoreTargetObject[] = [
      {
        catalogOid: 20,
        kind: 'function',
        schema: 'public',
        name: 'calculate',
        identityArguments: 'text',
        returnType: 'integer',
      },
      {
        catalogOid: 21,
        kind: 'function',
        schema: 'public',
        name: 'calculate',
        identityArguments: 'integer',
        returnType: 'integer',
      },
    ];
    const routineReport = new RestorePreflightAnalyzer().analyze(
      metadata,
      [functionEntry],
      target(routines),
      normalizeRestoreOptions(),
    );
    expect(routineReport.conflicts).toHaveLength(1);
    expect(routineReport.conflicts[0]?.existing.catalogOid).toBe(21);

    const viewEntry: RestoreArchiveEntry = {
      ...tableEntry('view', 'public', 'items_view'),
      objectType: 'view',
      operation: {
        kind: 'sql',
        sql: 'CREATE VIEW "public"."items_view" AS SELECT 1::integer AS id',
        target: { kind: 'view', schema: 'public', name: 'items_view' },
        createsTarget: true,
        replaceStrategy: 'create-or-replace',
        replacementSql: 'CREATE OR REPLACE VIEW "public"."items_view" AS SELECT 1::integer AS id',
        replacementTargetShape: {
          columns: [{ name: 'id', formattedType: 'integer' }],
        },
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
    };
    const existingView: RestoreTargetObject = {
      catalogOid: 22,
      kind: 'view',
      schema: 'public',
      name: 'items_view',
      columns: [
        {
          name: 'id',
          position: 1,
          formattedType: 'integer',
          notNull: false,
          generated: false,
          identity: '',
        },
      ],
    };
    const replaceOptions = normalizeRestoreOptions({
      transactionMode: 'none',
      existingObjectPolicy: 'replace-safe',
    });
    const compatible = new RestorePreflightAnalyzer().analyze(
      metadata,
      [viewEntry],
      target([existingView]),
      replaceOptions,
    );
    expect(compatible.canProceed).toBe(true);
    const replacementPlan = new RestorePlanner().createPlan(
      metadata,
      [viewEntry],
      compatible,
      replaceOptions,
    );
    expect(
      replacementPlan.steps.some(
        (step) =>
          step.kind === 'execute-sql' &&
          step.replacement === true &&
          step.operation.sql.startsWith('CREATE OR REPLACE VIEW'),
      ),
    ).toBe(true);

    const incompatibleView = {
      ...existingView,
      columns: [{ ...existingView.columns![0]!, formattedType: 'bigint' }],
    };
    const incompatible = new RestorePreflightAnalyzer().analyze(
      metadata,
      [viewEntry],
      target([incompatibleView]),
      replaceOptions,
    );
    expect(incompatible.diagnostics.some((item) => item.code === 'unsafe-replacement')).toBe(true);
  });

  it('blocks truncate through an external foreign key and resolves existing sequence-state policies', () => {
    const table = tableEntry('table', 'public');
    const existingTable: RestoreTargetObject = {
      catalogOid: 30,
      kind: 'table',
      schema: 'public',
      name: 'items',
      columns: [
        {
          name: 'id',
          position: 1,
          formattedType: 'integer',
          notNull: false,
          generated: false,
          identity: '',
        },
      ],
    };
    const externalTable: RestoreTargetObject = {
      catalogOid: 31,
      kind: 'table',
      schema: 'public',
      name: 'external_items',
    };
    const data: RestoreArchiveEntry = {
      entryId: 'data',
      archiveIdentity: 'data:public:items',
      objectType: 'table-data',
      section: 'data',
      dependencyEntryIds: ['table'],
      operation: {
        kind: 'table-data',
        table: { schema: 'public', table: 'items' },
        columns: ['id'],
        format: 'copy-text',
        copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
        dataSourceId: 'data',
        identityBehavior: 'preserve',
        partitionBehavior: 'target-table',
        transactionRequirement: 'allowed',
      },
      description: 'Data.',
      diagnostics: [],
    };
    const truncate = new RestorePreflightAnalyzer().analyze(
      metadata,
      [table, data],
      {
        ...target([existingTable, externalTable]),
        objectDependencies: [
          {
            dependent: externalTable,
            referenced: existingTable,
            dependencyType: 'foreign-key',
          },
        ],
      },
      normalizeRestoreOptions({
        existingObjectPolicy: 'skip',
        existingTableDataPolicy: 'truncate',
      }),
    );
    expect(truncate.diagnostics.some((item) => item.code === 'truncate-blocked')).toBe(true);

    const sequenceEntry: RestoreArchiveEntry = {
      entryId: 'sequence-state',
      archiveIdentity: 'sequence-state:public:items_id_seq',
      objectType: 'sequence-state',
      section: 'data',
      dependencyEntryIds: ['sequence'],
      operation: {
        kind: 'sequence-state',
        schema: 'public',
        sequence: 'items_id_seq',
        lastValue: '42',
        isCalled: true,
        transactionRequirement: 'allowed',
      },
      description: 'Sequence state.',
      diagnostics: [],
    };
    const existingSequence: RestoreTargetObject = {
      catalogOid: 32,
      kind: 'sequence',
      schema: 'public',
      name: 'items_id_seq',
    };
    const sequenceDefinition: RestoreArchiveEntry = {
      ...tableEntry('sequence', 'public', 'items_id_seq'),
      objectType: 'sequence',
      operation: {
        kind: 'sql',
        sql: 'CREATE SEQUENCE "public"."items_id_seq"',
        target: { kind: 'sequence', schema: 'public', name: 'items_id_seq' },
        createsTarget: true,
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
    };
    const sequenceError = new RestorePreflightAnalyzer().analyze(
      metadata,
      [sequenceDefinition, sequenceEntry],
      target([existingSequence]),
      normalizeRestoreOptions({
        existingObjectPolicy: 'skip',
        existingSequenceStatePolicy: 'error',
      }),
    );
    expect(sequenceError.diagnostics.some((item) => item.code === 'sequence-state-conflict')).toBe(
      true,
    );

    const preserveTargetOptions = normalizeRestoreOptions({
      transactionMode: 'none',
      existingObjectPolicy: 'skip',
      existingSequenceStatePolicy: 'preserve-target',
    });
    const preserveTarget = new RestorePreflightAnalyzer().analyze(
      metadata,
      [sequenceDefinition, sequenceEntry],
      target([existingSequence]),
      preserveTargetOptions,
    );
    expect(preserveTarget.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    const preservePlan = new RestorePlanner().createPlan(
      metadata,
      [sequenceDefinition, sequenceEntry],
      preserveTarget,
      preserveTargetOptions,
    );
    expect(
      preservePlan.steps.some(
        (step) =>
          step.kind === 'skip-entry' &&
          step.archiveEntryId === 'sequence-state' &&
          step.reason.includes('sequence state'),
      ),
    ).toBe(true);
  });
});
