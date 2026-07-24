import { describe, expect, it } from 'vitest';

import {
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  canonicalizeValidationValue,
  checksumCanonicalValidationRows,
  deriveRestoreConfidence,
  normalizeRestoreOptions,
  PostgreSqlRestoreValidator,
  RESTORE_ARCHIVE_FORMAT,
  RESTORE_ARCHIVE_FORMAT_VERSION,
  type PostgresConnection,
  type PostgresQuery,
  type PostgresQueryResult,
  type PostgresRow,
  type PostgresTransactionStatus,
  type PostgresVersion,
  type RestoreArchiveEntry,
  type RestoreArchiveMetadata,
  type RestoreTargetSnapshot,
} from '../../src/index.js';

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
  archiveId: 'validation',
  sourceVersion: version,
  requiredExtensions: [],
  requiredRoles: [],
  requiredPrivileges: [],
  requiredTablespaces: [],
  transactionCompatibility: 'compatible',
  diagnostics: [],
};

const entries: readonly RestoreArchiveEntry[] = [
  {
    entryId: 'table',
    archiveIdentity: 'table:app:items',
    objectType: 'table',
    section: 'pre-data',
    objectIdentity: 'app.items',
    dependencyEntryIds: [],
    operation: {
      kind: 'sql',
      sql: 'CREATE TABLE app.items(id integer)',
      target: { kind: 'table', schema: 'app', name: 'items' },
      replacementTargetShape: {
        columns: [{ name: 'id', formattedType: 'integer' }],
      },
      transactionRequirement: 'allowed',
      privilegeRequirements: [],
    },
    description: 'Table.',
    diagnostics: [],
  },
  {
    entryId: 'data',
    archiveIdentity: 'table-data:app:items',
    objectType: 'table-data',
    section: 'data',
    objectIdentity: 'app.items',
    dependencyEntryIds: ['table'],
    operation: {
      kind: 'table-data',
      table: { schema: 'app', table: 'items' },
      columns: ['id'],
      format: 'copy-text',
      copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
      dataSourceId: 'data',
      estimatedRows: 2,
      identityBehavior: 'preserve',
      partitionBehavior: 'target-table',
      transactionRequirement: 'allowed',
    },
    description: 'Data.',
    diagnostics: [],
  },
  {
    entryId: 'sequence-state',
    archiveIdentity: 'sequence-state:app:items_id_seq',
    objectType: 'sequence-state',
    section: 'data',
    objectIdentity: 'app.items_id_seq',
    dependencyEntryIds: [],
    operation: {
      kind: 'sequence-state',
      schema: 'app',
      sequence: 'items_id_seq',
      lastValue: '9007199254740993',
      isCalled: false,
      transactionRequirement: 'allowed',
    },
    description: 'Sequence.',
    diagnostics: [],
  },
];

const target: RestoreTargetSnapshot = {
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
  schemas: ['app'],
  extensions: [],
  roles: ['runner'],
  setRoleTargets: ['runner'],
  tablespaces: ['pg_default'],
  currentUser: {
    name: 'runner',
    superuser: false,
    createRole: false,
    createDatabase: false,
  },
  objects: [
    {
      catalogOid: 1,
      kind: 'table',
      schema: 'app',
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
    },
    { catalogOid: 2, kind: 'sequence', schema: 'app', name: 'items_id_seq' },
  ],
};

class ValidationConnection implements PostgresConnection {
  count = '2';
  sequence = { last_value: '9007199254740993', is_called: false };
  status: PostgresTransactionStatus = 'idle';

  query<Row extends PostgresRow>(query: PostgresQuery): Promise<PostgresQueryResult<Row>> {
    if (query.text.includes('current_database()')) {
      return Promise.resolve({
        rows: [
          {
            database_name: 'db',
            role_name: 'runner',
            replication_role: 'origin',
          } as unknown as Row,
        ],
        rowCount: 1,
      });
    }
    if (query.text.includes('count(*)')) {
      return Promise.resolve({
        rows: [{ count_value: this.count } as unknown as Row],
        rowCount: 1,
      });
    }
    if (query.text.includes('last_value::text')) {
      return Promise.resolve({
        rows: [this.sequence as unknown as Row],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  getTransactionStatus(): Promise<PostgresTransactionStatus> {
    return Promise.resolve(this.status);
  }
}

describe('post-restore validation', () => {
  it('derives confidence from performed checks instead of caller input', () => {
    expect(deriveRestoreConfidence('not-run', 'none', [])).toBe('unverified');
    expect(
      deriveRestoreConfidence('passed', 'structure', [
        {
          checkId: 'one',
          type: 'object-structure',
          status: 'passed',
          durationMilliseconds: 1,
          diagnosticCodes: [],
        },
      ]),
    ).toBe('medium');
    expect(
      deriveRestoreConfidence(
        'passed',
        'structure-and-data',
        [
          {
            checkId: 'rows',
            type: 'row-count',
            status: 'passed',
            durationMilliseconds: 1,
            diagnosticCodes: [],
          },
        ],
        { skippedStepCount: 1 },
      ),
    ).toBe('low');
  });

  it('canonicalizes JSON keys, bigint, NULL, and floating-point special values deterministically', () => {
    expect(canonicalizeValidationValue({ b: 1, a: null })).toBe('object:{"a":null,"b":number:1}');
    expect(canonicalizeValidationValue(9007199254740993n)).toBe('bigint:9007199254740993');
    expect(canonicalizeValidationValue(Number.NaN)).toBe('number:NaN');
    expect(canonicalizeValidationValue(Number.POSITIVE_INFINITY)).toBe('number:Infinity');
    expect(canonicalizeValidationValue(-0)).toBe('number:-0');
    expect(
      checksumCanonicalValidationRows([
        [null, ''],
        [true, 'x'],
      ]),
    ).toHaveLength(64);
  });

  it('validates mapped object shape, exact row count, and lossless sequence state', async () => {
    const result = await new PostgreSqlRestoreValidator().validateLoaded(
      new ValidationConnection(),
      metadata,
      entries,
      target,
      normalizeRestoreOptions({
        validation: {
          level: 'structure-and-data',
          rowCountMode: 'exact',
          sequenceMode: 'archive-state',
        },
      }),
    );
    expect(result.status).toBe('passed');
    expect(result.confidence).toBe('high');
    expect(result.summary).toMatchObject({
      tablesCounted: 1,
      sequenceStatesVerified: 1,
      rowsScanned: '2',
    });
  });

  it('reports precise row-count and sequence mismatches without mutating nextval', async () => {
    const connection = new ValidationConnection();
    connection.count = '3';
    connection.sequence = { last_value: '5', is_called: true };
    const result = await new PostgreSqlRestoreValidator().validateLoaded(
      connection,
      metadata,
      entries,
      target,
      normalizeRestoreOptions({
        validation: {
          level: 'structure-and-data',
          rowCountMode: 'exact',
          sequenceMode: 'archive-state',
        },
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.confidence).toBe('low');
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'validation-row-count-mismatch',
        'validation-sequence-state-mismatch',
      ]),
    );
  });

  it('applies schema mapping to expected validation identities', async () => {
    const mappedTarget = {
      ...target,
      schemas: ['tenant'],
      objects: (target.objects ?? []).map((object) => ({ ...object, schema: 'tenant' })),
    };
    const result = await new PostgreSqlRestoreValidator().validateLoaded(
      new ValidationConnection(),
      metadata,
      entries,
      mappedTarget,
      normalizeRestoreOptions({
        schemaMappings: [
          { kind: 'schema', sourceSchema: 'app', action: 'map', targetSchema: 'tenant' },
        ],
        validation: { level: 'structure' },
      }),
    );
    expect(result.status).toBe('passed');
    expect(result.checks.some((check) => check.targetObjectIdentity === 'table:tenant.items')).toBe(
      true,
    );
  });
});
