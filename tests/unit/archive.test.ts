import { describe, expect, it } from 'vitest';

import { DumpArchiveDependencyGraph } from '../../src/archive/DependencyGraph.js';
import type {
  ArchiveDependency,
  ArchiveEntry,
  ArchiveObjectType,
  DumpSection,
} from '../../src/archive/ArchiveTypes.js';
import {
  assignDumpSection,
  createArchiveIdentity,
  createDumpId,
  inspectDumpArchive,
} from '../../src/index.js';
import type { PostgresDatabase, PostgresTable } from '../../src/model/PostgresDatabase.js';

function table(oid: number, name: string, overrides: Partial<PostgresTable> = {}): PostgresTable {
  return {
    oid,
    schema: 'app',
    name,
    kind: 'ordinary',
    persistence: 'permanent',
    owner: 'owner',
    dependencies: [],
    rowLevelSecurity: false,
    forceRowLevelSecurity: false,
    estimatedRowCount: 0,
    replicaIdentity: 'default',
    parents: [],
    children: [],
    columns: [
      {
        tableOid: oid,
        attributeNumber: 1,
        ordinalPosition: 1,
        name: 'id',
        formattedType: 'integer',
        typeOid: 23,
        typeModifier: -1,
        nullable: false,
        storage: 'plain',
      },
    ],
    ...overrides,
  };
}

function database(): PostgresDatabase {
  const parent = table(100, 'parent');
  const child = table(101, 'child', {
    kind: 'partition',
    parents: [{ oid: 100, schema: 'app', name: 'parent' }],
    dependencies: [{ kind: 'table', oid: 100, schema: 'app', name: 'parent' }],
  });
  return {
    oid: 1,
    name: 'fixture',
    owner: 'owner',
    encoding: 'UTF8',
    collation: 'C',
    characterType: 'C',
    schemas: [
      {
        oid: 10,
        name: 'app',
        owner: 'owner',
        tables: [child, parent, table(102, 'zeta'), table(103, 'alpha')],
        sequences: [
          {
            oid: 200,
            schema: 'app',
            name: 'parent_id_seq',
            owner: 'owner',
            dependencies: [
              { kind: 'column', oid: 100, schema: 'app', name: 'parent', subName: 'id' },
            ],
            dataType: 'bigint',
            startValue: '1',
            increment: '1',
            minimumValue: '1',
            maximumValue: '9223372036854775807',
            cacheSize: '1',
            cycle: false,
            currentValue: '8',
            isCalled: true,
            ownership: 'serial',
            ownedBy: {
              kind: 'column',
              oid: 100,
              schema: 'app',
              name: 'parent',
              subName: 'id',
            },
          },
        ],
        enumTypes: [
          {
            oid: 300,
            schema: 'app',
            name: 'mood',
            owner: 'owner',
            dependencies: [],
            labels: [{ oid: 301, label: 'ok', sortOrder: 1 }],
          },
        ],
        domains: [],
      },
    ],
    constraints: [
      {
        oid: 400,
        schema: 'app',
        name: 'child_parent_fk',
        kind: 'foreign-key',
        validated: true,
        sourceTable: { kind: 'table', oid: 101, schema: 'app', name: 'child' },
        targetTable: { kind: 'table', oid: 100, schema: 'app', name: 'parent' },
        sourceColumns: [{ kind: 'column', oid: 101, schema: 'app', name: 'child', subName: 'id' }],
        targetColumns: [{ kind: 'column', oid: 100, schema: 'app', name: 'parent', subName: 'id' }],
        match: 'simple',
        onUpdate: 'no-action',
        onDelete: 'no-action',
        deferrable: false,
        initiallyDeferred: false,
        dependencies: [
          { kind: 'table', oid: 101, schema: 'app', name: 'child' },
          { kind: 'table', oid: 100, schema: 'app', name: 'parent' },
        ],
      },
    ],
    indexes: [],
    views: [
      {
        oid: 500,
        schema: 'app',
        name: 'parent_view',
        owner: 'owner',
        definition: 'SELECT id FROM app.parent',
        columns: [{ attributeNumber: 1, name: 'id', formattedType: 'integer', typeOid: 23 }],
        persistence: 'permanent',
        securityBarrier: false,
        checkOption: 'none',
        dependencies: [
          { kind: 'table', oid: 100, schema: 'app', name: 'parent' },
          {
            kind: 'function',
            oid: 600,
            schema: 'app',
            name: 'normalize',
            subName: 'integer',
          },
        ],
      },
    ],
    materializedViews: [],
    functions: [
      {
        oid: 600,
        schema: 'app',
        name: 'normalize',
        owner: 'owner',
        identityArguments: 'integer',
        arguments: 'value integer',
        language: 'sql',
        source: 'SELECT value',
        definition: 'CREATE FUNCTION app.normalize(value integer) RETURNS integer ...',
        securityDefiner: false,
        configuration: [],
        argumentTypeOids: [23],
        resultTypeOid: 23,
        dependencies: [],
        routineKind: 'function',
        resultType: 'integer',
        volatility: 'immutable',
        strict: true,
        leakproof: false,
        parallelSafety: 'safe',
        estimatedCost: 1,
        estimatedRows: 0,
        transformTypeOids: [],
      },
    ],
    procedures: [],
    aggregates: [],
    triggers: [
      {
        oid: 700,
        schema: 'app',
        name: 'parent_trigger',
        table: { kind: 'table', oid: 100, schema: 'app', name: 'parent' },
        function: {
          kind: 'function',
          oid: 600,
          schema: 'app',
          name: 'normalize',
          subName: 'integer',
        },
        definition: 'CREATE TRIGGER parent_trigger ...',
        enabled: 'origin',
        timing: 'before',
        events: ['update'],
        level: 'row',
        constraint: false,
        deferrable: false,
        initiallyDeferred: false,
        dependencies: [],
      },
    ],
    rules: [],
    policies: [],
    comments: [
      {
        object: { kind: 'table', oid: 100, schema: 'app', name: 'parent' },
        text: 'parent table',
      },
    ],
    ownerships: [],
    accessControls: [
      {
        object: { kind: 'table', oid: 100, schema: 'app', name: 'parent' },
        grantor: 'owner',
        grantee: 'reader',
        privilege: 'SELECT',
        grantOption: false,
        rawAcl: ['reader=r/owner'],
      },
    ],
    defaultPrivileges: [],
  };
}

function entry(
  dumpId: string,
  objectType: ArchiveObjectType,
  section: DumpSection,
  dependencies: readonly ArchiveDependency[] = [],
): ArchiveEntry {
  return {
    dumpId,
    archiveIdentity: dumpId,
    objectType,
    name: dumpId,
    specificIdentity: '',
    section,
    dependencyDumpIds: dependencies.map((dependency) => dependency.dumpId),
    dependencies,
    selection: { selected: true, reason: 'explicit', requiredByDumpIds: [] },
    sourceObject: {},
    diagnostics: [],
  };
}

describe('dump archive identities and construction', () => {
  it('generates deterministic identities and dump IDs', () => {
    const input = {
      objectType: 'function' as const,
      schema: 'app',
      name: 'calculate',
      specificIdentity: 'integer, text',
    };
    expect(createArchiveIdentity(input)).toBe(createArchiveIdentity({ ...input }));
    expect(createDumpId(createArchiveIdentity(input))).toMatch(/^d_[a-f0-9]{24}$/u);
  });

  it('does not depend on source array order', () => {
    const first = database();
    const second: PostgresDatabase = {
      ...first,
      schemas: first.schemas.map((schema) => ({
        ...schema,
        tables: [...schema.tables].reverse(),
      })),
      functions: [...first.functions].reverse(),
    };
    expect(inspectDumpArchive(first).orderedDumpIds).toEqual(
      inspectDumpArchive(second).orderedDumpIds,
    );
  });

  it('reports duplicate canonical identities', () => {
    const model = database();
    const result = inspectDumpArchive({
      ...model,
      views: [model.views[0]!, { ...model.views[0]!, oid: 501 }],
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'duplicate-archive-identity', severity: 'error' }),
    );
  });

  it('assigns centralized PostgreSQL-aware sections', () => {
    expect(assignDumpSection('table')).toBe('pre-data');
    expect(assignDumpSection('table-data')).toBe('data');
    expect(assignDumpSection('foreign-key')).toBe('post-data');
    expect(assignDumpSection('comment')).toBe('post-data');
  });

  it('builds schema, sequence, partition, foreign-key, view, and trigger dependencies', () => {
    const result = inspectDumpArchive(database());
    expect(result.valid).toBe(true);
    const find = (type: ArchiveObjectType, name: string) =>
      result.entries.find((item) => item.objectType === type && item.name === name)!;
    const schema = find('schema', 'app');
    const parent = find('table', 'parent');
    const child = find('table', 'child');
    const sequence = find('sequence', 'parent_id_seq');
    const sequenceOwnership = find('sequence-ownership', 'parent_id_seq');
    const parentColumn = result.entries.find(
      (item) => item.objectType === 'column' && item.parent?.oid === 100,
    )!;
    const foreignKey = find('foreign-key', 'child_parent_fk');
    const view = find('view', 'parent_view');
    const trigger = find('trigger', 'parent_trigger');
    const routine = find('function', 'normalize');
    expect(parent.dependencyDumpIds).toContain(schema.dumpId);
    expect(child.dependencyDumpIds).toContain(parent.dumpId);
    expect(parentColumn.dependencyDumpIds).toContain(sequence.dumpId);
    expect(sequenceOwnership.dependencyDumpIds).toEqual(
      expect.arrayContaining([sequence.dumpId, parentColumn.dumpId]),
    );
    expect(foreignKey.dependencyDumpIds).toEqual(
      expect.arrayContaining([parent.dumpId, child.dumpId]),
    );
    expect(view.dependencyDumpIds).toEqual(expect.arrayContaining([parent.dumpId, routine.dumpId]));
    expect(trigger.dependencyDumpIds).toEqual(
      expect.arrayContaining([parent.dumpId, routine.dumpId]),
    );
  });

  it('makes comments and ACLs depend on their target', () => {
    const result = inspectDumpArchive(database());
    const parent = result.entries.find(
      (item) => item.objectType === 'table' && item.name === 'parent',
    )!;
    for (const type of ['comment', 'acl'] as const) {
      expect(result.entries.find((item) => item.objectType === type)?.dependencyDumpIds).toContain(
        parent.dumpId,
      );
    }
  });

  it('embeds complete format-neutral table export metadata', () => {
    const result = inspectDumpArchive(database());
    const data = result.entries.find(
      (item) => item.objectType === 'table-data' && item.name === 'parent',
    );
    expect(data?.dataExport).toMatchObject({
      kind: 'table',
      relationOid: 100,
      schema: 'app',
      name: 'parent',
      estimatedRowCount: 0,
      persistence: 'permanent',
      replicaIdentity: { mode: 'default', columns: [] },
      partition: { kind: 'ordinary' },
      columns: [
        {
          ordinalPosition: 1,
          name: 'id',
          quotedName: 'id',
          typeOid: 23,
          formatter: 'integer',
          dropped: false,
        },
      ],
      exportMode: 'rows',
      streamingStrategy: 'auto',
      valueReadStrategy: 'canonical-text',
      rowLevelSecurity: false,
      forceRowLevelSecurity: false,
      defaultDataPolicy: 'include',
    });
  });

  it('sorts ties by type, schema, name, identity, and dump ID', () => {
    const result = inspectDumpArchive(database());
    const tableNames = result.orderedEntries
      .filter((item) => item.objectType === 'table')
      .map((item) => item.name);
    expect(tableNames.indexOf('alpha')).toBeLessThan(tableNames.indexOf('zeta'));
    expect(tableNames.indexOf('parent')).toBeLessThan(tableNames.indexOf('child'));
  });
});

describe('dependency graph validation and cycles', () => {
  it('reports invalid cross-section dependencies', () => {
    const data = entry('data', 'table-data', 'data');
    const schema = entry('schema', 'table', 'pre-data', [
      { dumpId: data.dumpId, strength: 'hard', source: 'catalog' },
    ]);
    const result = new DumpArchiveDependencyGraph().order([schema, data]);
    expect(result.orderedEntries).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-section-dependency' }),
    );
  });

  it('reports detailed hard cycles without removing edges', () => {
    const left = entry('left', 'view', 'pre-data', [
      { dumpId: 'right', strength: 'hard', source: 'catalog' },
    ]);
    const right = entry('right', 'function', 'pre-data', [
      { dumpId: 'left', strength: 'hard', source: 'catalog' },
    ]);
    const result = new DumpArchiveDependencyGraph().order([left, right]);
    const cycle = result.diagnostics.find((item) => item.code === 'dependency-cycle');
    expect(result.orderedEntries).toEqual([]);
    expect(cycle?.cycleMembers?.map((member) => member.dumpId).sort()).toEqual(['left', 'right']);
    expect(cycle?.cycleEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromDumpId: 'left', toDumpId: 'right', strength: 'hard' }),
      ]),
    );
  });

  it('drops only ordering preferences to resolve a cycle', () => {
    const left = entry('left', 'ownership', 'post-data', [
      { dumpId: 'right', strength: 'preference', source: 'restore-safety' },
    ]);
    const right = entry('right', 'acl', 'post-data', [
      { dumpId: 'left', strength: 'hard', source: 'metadata-target' },
    ]);
    const result = new DumpArchiveDependencyGraph().order([left, right]);
    expect(result.orderedEntries.map((item) => item.dumpId)).toEqual(['left', 'right']);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'dropped-ordering-preference' }),
    );
  });

  it('handles mutually referencing foreign keys without a hard cycle', () => {
    const model = database();
    const reverse = {
      ...(model.constraints[0] as Extract<
        PostgresDatabase['constraints'][number],
        { kind: 'foreign-key' }
      >),
      oid: 401,
      name: 'parent_child_fk',
      sourceTable: { kind: 'table' as const, oid: 100, schema: 'app', name: 'parent' },
      targetTable: { kind: 'table' as const, oid: 101, schema: 'app', name: 'child' },
    };
    const result = inspectDumpArchive({ ...model, constraints: [...model.constraints, reverse] });
    expect(result.valid).toBe(true);
    expect(result.orderedEntries.filter((item) => item.objectType === 'foreign-key')).toHaveLength(
      2,
    );
  });
});

describe('archive selection and extensions', () => {
  it('keeps schema-less objects when schemas are included explicitly', () => {
    const result = inspectDumpArchive(
      {
        ...database(),
        largeObjects: [{ oid: 42420, owner: 'owner', acl: [], estimatedBytes: 256 }],
      },
      { selection: { includeSchemas: ['app'] } },
    );
    const largeObjects = result.entries.filter((item) =>
      item.objectType.startsWith('large-object'),
    );
    expect(largeObjects).toHaveLength(3);
    expect(largeObjects.every((item) => item.selection.selected)).toBe(true);
  });

  it('automatically includes filtered hard dependencies', () => {
    const result = inspectDumpArchive(database(), {
      selection: { includeTables: ['app.child'] },
    });
    const parent = result.entries.find(
      (item) => item.objectType === 'table' && item.name === 'parent',
    );
    expect(parent?.selection).toMatchObject({ selected: true, reason: 'dependency' });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'automatically-included-dependency' }),
    );
  });

  it('reports strict-selection dependency failures', () => {
    const result = inspectDumpArchive(database(), {
      selection: { includeTables: ['app.child'], strictSelection: true },
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'strict-selection-dependency', severity: 'error' }),
    );
  });

  it('supports table-child inclusion and exclusion', () => {
    const included = inspectDumpArchive(database(), {
      selection: { includeTables: ['app.parent'], includeTableChildren: true },
    });
    expect(
      included.entries.find((item) => item.objectType === 'table' && item.name === 'child')
        ?.selection.selected,
    ).toBe(true);
    const excluded = inspectDumpArchive(database(), {
      selection: { excludeTables: ['app.parent'], excludeTableChildren: true },
    });
    expect(
      excluded.entries.find((item) => item.objectType === 'table' && item.name === 'child')
        ?.selection.selected,
    ).toBe(false);
  });

  it('reports data-only selections without definitions', () => {
    const result = inspectDumpArchive(database(), { selection: { mode: 'data-only' } });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'selected-data-without-definition' }),
    );
    expect(result.orderedEntries.every((item) => item.section === 'data')).toBe(true);
  });

  it('excludes extension members when their extension represents them', () => {
    const result = inspectDumpArchive(database(), {
      extensions: [{ oid: 900, name: 'fixture_extension', schema: 'app', owner: 'owner' }],
      extensionMembers: [
        {
          extensionName: 'fixture_extension',
          object: {
            kind: 'function',
            oid: 600,
            schema: 'app',
            name: 'normalize',
            subName: 'integer',
          },
        },
      ],
    });
    const routine = result.entries.find(
      (item) => item.objectType === 'function' && item.name === 'normalize',
    );
    expect(routine?.selection).toMatchObject({
      selected: false,
      reason: 'extension-member-excluded',
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'excluded-extension-member' }),
    );
  });

  it('ignores extension members outside the introspected database model', () => {
    const result = inspectDumpArchive(database(), {
      extensions: [{ oid: 900, name: 'plpgsql', schema: 'pg_catalog', owner: 'owner' }],
      extensionMembers: [
        {
          extensionName: 'plpgsql',
          object: {
            kind: 'function',
            oid: 999_999,
            schema: 'pg_catalog',
            name: 'plpgsql_call_handler',
          },
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === 'error' &&
          diagnostic.identity?.includes('plpgsql:function:999999') === true,
      ),
    ).toBe(false);
  });
});
