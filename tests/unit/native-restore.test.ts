import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createRestoreEngine,
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

function engine() {
  return createRestoreEngine({
    targetInspector: {
      inspect: () => Promise.resolve(target),
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
});
