import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import {
  dumpPostgres,
  introspectPostgres,
  redactSensitiveText,
  type DumpOptions,
  type DumpResult,
  type DumpWarningCode,
  type PostgresDatabase,
} from '../../../src/index.js';
import { fromPgClient } from '../../../src/pg.js';
import { compareLargeObjects, compareTableData } from './databaseComparison.js';
import {
  canonicalizeDump,
  describeDumpDifference,
  type CanonicalDumpOptions,
  type DumpDifference,
} from './dumpComparison.js';
import {
  compareDatabaseModels,
  normalizeDatabaseModel,
  type ComparisonDifference,
  type DifferenceClassification,
} from './modelComparison.js';

export interface RoundTripServer {
  readonly major: number;
  readonly url: string;
}

export interface RoundTripComparisonPolicy {
  readonly dumpComparison: 'exact' | 'canonical' | 'semantic-only';
  readonly dataOrder: 'deterministic' | 'physical' | 'schema-only';
  readonly canonical?: CanonicalDumpOptions;
  readonly fixedPoint?: boolean;
  readonly compareLargeObjects?: boolean;
  readonly approvedDifferenceClassifications?: readonly DifferenceClassification[];
}

export interface RoundTripFixtureContext {
  readonly client: Client;
  readonly major: number;
}

export interface RoundTripRequest {
  readonly name: string;
  readonly source: RoundTripServer;
  readonly restore: RoundTripServer;
  readonly dumpOptions: DumpOptions;
  readonly setup: (context: RoundTripFixtureContext) => Promise<void>;
  readonly comparison: RoundTripComparisonPolicy;
  readonly expectedWarningCodes?: readonly DumpWarningCode[];
  readonly expectedIncompatibility?: RegExp;
}

export interface RoundTripResult {
  readonly dumpA: Buffer;
  readonly dumpB: Buffer;
  readonly dumpC?: Buffer;
  readonly firstDumpResult: DumpResult;
  readonly secondDumpResult: DumpResult;
  readonly differences: readonly ComparisonDifference[];
  readonly durations: {
    readonly firstDumpMilliseconds: number;
    readonly restoreMilliseconds: number;
    readonly secondDumpMilliseconds: number;
  };
}

interface RestoreLog {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

interface FailureState {
  dumpA?: Buffer;
  dumpB?: Buffer;
  dumpC?: Buffer;
  dumpDifference?: DumpDifference;
  canonicalDifference?: DumpDifference;
  sourceModel?: PostgresDatabase;
  restoredModel?: PostgresDatabase;
  differences?: readonly ComparisonDifference[];
  restoreLog?: RestoreLog;
  diagnostics?: unknown;
}

const artifactRoot = resolve('test-output', 'round-trip');

function databaseName(prefix: string): string {
  return `dgrt_${prefix.replaceAll(/[^a-zA-Z0-9]+/gu, '_').slice(0, 24)}_${randomUUID()
    .replaceAll('-', '')
    .slice(0, 12)}`.toLowerCase();
}

function databaseUrl(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function adminClient(server: RoundTripServer): Promise<Client> {
  const url = new URL(server.url);
  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createDatabase(server: RoundTripServer, name: string): Promise<void> {
  const client = await adminClient(server);
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE template0`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(server: RoundTripServer, name: string): Promise<void> {
  const client = await adminClient(server);
  try {
    await client.query(
      'SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()',
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

async function dump(
  client: Client,
  options: DumpOptions,
): Promise<{
  readonly bytes: Buffer;
  readonly result: DumpResult;
}> {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
      callback();
    },
  });
  try {
    const result = await dumpPostgres(fromPgClient(client), options, output);
    return { bytes: Buffer.concat(chunks), result };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      partialDump: Buffer.concat(chunks),
    });
  }
}

async function restoreWithPsql(url: string, bytes: Buffer): Promise<RestoreLog> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.env.PG_PSQL ?? 'psql',
      ['--set', 'ON_ERROR_STOP=1', '--echo-errors', '--no-psqlrc', '--dbname', url],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => {
      const log = {
        stdout: redactSensitiveText(stdout),
        stderr: redactSensitiveText(stderr),
        exitCode,
      };
      if (exitCode === 0) resolvePromise(log);
      else {
        reject(
          Object.assign(
            new Error(
              `psql restore failed with exit code ${String(exitCode)}:\n${log.stderr.slice(-4000)}`,
            ),
            { restoreLog: log },
          ),
        );
      }
    });
    child.stdin.end(bytes);
  });
}

function assertWarnings(result: DumpResult, expected: readonly DumpWarningCode[]): void {
  const actual = result.warnings.map((warning) => warning.code).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `Unexpected dump warnings. Expected ${JSON.stringify(wanted)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function compareDumps(
  left: Buffer,
  right: Buffer,
  policy: RoundTripComparisonPolicy,
): { readonly raw?: DumpDifference; readonly canonical?: DumpDifference } {
  if (policy.dumpComparison === 'semantic-only') return {};
  const raw = describeDumpDifference(left, right);
  const canonicalLeft = Buffer.from(canonicalizeDump(left.toString('utf8'), policy.canonical));
  const canonicalRight = Buffer.from(canonicalizeDump(right.toString('utf8'), policy.canonical));
  const canonical = describeDumpDifference(canonicalLeft, canonicalRight);
  if (policy.dumpComparison === 'exact') {
    return {
      ...(raw === undefined ? {} : { raw }),
      ...(canonical === undefined ? {} : { canonical }),
    };
  }
  return {
    ...(raw === undefined ? {} : { raw }),
    ...(canonical === undefined ? {} : { canonical }),
  };
}

function unapprovedDifferences(
  differences: readonly ComparisonDifference[],
  policy: RoundTripComparisonPolicy,
): readonly ComparisonDifference[] {
  const approved = new Set(policy.approvedDifferenceClassifications ?? []);
  return differences.filter((difference) => !approved.has(difference.classification));
}

async function writeFailureArtifacts(name: string, state: FailureState): Promise<string> {
  const directory = resolve(artifactRoot, name.replaceAll(/[^a-zA-Z0-9_.-]+/gu, '-'));
  await mkdir(directory, { recursive: true });
  const writes: Promise<void>[] = [];
  const add = (file: string, value: string | Buffer): void => {
    writes.push(writeFile(resolve(directory, file), value));
  };
  if (state.dumpA !== undefined) add('dump-a.sql', state.dumpA);
  if (state.dumpB !== undefined) add('dump-b.sql', state.dumpB);
  if (state.dumpC !== undefined) add('dump-c.sql', state.dumpC);
  if (state.dumpDifference !== undefined) {
    add('dump.diff', state.dumpDifference.unifiedDiff);
    add('first-difference.json', JSON.stringify(state.dumpDifference, null, 2));
  }
  if (state.canonicalDifference !== undefined) {
    add('canonical.diff', state.canonicalDifference.unifiedDiff);
  }
  if (state.sourceModel !== undefined) {
    add('source-model.json', JSON.stringify(normalizeDatabaseModel(state.sourceModel), null, 2));
  }
  if (state.restoredModel !== undefined) {
    add(
      'restored-model.json',
      JSON.stringify(normalizeDatabaseModel(state.restoredModel), null, 2),
    );
  }
  if (state.differences !== undefined) {
    add('comparison-report.json', JSON.stringify(state.differences, null, 2));
    add(
      'structural-differences.json',
      JSON.stringify(
        state.differences.filter((item) => item.classification.includes('schema')),
        null,
        2,
      ),
    );
    add(
      'data-differences.json',
      JSON.stringify(
        state.differences.filter((item) => item.classification.includes('data')),
        null,
        2,
      ),
    );
    add(
      'sequence-differences.json',
      JSON.stringify(
        state.differences.filter((item) => item.classification === 'sequence-state difference'),
        null,
        2,
      ),
    );
  }
  if (state.restoreLog !== undefined) {
    add('restore.stdout.log', state.restoreLog.stdout);
    add('restore.stderr.log', state.restoreLog.stderr);
  }
  if (state.diagnostics !== undefined) {
    add('dump-diagnostics.json', JSON.stringify(state.diagnostics, null, 2));
  }
  await Promise.all(writes);
  return directory;
}

export async function runRoundTrip(request: RoundTripRequest): Promise<RoundTripResult> {
  const sourceName = databaseName(`${request.name}_source`);
  const targetName = databaseName(`${request.name}_target`);
  const restoredName = request.dumpOptions.includeCreateDatabase === true ? sourceName : targetName;
  const fixedPointName = databaseName(`${request.name}_fixed`);
  const state: FailureState = {};
  let source: Client | undefined;
  let target: Client | undefined;
  let fixedPoint: Client | undefined;

  try {
    if (
      request.dumpOptions.includeCreateDatabase === true &&
      new URL(request.source.url).host === new URL(request.restore.url).host
    ) {
      throw new Error('Create-database round trips require distinct source and restore servers.');
    }
    await createDatabase(request.source, sourceName);
    if (request.dumpOptions.includeCreateDatabase !== true) {
      await createDatabase(request.restore, restoredName);
    }
    source = new Client({ connectionString: databaseUrl(request.source.url, sourceName) });
    await source.connect();
    if (request.dumpOptions.includeCreateDatabase !== true) {
      target = new Client({ connectionString: databaseUrl(request.restore.url, restoredName) });
      await target.connect();
    }
    await request.setup({ client: source, major: request.source.major });

    const firstDumpStarted = performance.now();
    const first = await dump(source, request.dumpOptions);
    const firstDumpMilliseconds = performance.now() - firstDumpStarted;
    state.dumpA = first.bytes;
    state.diagnostics = { dumpA: first.result };
    assertWarnings(first.result, request.expectedWarningCodes ?? []);

    // A clean dump is intended to replace an existing restore, not initialize
    // an empty database. Seed the target without DROP statements first, then
    // apply dump A to exercise the clean path under its real precondition.
    if (request.dumpOptions.includeDropStatements === true) {
      const baseline = await dump(source, {
        ...request.dumpOptions,
        includeDropStatements: false,
      });
      await restoreWithPsql(databaseUrl(request.restore.url, restoredName), baseline.bytes);
    }

    const restoreStarted = performance.now();
    try {
      state.restoreLog = await restoreWithPsql(
        databaseUrl(
          request.restore.url,
          request.dumpOptions.includeCreateDatabase === true ? 'postgres' : restoredName,
        ),
        first.bytes,
      );
    } catch (error) {
      if (error instanceof Error && 'restoreLog' in error) {
        state.restoreLog = (error as Error & { restoreLog: RestoreLog }).restoreLog;
      }
      throw error;
    }
    const restoreMilliseconds = performance.now() - restoreStarted;
    if (target === undefined) {
      target = new Client({ connectionString: databaseUrl(request.restore.url, restoredName) });
      await target.connect();
    }

    const secondDumpStarted = performance.now();
    const second = await dump(target, request.dumpOptions);
    const secondDumpMilliseconds = performance.now() - secondDumpStarted;
    state.dumpB = second.bytes;
    state.diagnostics = { dumpA: first.result, dumpB: second.result };
    assertWarnings(second.result, request.expectedWarningCodes ?? []);

    const dumpDifferences = compareDumps(first.bytes, second.bytes, request.comparison);
    if (dumpDifferences.raw !== undefined) state.dumpDifference = dumpDifferences.raw;
    if (dumpDifferences.canonical !== undefined) {
      state.canonicalDifference = dumpDifferences.canonical;
    }
    if (
      (request.comparison.dumpComparison === 'exact' && dumpDifferences.raw !== undefined) ||
      (request.comparison.dumpComparison === 'canonical' && dumpDifferences.canonical !== undefined)
    ) {
      throw new Error(
        `Dump A and dump B differ at byte ${String(
          (dumpDifferences.canonical ?? dumpDifferences.raw)?.firstByte,
        )}, line ${String((dumpDifferences.canonical ?? dumpDifferences.raw)?.firstLine)}.`,
      );
    }

    const selection = request.dumpOptions.selection;
    const introspectionOptions = selection === undefined ? {} : { selection };
    const [sourceInspection, restoredInspection] = await Promise.all([
      introspectPostgres(fromPgClient(source), introspectionOptions),
      introspectPostgres(fromPgClient(target), introspectionOptions),
    ]);
    state.sourceModel = sourceInspection.database;
    state.restoredModel = restoredInspection.database;
    const differences = [
      ...compareDatabaseModels(sourceInspection.database, restoredInspection.database, {
        includeSequenceState: request.comparison.dataOrder !== 'schema-only',
        includeComments: request.dumpOptions.noComments !== true,
      }),
    ];
    if (request.comparison.dataOrder !== 'schema-only') {
      differences.push(
        ...(await compareTableData(
          source,
          target,
          sourceInspection.database,
          restoredInspection.database,
        )),
      );
    }
    if (request.comparison.compareLargeObjects ?? false) {
      differences.push(...(await compareLargeObjects(source, target)));
    }
    state.differences = differences;
    const unapproved = unapprovedDifferences(differences, request.comparison);
    if (unapproved.length > 0) {
      throw new Error(
        `Round-trip comparison found ${String(unapproved.length)} semantic differences.`,
      );
    }

    let dumpC: Buffer | undefined;
    if (request.comparison.fixedPoint ?? false) {
      await createDatabase(request.restore, fixedPointName);
      fixedPoint = new Client({
        connectionString: databaseUrl(request.restore.url, fixedPointName),
      });
      await fixedPoint.connect();
      await restoreWithPsql(databaseUrl(request.restore.url, fixedPointName), second.bytes);
      const third = await dump(fixedPoint, request.dumpOptions);
      dumpC = third.bytes;
      state.dumpC = dumpC;
      const fixedPointDifference = compareDumps(second.bytes, dumpC, request.comparison);
      if (
        (request.comparison.dumpComparison === 'exact' && fixedPointDifference.raw !== undefined) ||
        (request.comparison.dumpComparison === 'canonical' &&
          fixedPointDifference.canonical !== undefined)
      ) {
        if (fixedPointDifference.raw !== undefined) {
          state.dumpDifference = fixedPointDifference.raw;
        }
        if (fixedPointDifference.canonical !== undefined) {
          state.canonicalDifference = fixedPointDifference.canonical;
        }
        throw new Error('Dump B and dump C did not reach a stable fixed point.');
      }
    }

    return {
      dumpA: first.bytes,
      dumpB: second.bytes,
      ...(dumpC === undefined ? {} : { dumpC }),
      firstDumpResult: first.result,
      secondDumpResult: second.result,
      differences,
      durations: { firstDumpMilliseconds, restoreMilliseconds, secondDumpMilliseconds },
    };
  } catch (error) {
    if (error instanceof Error && 'partialDump' in error) {
      state.dumpA = (error as Error & { partialDump: Buffer }).partialDump;
    }
    if (error instanceof Error && 'report' in error) {
      state.diagnostics = error.report;
    }
    if (
      request.expectedIncompatibility !== undefined &&
      error instanceof Error &&
      request.expectedIncompatibility.test(error.message) &&
      state.dumpA?.length === 0
    ) {
      return Promise.reject(error);
    }
    const directory = await writeFailureArtifacts(request.name, state);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nFailure artifacts: ${basename(artifactRoot)}/${basename(directory)}`,
      {
        cause: error,
      },
    );
  } finally {
    await Promise.allSettled([source?.end(), target?.end(), fixedPoint?.end()]);
    await Promise.allSettled([
      dropDatabase(request.source, sourceName),
      dropDatabase(request.restore, restoredName),
      ...((request.comparison.fixedPoint ?? false)
        ? [dropDatabase(request.restore, fixedPointName)]
        : []),
    ]);
  }
}
