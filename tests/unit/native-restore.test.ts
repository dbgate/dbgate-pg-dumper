import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createRestoreEngine,
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  InMemoryRestoreArchiveSource,
  normalizeRestoreOptions,
  RESTORE_ARCHIVE_FORMAT,
  RESTORE_ARCHIVE_FORMAT_VERSION,
  safeSqlPreview,
  type InMemoryRestoreArchive,
  type PostgresConnection,
  type PostgresConnectionSource,
  type PostgresQuery,
  type PostgresQueryResult,
  type PostgresRow,
  type PostgresTransactionStatus,
  type PostgresVersion,
  type RestoreArchiveEntry,
  type RestoreArchiveMetadata,
  type RestoreDataOperation,
  type RestoreProgressEvent,
  type RestoreTargetSnapshot,
} from '../../src/index.js';
import { RestorePlanner } from '../../src/restore/RestorePlanner.js';
import { RestorePreflightAnalyzer } from '../../src/restore/RestorePreflight.js';

const version: PostgresVersion = {
  complete: 'PostgreSQL 18.4',
  number: 180004,
  normalizedMajor: '18',
  major: 18,
  minor: 4,
  patch: 0,
};

const metadata: RestoreArchiveMetadata = {
  format: RESTORE_ARCHIVE_FORMAT,
  formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
  archiveId: 'restore-test',
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
    copyFromStdin: false,
    explicitCancellation: false,
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
    superuser: false,
    createRole: false,
    createDatabase: false,
  },
};

function sqlEntry(
  entryId: string,
  sql: string,
  dependencies: readonly string[] = [],
): RestoreArchiveEntry {
  return {
    entryId,
    archiveIdentity: `schema:${entryId}`,
    objectType: entryId.includes('table') ? 'table' : 'schema',
    section: 'pre-data',
    objectIdentity: `app.${entryId}`,
    dependencyEntryIds: dependencies,
    operation: {
      kind: 'sql',
      sql,
      transactionRequirement: 'allowed',
      privilegeRequirements: [],
    },
    description: `Restore ${entryId}.`,
    diagnostics: [],
  };
}

function archive(entries: readonly RestoreArchiveEntry[]): InMemoryRestoreArchive {
  return { metadata, entries };
}

function dataEntry(
  entryId: string,
  table = entryId,
  dependencies: readonly string[] = [],
): RestoreArchiveEntry {
  const operation: RestoreDataOperation = {
    kind: 'table-data',
    table: { schema: 'app', table },
    columns: ['id', 'value'],
    format: 'copy-text',
    copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
    dataSourceId: entryId,
    estimatedRows: 1,
    identityBehavior: 'preserve',
    partitionBehavior: 'target-table',
    tableKind: 'ordinary',
    transactionRequirement: 'allowed',
  };
  return {
    entryId,
    archiveIdentity: `table-data:app:${table}`,
    objectType: 'table-data',
    section: 'data',
    objectIdentity: `app.${table}`,
    dependencyEntryIds: dependencies,
    operation,
    description: `Load app.${table}.`,
    diagnostics: [],
  };
}

class RestoreConnectionDouble implements PostgresConnection {
  readonly commands: string[] = [];
  status: PostgresTransactionStatus = 'idle';
  failOn?: string;

  query<Row extends PostgresRow>(
    query: PostgresQuery,
    signal?: AbortSignal,
  ): Promise<PostgresQueryResult<Row>> {
    signal?.throwIfAborted();
    this.commands.push(query.text);
    if (this.failOn !== undefined && query.text.includes(this.failOn)) {
      return Promise.reject(
        Object.assign(new Error('password=secret server failure'), { code: '42P01' }),
      );
    }
    const command = query.text.trimStart().split(/\s+/u)[0]?.toUpperCase();
    if (command === 'BEGIN') this.status = 'in-transaction';
    if (command === 'COMMIT' || command === 'ROLLBACK') this.status = 'idle';
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  getTransactionStatus(): Promise<PostgresTransactionStatus> {
    return Promise.resolve(this.status);
  }
}

class CopyRestoreConnectionDouble extends RestoreConnectionDouble {
  copyCount = 0;
  failCopyNumber?: number;

  openCopyFrom(): Promise<{
    readonly writable: Writable;
    readonly completion: Promise<{ readonly rowCount: number }>;
    abort(reason?: Error): Promise<void>;
  }> {
    this.copyCount += 1;
    const current = this.copyCount;
    let resolve!: (result: { readonly rowCount: number }) => void;
    let reject!: (cause: unknown) => void;
    const completion = new Promise<{ readonly rowCount: number }>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final: (callback) => {
        callback();
        if (current === this.failCopyNumber) {
          reject(Object.assign(new Error('invalid input'), { code: '22P02' }));
        } else {
          resolve({ rowCount: 1 });
        }
      },
    });
    return Promise.resolve({
      writable,
      completion,
      abort: async (reason) => {
        writable.destroy(reason);
        reject(reason);
        await Promise.resolve();
      },
    });
  }
}

function engine() {
  return createRestoreEngine({
    targetInspector: {
      inspect: () => Promise.resolve(target),
    },
  });
}

function copyEngine() {
  return createRestoreEngine({
    targetInspector: {
      inspect: () =>
        Promise.resolve({
          ...target,
          driverCapabilities: { ...target.driverCapabilities, copyFromStdin: true },
        }),
    },
  });
}

describe('native PostgreSQL restore architecture', () => {
  it('owns the in-memory archive lifecycle and opens data lazily', async () => {
    const source = new InMemoryRestoreArchiveSource({
      metadata,
      entries: [],
      data: new Map([['data-1', () => Readable.from(['payload'])]]),
    });
    expect(await source.readMetadata()).toBe(metadata);
    const stream = await source.openData('data-1');
    const chunks: unknown[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.join('')).toBe('payload');
    await source.close();
    await source.close();
    expect(source.closed).toBe(true);
    await expect(source.readMetadata()).rejects.toMatchObject({
      code: 'RESTORE_ARCHIVE_INVALID',
    });
  });

  it('validates archive identities, dependencies, cycles, and transaction compatibility', () => {
    const first = sqlEntry('same', 'SELECT 1', ['missing']);
    const second: RestoreArchiveEntry = {
      ...sqlEntry('same', 'SELECT 2', ['same']),
      archiveIdentity: first.archiveIdentity,
      operation: {
        kind: 'sql',
        sql: 'SELECT 2',
        privilegeRequirements: [],
        transactionRequirement: 'forbidden' as const,
      },
    };
    const report = new RestorePreflightAnalyzer().analyze(
      metadata,
      [first, second],
      target,
      normalizeRestoreOptions({ transactionMode: 'single' }),
    );
    expect(report.canProceed).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'archive-invalid',
        'archive-dependency-missing',
        'archive-dependency-cycle',
        'transaction-incompatible',
      ]),
    );
  });

  it.each([
    ['single', 4],
    ['section', 4],
    ['entry', 6],
    ['none', 2],
  ] as const)('creates ordered %s transaction plans', (transactionMode, expectedSteps) => {
    const schema = sqlEntry('schema', 'CREATE SCHEMA app');
    const table = sqlEntry('table', 'CREATE TABLE app.items(id integer)', ['schema']);
    const options = normalizeRestoreOptions({ transactionMode });
    const preflight = new RestorePreflightAnalyzer().analyze(
      metadata,
      [table, schema],
      target,
      options,
    );
    const plan = new RestorePlanner().createPlan(metadata, [table, schema], preflight, options);
    expect(plan.steps).toHaveLength(expectedSteps);
    const sqlSteps = plan.steps.filter((step) => step.kind === 'execute-sql');
    expect(sqlSteps.map((step) => step.archiveEntryId)).toEqual(['schema', 'table']);
  });

  it('executes trusted SQL, reports ordered progress, and closes the archive', async () => {
    const connection = new RestoreConnectionDouble();
    const source = new InMemoryRestoreArchiveSource(
      archive([
        sqlEntry('schema', 'CREATE SCHEMA app'),
        sqlEntry('table', 'CREATE TABLE app.items(id integer)', ['schema']),
      ]),
    );
    const progress: RestoreProgressEvent[] = [];
    const result = await engine().restore({
      archive: source,
      target: connection,
      onProgress: (event) => progress.push(event),
    });
    expect(result.status).toBe('success');
    expect(result.failedStepCount).toBe(0);
    expect(connection.commands).toEqual([
      'BEGIN',
      'CREATE SCHEMA app',
      'CREATE TABLE app.items(id integer)',
      'COMMIT',
    ]);
    expect(progress[0]?.event).toBe('restore-started');
    const eventNames = progress.map((event) => event.event);
    const orderedEvents: readonly RestoreProgressEvent['event'][] = [
      'restore-started',
      'archive-validated',
      'preflight-started',
      'preflight-completed',
      'plan-created',
      'phase-started',
      'step-started',
      'step-completed',
      'phase-completed',
      'restore-completed',
    ];
    let previousIndex = -1;
    for (const event of orderedEvents) {
      const index = eventNames.indexOf(event, previousIndex + 1);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(source.closed).toBe(true);
  });

  it('rolls back failed SQL and redacts secret-bearing previews', async () => {
    const connection = new RestoreConnectionDouble();
    connection.failOn = 'CREATE TABLE';
    const result = await engine().restore({
      archive: new InMemoryRestoreArchiveSource(
        archive([sqlEntry('table', 'CREATE TABLE app.items(password text)')]),
      ),
      target: connection,
    });
    expect(result.status).toBe('failed');
    expect(result.failedStepCount).toBe(1);
    expect(result.restoredObjectCount).toBe(0);
    expect(result.partialStateMayRemain).toBe(false);
    expect(connection.commands.at(-1)).toBe('ROLLBACK');
    expect(safeSqlPreview("SELECT 'postgresql://user:secret@host/db'")).not.toContain('secret');
  });

  it('returns a cancelled result and still closes resources', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const source = new InMemoryRestoreArchiveSource(archive([sqlEntry('schema', 'SELECT 1')]));
    let releases = 0;
    const targetSource: PostgresConnectionSource = {
      acquire: () =>
        Promise.resolve({
          connection: new RestoreConnectionDouble(),
          release: () => {
            releases += 1;
            return Promise.resolve();
          },
        }),
    };
    const result = await engine().restore({
      archive: source,
      target: targetSource,
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(source.closed).toBe(true);
    expect(releases).toBe(0);
  });

  it('releases an acquired target session exactly once', async () => {
    let releases = 0;
    const targetSource: PostgresConnectionSource = {
      acquire: () =>
        Promise.resolve({
          connection: new RestoreConnectionDouble(),
          release: () => {
            releases += 1;
            return Promise.resolve();
          },
        }),
    };
    const result = await engine().restore({
      archive: new InMemoryRestoreArchiveSource(archive([sqlEntry('schema', 'SELECT 1')])),
      target: targetSource,
    });
    expect(result.status).toBe('success');
    expect(releases).toBe(1);
  });

  it('keeps role, schema, and tablespace mappings strongly distinguished', () => {
    const options = normalizeRestoreOptions({
      roleMappings: [
        { kind: 'role', sourceRole: 'owner', action: 'map', targetRole: 'restore_user' },
      ],
      schemaMappings: [
        { kind: 'schema', sourceSchema: 'old', action: 'map', targetSchema: 'public' },
      ],
      tablespaceMappings: [
        {
          kind: 'tablespace',
          sourceTablespace: 'fast',
          action: 'map',
          targetTablespace: 'pg_default',
        },
      ],
    });
    expect(options.roleMappings[0]?.kind).toBe('role');
    expect(options.schemaMappings[0]?.kind).toBe('schema');
    expect(options.tablespaceMappings[0]?.kind).toBe('tablespace');
  });

  it('applies schema mappings to structured COPY targets', () => {
    const options = normalizeRestoreOptions({
      transactionMode: 'none',
      schemaMappings: [
        { kind: 'schema', sourceSchema: 'app', action: 'map', targetSchema: 'public' },
      ],
    });
    const entry = dataEntry('mapped', 'items');
    const compatibleTarget = {
      ...target,
      driverCapabilities: { ...target.driverCapabilities, copyFromStdin: true },
    };
    const preflight = new RestorePreflightAnalyzer().analyze(
      metadata,
      [entry],
      compatibleTarget,
      options,
    );
    const plan = new RestorePlanner().createPlan(metadata, [entry], preflight, options);
    const step = plan.steps.find((candidate) => candidate.kind === 'load-table-data');
    expect(step?.kind === 'load-table-data' ? step.operation.table.schema : undefined).toBe(
      'public',
    );
  });

  it('rejects unsupported COPY encoding before opening data', () => {
    const entry = dataEntry('encoded', 'items');
    const invalidEntry: RestoreArchiveEntry = {
      ...entry,
      operation: {
        ...entry.operation,
        copyText: {
          ...CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          encoding: 'LATIN1',
        },
      } as unknown as RestoreDataOperation,
    };
    const report = new RestorePreflightAnalyzer().analyze(
      metadata,
      [invalidEntry],
      {
        ...target,
        driverCapabilities: { ...target.driverCapabilities, copyFromStdin: true },
      },
      normalizeRestoreOptions(),
    );
    expect(report.canProceed).toBe(false);
    expect(
      report.diagnostics.some(
        (item) => item.code === 'unsupported-operation' && item.message.includes('canonical UTF-8'),
      ),
    ).toBe(true);
  });

  it('rolls back failed COPY and reports partial in continue mode', async () => {
    const connection = new CopyRestoreConnectionDouble();
    connection.failCopyNumber = 1;
    const entries = [dataEntry('bad', 'bad'), dataEntry('good', 'good')];
    const result = await copyEngine().restore({
      archive: new InMemoryRestoreArchiveSource({
        metadata,
        entries,
        data: new Map([
          ['bad', 'bad\tvalue\n'],
          ['good', '1\tvalue\n'],
        ]),
      }),
      target: connection,
      options: { transactionMode: 'entry', errorMode: 'continue' },
    });
    expect(result.status).toBe('partial');
    expect(result.tableDataAttemptedCount).toBe(2);
    expect(result.tableDataCompletedCount).toBe(1);
    expect(result.tableDataFailedCount).toBe(1);
    expect(result.restoredTableDataCount).toBe(1);
    expect(connection.commands).toContain('ROLLBACK');
    expect(connection.commands.at(-1)).toBe('COMMIT');
  });

  it('records a failed sequence state and skips only dependent finalization', async () => {
    const connection = new RestoreConnectionDouble();
    connection.failOn = 'setval';
    const definition: RestoreArchiveEntry = {
      ...sqlEntry('sequence-definition', 'CREATE SEQUENCE app.items_id_seq'),
      archiveIdentity: 'sequence:app:items_id_seq',
      objectType: 'sequence',
      objectIdentity: 'app.items_id_seq',
    };
    const state: RestoreArchiveEntry = {
      entryId: 'sequence-state',
      archiveIdentity: 'sequence-state:app:items_id_seq',
      objectType: 'sequence-state',
      section: 'data',
      objectIdentity: 'app.items_id_seq',
      dependencyEntryIds: [definition.entryId],
      operation: {
        kind: 'sequence-state',
        schema: 'app',
        sequence: 'items_id_seq',
        lastValue: '9007199254740993',
        isCalled: false,
        dataType: 'bigint',
        ownership: 'standalone',
        increment: '1',
        transactionRequirement: 'allowed',
      },
      description: 'Restore sequence state.',
      diagnostics: [],
    };
    const comment: RestoreArchiveEntry = {
      ...sqlEntry('independent-comment', 'COMMENT ON SCHEMA app IS NULL'),
      archiveIdentity: 'comment:app',
      objectType: 'comment',
      section: 'post-data',
      dependencyEntryIds: [definition.entryId],
    };
    const acl: RestoreArchiveEntry = {
      ...sqlEntry('dependent-acl', 'GRANT USAGE ON SEQUENCE app.items_id_seq TO PUBLIC'),
      archiveIdentity: 'acl:app:items_id_seq',
      objectType: 'acl',
      section: 'post-data',
      dependencyEntryIds: [state.entryId],
    };
    const progress: RestoreProgressEvent[] = [];
    const result = await engine().restore({
      archive: new InMemoryRestoreArchiveSource(archive([definition, state, comment, acl])),
      target: connection,
      options: { transactionMode: 'entry', errorMode: 'continue' },
      onProgress: (event) => progress.push(event),
    });
    expect(result.status).toBe('partial');
    expect(result.sequencesAttemptedCount).toBe(1);
    expect(result.sequencesRestoredCount).toBe(0);
    expect(result.sequencesFailedCount).toBe(1);
    expect(result.commentsAppliedCount).toBe(1);
    expect(result.aclOperationsAppliedCount).toBe(0);
    expect(result.validation.checksFailed).toBe(1);
    expect(connection.commands).toContain('ROLLBACK');
    expect(progress.map((event) => event.event)).toEqual(
      expect.arrayContaining(['sequence-restore-started', 'sequence-restore-failed']),
    );
  });

  it('counts committed post-data and finalization operations by object type', async () => {
    const root = sqlEntry('schema-root', 'CREATE SCHEMA app');
    const typedEntries = [
      ['constraint', 'constraint'],
      ['foreign-key', 'foreign-key'],
      ['index', 'index'],
      ['trigger', 'trigger'],
      ['policy', 'policy'],
      ['owner', 'ownership'],
      ['comment', 'comment'],
      ['acl', 'acl'],
      ['defaults', 'default-privilege'],
    ] as const;
    const entries: RestoreArchiveEntry[] = [
      root,
      ...typedEntries.map(([entryId, objectType]): RestoreArchiveEntry => ({
        ...sqlEntry(entryId, `SELECT '${entryId}'`, [root.entryId]),
        archiveIdentity: `${objectType}:${entryId}`,
        objectType,
        section: 'post-data',
      })),
    ];
    const result = await engine().restore({
      archive: new InMemoryRestoreArchiveSource(archive(entries)),
      target: new RestoreConnectionDouble(),
      options: { ownershipMode: 'preserve' },
    });
    expect(result.status).toBe('success');
    expect(result.constraintsCreatedCount).toBe(2);
    expect(result.indexesCreatedCount).toBe(1);
    expect(result.triggersCreatedCount).toBe(1);
    expect(result.policiesCreatedCount).toBe(1);
    expect(result.ownershipStatementsAppliedCount).toBe(1);
    expect(result.commentsAppliedCount).toBe(1);
    expect(result.aclOperationsAppliedCount).toBe(2);
  });
});
