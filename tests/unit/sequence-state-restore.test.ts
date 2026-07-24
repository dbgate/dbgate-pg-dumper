import { describe, expect, it } from 'vitest';

import {
  buildSequenceSetvalQuery,
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  normalizeRestoreOptions,
  RESTORE_ARCHIVE_FORMAT,
  RESTORE_ARCHIVE_FORMAT_VERSION,
  RestorePlanningError,
  sequenceIdentity,
  validateRestorePlan,
  validateSequenceState,
  type PostgresVersion,
  type RestoreArchiveEntry,
  type RestoreArchiveMetadata,
  type RestorePlanStep,
  type RestoreSequenceStateOperation,
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
  archiveId: 'sequence-ordering',
  sourceVersion: version,
  requiredExtensions: [],
  requiredRoles: [],
  requiredPrivileges: [],
  requiredTablespaces: [],
  transactionCompatibility: 'compatible',
  diagnostics: [],
};

const target: RestoreTargetSnapshot = {
  version,
  serverCapabilities: {
    identityColumns: true,
    declarativePartitioning: true,
    procedures: true,
    includeIndexes: true,
    generatedColumns: true,
    columnCompression: true,
    nullsNotDistinct: true,
    tableAccessMethods: true,
    idleInTransactionSessionTimeout: true,
    securityInvokerViews: true,
    restrictivePolicies: true,
  },
  driverCapabilities: {
    parameterizedQueries: true,
    abortSignalCancellation: true,
    copyFromStdin: true,
    explicitCancellation: true,
    noticeReporting: false,
    identifierQuoting: 'library',
  },
  clientEncoding: 'UTF8',
  schemas: ['public'],
  extensions: ['plpgsql'],
  roles: ['restore_user'],
  tablespaces: ['pg_default'],
  currentUser: {
    name: 'restore_user',
    superuser: true,
    createRole: true,
    createDatabase: true,
  },
};

function sequenceState(
  overrides: Partial<RestoreSequenceStateOperation> = {},
): RestoreSequenceStateOperation {
  return {
    kind: 'sequence-state',
    schema: 'Odd "schema',
    sequence: 'Order',
    lastValue: '9007199254740993',
    isCalled: true,
    dataType: 'bigint',
    ownership: 'standalone',
    increment: '10',
    transactionRequirement: 'allowed',
    ...overrides,
  };
}

function sqlEntry(
  entryId: string,
  objectType: RestoreArchiveEntry['objectType'],
  section: RestoreArchiveEntry['section'],
  dependencies: readonly string[] = [],
): RestoreArchiveEntry {
  return {
    entryId,
    archiveIdentity: `${objectType}:${entryId}`,
    objectType,
    section,
    objectIdentity: `public.${entryId}`,
    dependencyEntryIds: dependencies,
    operation: {
      kind: 'sql',
      sql: `SELECT '${entryId}'`,
      transactionRequirement: 'allowed',
      privilegeRequirements: [],
    },
    description: `Restore ${entryId}.`,
    diagnostics: [],
  };
}

describe('sequence-state restore', () => {
  it('builds lossless parameterized three-argument setval SQL', () => {
    const operation = sequenceState();
    expect(sequenceIdentity(operation)).toBe(`"Odd ""schema"."Order"`);
    expect(buildSequenceSetvalQuery(operation)).toEqual({
      text: `SELECT pg_catalog.setval($1::pg_catalog.regclass, $2::pg_catalog.int8, $3::pg_catalog.bool)`,
      values: [`"Odd ""schema"."Order"`, '9007199254740993', true],
    });
    expect(typeof buildSequenceSetvalQuery(operation).values?.[1]).toBe('string');
  });

  it('preserves is_called and accepts descending and full-range bigint states', () => {
    expect(
      buildSequenceSetvalQuery(
        sequenceState({
          lastValue: '-9223372036854775808',
          isCalled: false,
          increment: '-10',
        }),
      ).values,
    ).toEqual([`"Odd ""schema"."Order"`, '-9223372036854775808', false]);
    expect(() =>
      validateSequenceState(sequenceState({ lastValue: '9223372036854775807', increment: '-1' })),
    ).not.toThrow();
  });

  it('validates bigint overflow and serial/identity ownership metadata', () => {
    expect(() =>
      validateSequenceState(sequenceState({ lastValue: '9223372036854775808' })),
    ).toThrow(/outside the bigint range/u);
    expect(() =>
      validateSequenceState(
        sequenceState({
          ownership: 'identity',
          identityGeneration: 'always',
        }),
      ),
    ).toThrow(/owned table column/u);
    expect(() =>
      validateSequenceState(
        sequenceState({
          ownership: 'serial',
          ownedBy: { schema: 'public', table: 'items', column: 'id' },
          lastValue: '42',
        }),
      ),
    ).not.toThrow();
  });

  it('orders data, sequence state, post-data, ownership, comments, and ACLs explicitly', () => {
    const sequence = sqlEntry('sequence', 'sequence', 'pre-data');
    const table = sqlEntry('table', 'table', 'pre-data', ['sequence']);
    const data: RestoreArchiveEntry = {
      entryId: 'data',
      archiveIdentity: 'table-data:public:items',
      objectType: 'table-data',
      section: 'data',
      objectIdentity: 'public.items',
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
      description: 'Load items.',
      diagnostics: [],
    };
    const state: RestoreArchiveEntry = {
      entryId: 'state',
      archiveIdentity: 'sequence-state:public:items_id_seq',
      objectType: 'sequence-state',
      section: 'data',
      objectIdentity: 'public.items_id_seq',
      dependencyEntryIds: ['sequence', 'data'],
      operation: {
        kind: 'sequence-state',
        schema: 'public',
        sequence: 'items_id_seq',
        lastValue: '42',
        isCalled: true,
        ownership: 'serial',
        ownedBy: { schema: 'public', table: 'items', column: 'id' },
        transactionRequirement: 'allowed',
      },
      description: 'Restore sequence state.',
      diagnostics: [],
    };
    const entries = [
      sqlEntry('acl', 'acl', 'post-data', ['table']),
      sqlEntry('comment', 'comment', 'post-data', ['table']),
      sqlEntry('owner', 'ownership', 'post-data', ['table']),
      sqlEntry('policy', 'policy', 'post-data', ['table']),
      sqlEntry('trigger', 'trigger', 'post-data', ['table']),
      sqlEntry('foreign-key', 'foreign-key', 'post-data', ['data']),
      sqlEntry('index', 'index', 'post-data', ['data']),
      state,
      data,
      table,
      sequence,
    ];
    const options = normalizeRestoreOptions({
      transactionMode: 'none',
      ownershipMode: 'preserve',
    });
    const preflight = new RestorePreflightAnalyzer().analyze(metadata, entries, target, options);
    expect(preflight.canProceed).toBe(true);
    const plan = new RestorePlanner().createPlan(metadata, entries, preflight, options);
    const operations = plan.steps.filter((step) => step.kind !== 'skip-entry');
    const phases = operations.map((step) => step.phase);
    expect(phases).toEqual([
      'pre-data',
      'pre-data',
      'table-data',
      'sequence-state',
      'post-data',
      'post-data',
      'post-data',
      'post-data',
      'ownership',
      'comments',
      'privileges',
    ]);
  });

  it('rejects a complete plan with missing or forward dependencies', () => {
    const step: RestorePlanStep = {
      kind: 'execute-sql',
      stepId: 'step',
      archiveEntryId: 'entry',
      archiveObjectType: 'table',
      phase: 'pre-data',
      dependencyStepIds: ['missing'],
      transactionRequirement: 'allowed',
      privilegeRequirements: [],
      description: 'Invalid.',
      operation: {
        kind: 'sql',
        sql: 'SELECT 1',
        privilegeRequirements: [],
        transactionRequirement: 'allowed',
      },
    };
    expect(() => validateRestorePlan([step])).toThrow(RestorePlanningError);
    expect(() =>
      validateRestorePlan([
        { ...step, dependencyStepIds: ['later'] },
        { ...step, stepId: 'later', dependencyStepIds: [] },
      ]),
    ).toThrow(/executes before/u);
  });

  it('rejects duplicate standalone and constraint-backing index creation', () => {
    const table = sqlEntry('table', 'table', 'pre-data');
    const constraint: RestoreArchiveEntry = {
      ...sqlEntry('unique', 'constraint', 'post-data', ['table']),
      operation: {
        kind: 'sql',
        sql: 'ALTER TABLE public.items ADD UNIQUE (value)',
        constraintBackingIndexIdentity: 'public.items_value_key',
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
    };
    const index: RestoreArchiveEntry = {
      ...sqlEntry('duplicate-index', 'index', 'post-data', ['table']),
      operation: {
        kind: 'sql',
        sql: 'CREATE UNIQUE INDEX items_value_key ON public.items(value)',
        createdIndexIdentity: 'public.items_value_key',
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
    };
    const report = new RestorePreflightAnalyzer().analyze(
      metadata,
      [table, constraint, index],
      target,
      normalizeRestoreOptions(),
    );
    expect(report.canProceed).toBe(false);
    expect(
      report.diagnostics.some((item) =>
        item.message.includes('backing a constraint is also planned'),
      ),
    ).toBe(true);
  });
});
