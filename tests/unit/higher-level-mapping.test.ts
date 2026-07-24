import { describe, expect, it } from 'vitest';

import { HigherLevelAssembler } from '../../src/introspection/HigherLevelAssembler.js';
import {
  createPoliciesQuery,
  createRoutinesQuery,
  createTriggersQuery,
  createViewsQuery,
} from '../../src/introspection/higherCatalogQueries.js';
import type {
  AggregateCatalogRow,
  RoutineCatalogRow,
  TriggerCatalogRow,
} from '../../src/introspection/higherCatalogTypes.js';
import type { PostgresDatabase } from '../../src/model/PostgresDatabase.js';
import { normalizeDumpSelection } from '../../src/selection/Selection.js';
import { PostgresVersionService } from '../../src/version/PostgresVersion.js';
import {
  detectSourceCapabilities,
  type SourceCapabilities,
} from '../../src/version/SourceCapabilities.js';

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
          name: 'items',
          kind: 'ordinary',
          persistence: 'permanent',
          owner: 'owner',
          dependencies: [],
          rowLevelSecurity: true,
          forceRowLevelSecurity: false,
          estimatedRowCount: 0,
          replicaIdentity: 'default',
          parents: [],
          children: [],
          columns: [
            {
              tableOid: 100,
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
        },
      ],
    },
  ],
};

const versionService = new PostgresVersionService();
const capabilities = detectSourceCapabilities(versionService.parse(180001, '18.1'));

function routine(overrides: Partial<RoutineCatalogRow> = {}): RoutineCatalogRow {
  return {
    oid: 200,
    schema_name: 'app',
    routine_name: 'calculate',
    owner_oid: 20,
    owner: 'owner',
    routine_kind: 'f',
    identity_arguments: 'integer',
    arguments: 'value integer',
    result: 'integer',
    language: 'sql',
    source: 'SELECT value + 1',
    definition: 'CREATE FUNCTION app.calculate(value integer) RETURNS integer ...',
    volatility: 'i',
    strict: true,
    security_definer: false,
    leakproof: false,
    parallel_safety: 's',
    estimated_cost: 1,
    estimated_rows: 0,
    configuration: null,
    argument_type_oids: [23],
    result_type_oid: 23,
    support_function_oid: 0,
    support_function_schema: null,
    support_function_name: null,
    support_function_identity_arguments: null,
    transform_type_oids: [],
    ...overrides,
  };
}

function aggregate(overrides: Partial<AggregateCatalogRow> = {}): AggregateCatalogRow {
  return {
    oid: 300,
    schema_name: 'app',
    aggregate_name: 'sum_text',
    owner_oid: 20,
    owner: 'owner',
    identity_arguments: 'text',
    arguments: 'text',
    aggregate_kind: 'n',
    parallel_safety: 's',
    transition_function_oid: 200,
    transition_function_name: 'app.calculate(integer)',
    state_type_oid: 25,
    state_type_name: 'text',
    final_function_oid: 0,
    final_function_name: null,
    combine_function_oid: 0,
    combine_function_name: null,
    serialization_function_oid: 0,
    serialization_function_name: null,
    deserialization_function_oid: 0,
    deserialization_function_name: null,
    moving_transition_function_oid: 0,
    moving_transition_function_name: null,
    moving_inverse_function_oid: 0,
    moving_inverse_function_name: null,
    moving_final_function_oid: 0,
    moving_final_function_name: null,
    moving_state_type_oid: 0,
    moving_state_type_name: null,
    initial_condition: '',
    moving_initial_condition: null,
    sort_operator: null,
    transition_space: 0,
    moving_transition_space: 0,
    direct_argument_count: 0,
    ...overrides,
  };
}

function trigger(overrides: Partial<TriggerCatalogRow> = {}): TriggerCatalogRow {
  return {
    oid: 400,
    trigger_name: 'items_before_update',
    table_oid: 100,
    table_schema: 'app',
    table_name: 'items',
    function_oid: 200,
    function_schema: 'app',
    function_name: 'calculate',
    function_identity_arguments: 'integer',
    definition: 'CREATE TRIGGER items_before_update BEFORE UPDATE ON app.items ...',
    enabled: 'D',
    trigger_type: 1 | 2 | 16,
    when_expression: '(old.id IS DISTINCT FROM new.id)',
    constraint_oid: 0,
    deferrable: false,
    initially_deferred: false,
    referenced_relation_oid: 0,
    referenced_relation_schema: null,
    referenced_relation_name: null,
    old_transition_table: null,
    new_transition_table: null,
    parent_trigger_oid: 0,
    internal: false,
    ...overrides,
  };
}

function assemble(
  overrides: Partial<Parameters<HigherLevelAssembler['assemble']>[1]> = {},
  sourceCapabilities: SourceCapabilities = capabilities,
) {
  return new HigherLevelAssembler().assemble(
    database,
    {
      roles: [
        { oid: 20, role_name: 'owner' },
        { oid: 21, role_name: 'reader' },
      ],
      views: [],
      viewColumns: [],
      materializedViewIndexes: [],
      routines: [],
      aggregates: [],
      triggers: [],
      rules: [],
      policies: [],
      comments: [],
      acls: [],
      defaultPrivileges: [],
      dependencies: [],
      ...overrides,
    },
    normalizeDumpSelection({ includeSchemas: ['app'] }),
    sourceCapabilities,
  );
}

describe('higher-level catalog assembly', () => {
  it('distinguishes overloaded functions by identity arguments and maps procedures', () => {
    const result = assemble({
      routines: [
        routine(),
        routine({ oid: 201, identity_arguments: 'text', arguments: 'value text' }),
        routine({
          oid: 202,
          routine_name: 'refresh_items',
          routine_kind: 'p',
          identity_arguments: '',
          arguments: '',
          result: null as unknown as string,
        }),
      ],
    });

    expect(result.database.functions.map((item) => item.identityArguments)).toEqual([
      'integer',
      'text',
    ]);
    expect(result.database.functions[0]).toMatchObject({
      volatility: 'immutable',
      parallelSafety: 'safe',
      strict: true,
    });
    expect(result.database.procedures).toHaveLength(1);
  });

  it('maps aggregate support metadata and dependencies', () => {
    const result = assemble({ routines: [routine()], aggregates: [aggregate()] });
    expect(result.database.aggregates[0]).toMatchObject({
      aggregateKind: 'normal',
      stateTypeName: 'text',
      initialCondition: '',
      transitionFunction: { oid: 200, subName: 'integer' },
    });
    expect(result.database.aggregates[0]?.dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ oid: 25, kind: 'type' })]),
    );
  });

  it('maps trigger state and bitmask while excluding internal triggers', () => {
    const result = assemble({
      routines: [routine()],
      triggers: [trigger(), trigger({ oid: 401, trigger_name: 'internal_fk', internal: true })],
    });
    expect(result.database.triggers[0]).toMatchObject({
      enabled: 'disabled',
      timing: 'before',
      events: ['update'],
      level: 'row',
      when: '(old.id IS DISTINCT FROM new.id)',
    });
    expect(result.database.triggers).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
  });

  it('excludes _RETURN rules and maps policies, comments, ACLs, and defaults', () => {
    const result = assemble({
      rules: [
        {
          oid: 500,
          rule_name: '_RETURN',
          relation_oid: 100,
          relation_schema: 'app',
          relation_name: 'items',
          definition: 'CREATE RULE "_RETURN" ...',
          enabled: 'O',
          event_type: '1',
          instead: true,
        },
      ],
      policies: [
        {
          oid: 600,
          policy_name: 'reader_policy',
          table_oid: 100,
          table_schema: 'app',
          table_name: 'items',
          command: 'r',
          permissive: false,
          roles: ['reader', 'PUBLIC'],
          using_expression: '(id > 0)',
          check_expression: null,
        },
      ],
      comments: [
        { catalog_kind: 'pg_class', object_oid: 100, object_sub_id: 0, description: '' },
        {
          catalog_kind: 'pg_class',
          object_oid: 100,
          object_sub_id: 1,
          description: 'identifier',
        },
      ],
      acls: [
        {
          object_kind: 'table',
          object_oid: 100,
          grantor: 'owner',
          grantee: 'PUBLIC',
          privilege_type: 'SELECT',
          grantable: false,
          raw_acl: ['=r/owner'],
        },
      ],
      defaultPrivileges: [
        {
          oid: 700,
          owner_oid: 20,
          owner: 'owner',
          schema_name: 'app',
          object_type: 'r',
          grantor: 'owner',
          grantee: 'reader',
          privilege_type: 'SELECT',
          grantable: true,
          raw_acl: ['reader=r*/owner'],
        },
      ],
    });

    expect(result.database.rules).toEqual([]);
    expect(result.database.policies[0]).toMatchObject({
      command: 'select',
      permissive: false,
      roles: ['reader', 'PUBLIC'],
    });
    expect(result.database.comments.map((comment) => comment.text)).toEqual(['', 'identifier']);
    expect(result.database.accessControls[0]).toMatchObject({
      grantee: 'PUBLIC',
      privilege: 'SELECT',
      grantOption: false,
    });
    expect(result.database.defaultPrivileges[0]).toMatchObject({
      objectType: 'table',
      grantOption: true,
    });
  });

  it('maps view options and materialized-view indexes', () => {
    const result = assemble({
      views: [
        {
          oid: 800,
          schema_name: 'app',
          view_name: 'visible_items',
          relation_kind: 'v',
          owner_oid: 20,
          owner: 'owner',
          definition: 'SELECT id FROM app.items;',
          persistence: 'p',
          tablespace: null,
          access_method: null,
          storage_parameters: [
            'security_barrier=true',
            'security_invoker=true',
            'check_option=local',
          ],
          populated: true,
        },
        {
          oid: 801,
          schema_name: 'app',
          view_name: 'cached_items',
          relation_kind: 'm',
          owner_oid: 20,
          owner: 'owner',
          definition: 'SELECT id FROM app.items;',
          persistence: 'p',
          tablespace: 'fast',
          access_method: 'heap',
          storage_parameters: ['fillfactor=80'],
          populated: false,
        },
      ],
      viewColumns: [
        {
          relation_oid: 800,
          attribute_number: 1,
          column_name: 'id',
          formatted_type: 'integer',
          type_oid: 23,
        },
      ],
      materializedViewIndexes: [
        {
          view_oid: 801,
          index_oid: 802,
          schema_name: 'app',
          index_name: 'cached_items_idx',
          definition: 'CREATE INDEX cached_items_idx ON app.cached_items (id)',
          valid: true,
          ready: true,
        },
      ],
    });

    expect(result.database.views[0]).toMatchObject({
      securityBarrier: true,
      securityInvoker: true,
      checkOption: 'local',
    });
    expect(result.database.materializedViews[0]).toMatchObject({
      populated: false,
      accessMethod: 'heap',
      indexes: [{ oid: 802, name: 'cached_items_idx' }],
    });
  });
});

describe('higher-level query version gates', () => {
  it('does not reference newer routine/view columns on PostgreSQL 9.6', () => {
    const oldCapabilities = detectSourceCapabilities(versionService.parse(90624, '9.6.24'));
    const routines = createRoutinesQuery(oldCapabilities).text;
    const views = createViewsQuery(oldCapabilities).text;
    expect(routines).not.toContain('p.prokind');
    expect(routines).not.toContain('p.prosupport');
    expect(views).not.toContain('c.relam');
    expect(createTriggersQuery(oldCapabilities, [1]).text).not.toContain('t.tgoldtable');
    expect(createPoliciesQuery(oldCapabilities, [1]).text).not.toContain('p.polpermissive');
  });

  it('enables modern routine and materialized-view metadata', () => {
    expect(createRoutinesQuery(capabilities).text).toContain('p.prokind');
    expect(createRoutinesQuery(capabilities).text).toContain('p.prosupport');
    expect(createViewsQuery(capabilities).text).toContain('c.relam');
    expect(createTriggersQuery(capabilities, [1]).text).toContain('t.tgoldtable');
    expect(createPoliciesQuery(capabilities, [1]).text).toContain('p.polpermissive');
  });
});
