import { describe, expect, it } from 'vitest';

import { StructuralAssembler } from '../../src/introspection/StructuralAssembler.js';
import type {
  ConstraintCatalogRow,
  IndexCatalogRow,
  SequenceCatalogRow,
  TypeCatalogRow,
} from '../../src/introspection/structuralCatalogTypes.js';
import type { PostgresDatabase } from '../../src/model/PostgresDatabase.js';
import { normalizeDumpSelection } from '../../src/selection/Selection.js';

const database: PostgresDatabase = {
  oid: 1,
  name: 'fixture',
  owner: 'owner',
  encoding: 'UTF8',
  collation: 'C',
  characterType: 'C',
  constraints: [],
  indexes: [],
  views: [],
  materializedViews: [],
  functions: [],
  procedures: [],
  aggregates: [],
  triggers: [],
  rules: [],
  policies: [],
  comments: [],
  ownerships: [],
  accessControls: [],
  defaultPrivileges: [],
  schemas: [
    {
      oid: 10,
      name: 'app',
      owner: 'owner',
      sequences: [],
      enumTypes: [],
      domains: [],
      tables: [
        {
          oid: 100,
          schema: 'app',
          name: 'parent',
          kind: 'ordinary',
          persistence: 'permanent',
          owner: 'owner',
          dependencies: [],
          rowLevelSecurity: false,
          forceRowLevelSecurity: false,
          parents: [],
          children: [],
          columns: [
            {
              tableOid: 100,
              attributeNumber: 1,
              ordinalPosition: 1,
              name: 'left_id',
              formattedType: 'integer',
              typeOid: 23,
              typeModifier: -1,
              nullable: false,
              storage: 'plain',
            },
            {
              tableOid: 100,
              attributeNumber: 2,
              ordinalPosition: 2,
              name: 'right_id',
              formattedType: 'integer',
              typeOid: 23,
              typeModifier: -1,
              nullable: false,
              storage: 'plain',
            },
          ],
        },
        {
          oid: 200,
          schema: 'app',
          name: 'child',
          kind: 'partition',
          persistence: 'permanent',
          owner: 'owner',
          dependencies: [{ kind: 'table', oid: 100, schema: 'app', name: 'parent' }],
          rowLevelSecurity: false,
          forceRowLevelSecurity: false,
          partitionBound: 'DEFAULT',
          parents: [{ oid: 100, schema: 'app', name: 'parent' }],
          children: [],
          columns: [
            {
              tableOid: 200,
              attributeNumber: 1,
              ordinalPosition: 1,
              name: 'parent_left',
              formattedType: 'integer',
              typeOid: 23,
              typeModifier: -1,
              nullable: false,
              storage: 'plain',
            },
            {
              tableOid: 200,
              attributeNumber: 2,
              ordinalPosition: 2,
              name: 'parent_right',
              formattedType: 'integer',
              typeOid: 23,
              typeModifier: -1,
              nullable: false,
              storage: 'plain',
            },
          ],
        },
      ],
    },
  ],
};

const domainRow: TypeCatalogRow = {
  oid: 301,
  schema_name: 'app',
  type_name: 'positive_integer',
  type_kind: 'd',
  owner: 'owner',
  base_type_oid: 23,
  formatted_base_type: 'integer',
  not_null: true,
  default_expression: '1',
  collation_schema: null,
  collation_name: null,
};

function constraint(overrides: Partial<ConstraintCatalogRow>): ConstraintCatalogRow {
  return {
    oid: 400,
    constraint_name: 'constraint_name',
    schema_name: 'app',
    constraint_type: 'p',
    table_oid: 100,
    domain_oid: 0,
    referenced_table_oid: 0,
    column_numbers: [1, 2],
    referenced_column_numbers: null,
    deferrable: false,
    initially_deferred: false,
    validated: true,
    backing_index_oid: 500,
    parent_constraint_oid: 0,
    match_type: 's',
    update_action: 'a',
    delete_action: 'a',
    locally_defined: true,
    inheritance_count: 0,
    no_inherit: false,
    expression: null,
    definition: 'PRIMARY KEY (left_id, right_id)',
    nulls_not_distinct: false,
    ...overrides,
  };
}

function index(overrides: Partial<IndexCatalogRow> = {}): IndexCatalogRow {
  return {
    oid: 500,
    schema_name: 'app',
    index_name: 'child_expression_idx',
    owner: 'owner',
    table_oid: 200,
    access_method: 'btree',
    unique_index: false,
    primary_index: false,
    exclusion_index: false,
    immediate: true,
    nulls_not_distinct: false,
    valid: true,
    ready: true,
    live: true,
    clustered: false,
    replica_identity: false,
    tablespace: null,
    storage_parameters: null,
    predicate: '(parent_left > 0)',
    expressions: '(lower((parent_right)::text))',
    definition:
      'CREATE INDEX child_expression_idx ON app.child USING btree (lower((parent_right)::text)) INCLUDE (parent_left) WHERE (parent_left > 0)',
    total_attributes: 2,
    key_attributes: 1,
    attribute_numbers: [0, 1],
    element_definitions: ['lower((parent_right)::text)', 'parent_left'],
    operator_classes: ['pg_catalog.text_ops'],
    collations: ['pg_catalog.default'],
    options: [0],
    parent_index_oid: 0,
    ...overrides,
  };
}

function sequence(overrides: Partial<SequenceCatalogRow> = {}): SequenceCatalogRow {
  return {
    oid: 600,
    schema_name: 'app',
    sequence_name: 'parent_left_id_seq',
    owner: 'owner',
    data_type: 'bigint',
    start_value: '1',
    increment: '1',
    minimum_value: '1',
    maximum_value: '9223372036854775807',
    cache_size: '1',
    cycle: false,
    current_value: '4',
    is_called: true,
    dependency_type: 'a',
    owned_table_oid: 100,
    owned_table_schema: 'app',
    owned_table_name: 'parent',
    owned_attribute_number: 1,
    owned_column_name: 'left_id',
    ...overrides,
  };
}

function assemble(overrides: Partial<Parameters<StructuralAssembler['assemble']>[1]> = {}) {
  return new StructuralAssembler().assemble(
    database,
    {
      types: [],
      enumLabels: [],
      sequences: [],
      constraints: [],
      indexes: [],
      partitions: [],
      ...overrides,
    },
    normalizeDumpSelection({ includeSchemas: ['app'] }),
  );
}

describe('structural catalog assembly', () => {
  it('preserves enum label order and maps domains', () => {
    const result = assemble({
      types: [
        {
          ...domainRow,
          oid: 300,
          type_name: 'mood',
          type_kind: 'e',
          base_type_oid: 0,
          formatted_base_type: null,
          not_null: false,
          default_expression: null,
        },
        domainRow,
      ],
      enumLabels: [
        { type_oid: 300, label_oid: 2, label: 'sad', sort_order: 2 },
        { type_oid: 300, label_oid: 1, label: 'happy', sort_order: 1 },
      ],
    });

    expect(result.database.schemas[0]?.enumTypes[0]?.labels.map((label) => label.label)).toEqual([
      'happy',
      'sad',
    ]);
    expect(result.database.schemas[0]?.domains[0]).toMatchObject({
      name: 'positive_integer',
      formattedBaseType: 'integer',
      nullable: false,
      defaultExpression: '1',
    });
  });

  it('maps sequence ownership and dependency references', () => {
    const result = assemble({ sequences: [sequence()] });
    expect(result.database.schemas[0]?.sequences[0]).toMatchObject({
      ownership: 'serial',
      currentValue: '4',
      isCalled: true,
      ownedBy: { name: 'parent', subName: 'left_id' },
    });
  });

  it('preserves ordered composite keys and maps foreign-key actions', () => {
    const result = assemble({
      constraints: [
        constraint({}),
        constraint({
          oid: 401,
          constraint_name: 'child_parent_fk',
          constraint_type: 'f',
          table_oid: 200,
          referenced_table_oid: 100,
          column_numbers: [2, 1],
          referenced_column_numbers: [1, 2],
          match_type: 'f',
          update_action: 'c',
          delete_action: 'n',
          deferrable: true,
          initially_deferred: true,
          backing_index_oid: 0,
          definition:
            'FOREIGN KEY (parent_right, parent_left) REFERENCES app.parent(left_id, right_id)',
        }),
      ],
    });
    expect(
      result.database.constraints[0]?.kind === 'primary-key'
        ? result.database.constraints[0].columns.map((column) => column.subName)
        : [],
    ).toEqual(['left_id', 'right_id']);
    expect(result.database.constraints[1]).toMatchObject({
      kind: 'foreign-key',
      match: 'full',
      onUpdate: 'cascade',
      onDelete: 'set-null',
      deferrable: true,
    });
  });

  it('maps expression, partial, and INCLUDE index elements', () => {
    const result = assemble({ indexes: [index()] });
    expect(result.database.indexes[0]).toMatchObject({
      predicate: '(parent_left > 0)',
      expressions: '(lower((parent_right)::text))',
      elements: [
        { key: true, expression: 'lower((parent_right)::text)' },
        { key: false, column: { subName: 'parent_left' } },
      ],
    });
  });

  it('maps partition definitions and default bounds', () => {
    const result = assemble({
      partitions: [
        {
          table_oid: 100,
          strategy: 'r',
          key_definition: 'RANGE (left_id)',
          key_attribute_numbers: [1],
          default_partition_oid: 200,
        },
      ],
    });
    expect(result.database.schemas[0]?.tables[0]?.partition).toMatchObject({
      strategy: 'range',
      defaultPartitionOid: 200,
    });
    expect(result.database.schemas[0]?.tables[1]?.bound).toEqual({
      expression: 'DEFAULT',
      default: true,
    });
  });

  it('reports unresolved references instead of silently discarding them', () => {
    const result = assemble({
      sequences: [sequence({ owned_table_oid: 999 })],
      indexes: [index({ table_oid: 999 })],
      constraints: [constraint({ table_oid: 999 })],
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['orphaned-sequence', 'missing-reference']),
    );
  });

  it('keeps invalid indexes detectable but marks them non-exportable', () => {
    const result = assemble({
      indexes: [index({ valid: false, ready: false })],
    });
    expect(result.database.indexes[0]?.exportable).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-index', objectOid: 500 }),
    );
  });

  it('diagnoses malformed foreign-key column arrays', () => {
    const result = assemble({
      constraints: [
        constraint({
          constraint_type: 'f',
          table_oid: 200,
          referenced_table_oid: 100,
          column_numbers: [1, 2],
          referenced_column_numbers: [1],
        }),
      ],
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'malformed-constraint-columns' }),
    );
  });

  it('diagnoses unvalidated constraints while retaining them', () => {
    const result = assemble({
      constraints: [constraint({ validated: false })],
    });
    expect(result.database.constraints[0]?.validated).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unvalidated-constraint' }),
    );
  });
});
