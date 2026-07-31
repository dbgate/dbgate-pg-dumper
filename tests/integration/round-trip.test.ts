import { describe, expect, it } from 'vitest';

import type { DumpOptions } from '../../src/index.js';
import {
  createComprehensivePsqlRestoreFixture,
  createRoundTripFixture,
  createRoundTripFixtureWithLargeObject,
  createPhysicalOrderFixture,
} from './support/roundTripFixture.js';
import {
  runRoundTrip,
  type RoundTripComparisonPolicy,
  type RoundTripServer,
} from './support/roundTripHarness.js';

const configuredServers: readonly RoundTripServer[] = [
  {
    major: 9,
    url: process.env.PG96_URL ?? 'postgresql://dumper:dumper@127.0.0.1:55496/dumper_test',
  },
  {
    major: 13,
    url: process.env.PG13_URL ?? 'postgresql://dumper:dumper@127.0.0.1:55113/dumper_test',
  },
  {
    major: 18,
    url: process.env.PG18_URL ?? 'postgresql://dumper:dumper@127.0.0.1:55118/dumper_test',
  },
];

const selectedMajor = process.env.PG_TEST_MAJOR;
const servers =
  selectedMajor === undefined
    ? configuredServers
    : configuredServers
        .filter((server) => server.major === Number(selectedMajor))
        .map((server) => ({ ...server, url: process.env.PG_TEST_URL ?? server.url }));

const selection = { includeSchemas: ['roundtrip', 'Unicode_🦊'] };
const deterministicOptions = {
  includeTimestamp: false,
  lineEnding: '\n',
  statementComments: true,
  unsupportedFeaturePolicy: 'error',
  selection,
} satisfies DumpOptions;

const exactSchemaPolicy = {
  dumpComparison: 'exact',
  dataOrder: 'schema-only',
} satisfies RoundTripComparisonPolicy;

describe.each(servers)('PostgreSQL $major dump round trip', (server) => {
  it('produces an exact same-version schema fixed point', async () => {
    const result = await runRoundTrip({
      name: `pg${String(server.major)}-schema-exact`,
      source: server,
      restore: server,
      dumpOptions: { ...deterministicOptions, mode: 'schema-only' },
      setup: createRoundTripFixture,
      comparison: { ...exactSchemaPolicy, fixedPoint: true },
    });
    expect(result.dumpB.equals(result.dumpC!)).toBe(true);
    expect(result.differences).toEqual([]);
  });

  it.each([
    ['copy', { dataFormat: 'copy' }],
    ['insert', { dataFormat: 'insert' }],
    ['column-inserts', { dataFormat: 'column-inserts', explicitColumnLists: true }],
  ] satisfies readonly (readonly [string, Partial<DumpOptions>])[])(
    'produces an exact deterministic %s data dump',
    async (label, formatOptions) => {
      const result = await runRoundTrip({
        name: `pg${String(server.major)}-${label}-exact`,
        source: server,
        restore: server,
        dumpOptions: {
          ...deterministicOptions,
          ...formatOptions,
          mode: 'full',
          noOwner: true,
          noPrivileges: true,
          includeLargeObjects: true,
        },
        setup: label === 'copy' ? createRoundTripFixtureWithLargeObject : createRoundTripFixture,
        comparison: {
          dumpComparison: 'exact',
          dataOrder: 'deterministic',
          fixedPoint: label === 'copy',
          compareLargeObjects: true,
        },
      });
      expect(result.firstDumpResult.rowsWritten).toBeGreaterThan(0);
      expect(result.differences).toEqual([]);
    },
  );

  it('uses semantic row multisets when physical export order is not contractual', async () => {
    const result = await runRoundTrip({
      name: `pg${String(server.major)}-physical-semantic`,
      source: server,
      restore: server,
      dumpOptions: {
        ...deterministicOptions,
        mode: 'full',
        dataFormat: 'copy',
        noOwner: true,
        noPrivileges: true,
      },
      setup: createPhysicalOrderFixture,
      comparison: { dumpComparison: 'semantic-only', dataOrder: 'physical' },
    });
    expect(result.differences).toEqual([]);
  });

  it('restores a comprehensive native COPY data dump through psql with owners and privileges', async () => {
    const result = await runRoundTrip({
      name: `pg${String(server.major)}-comprehensive-psql-restore`,
      source: server,
      restore: server,
      dumpOptions: {
        ...deterministicOptions,
        mode: 'full',
        dataFormat: 'copy',
        includeLargeObjects: true,
      },
      setup: createComprehensivePsqlRestoreFixture,
      verifyNativeSqlRestore: true,
      expectedWarningCodes:
        server.major >= 15 ? [] : ['incomplete-metadata'],
      comparison: {
        dumpComparison: 'exact',
        dataOrder: 'deterministic',
        fixedPoint: true,
        compareLargeObjects: true,
      },
    });
    const dump = result.dumpA.toString('utf8');
    expect(dump).toContain('COPY roundtrip.bulk_payloads');
    expect(dump).toContain('ALTER TABLE roundtrip.bulk_payloads OWNER TO');
    expect(dump).toContain('GRANT SELECT');
    expect(result.firstDumpResult.rowsWritten).toBeGreaterThanOrEqual(2052);
    expect(result.nativeRestore).toMatchObject({
      status: 'success',
      rowsRestored: result.firstDumpResult.rowsWritten,
    });
    expect(result.nativeDump?.equals(result.dumpA)).toBe(true);
    expect(result.nativeDifferences).toEqual([]);
    expect(result.dumpB.equals(result.dumpC!)).toBe(true);
    expect(result.differences).toEqual([]);
  });

  it.each([
    ['clean', { includeDropStatements: true, ifExists: true }],
    ['no-owner', { noOwner: true }],
    ['no-privileges', { noPrivileges: true }],
    ['no-comments', { noComments: true }],
  ] satisfies readonly (readonly [string, Partial<DumpOptions>])[])(
    'round trips the %s schema option',
    async (label, option) => {
      const result = await runRoundTrip({
        name: `pg${String(server.major)}-${label}`,
        source: server,
        restore: server,
        dumpOptions: { ...deterministicOptions, ...option, mode: 'schema-only' },
        setup: createRoundTripFixture,
        comparison: exactSchemaPolicy,
      });
      expect(result.differences).toEqual([]);
    },
  );
});

const crossSourceUrl = process.env.PG_CROSS_SOURCE_URL;
const crossTargetUrl = process.env.PG_CROSS_TARGET_URL;
describe.skipIf(crossSourceUrl === undefined || crossTargetUrl === undefined)(
  'cross-version dump round trip',
  () => {
    it('compares compatible structure and data semantically', async () => {
      const source = {
        major: Number(process.env.PG_CROSS_SOURCE_MAJOR ?? 13),
        url: crossSourceUrl!,
      };
      const restore = {
        major: Number(process.env.PG_CROSS_TARGET_MAJOR ?? 18),
        url: crossTargetUrl!,
      };
      const result = await runRoundTrip({
        name: `pg${String(source.major)}-to-pg${String(restore.major)}-compatible`,
        source,
        restore,
        dumpOptions: {
          ...deterministicOptions,
          mode: 'full',
          dataFormat: 'copy',
          noOwner: true,
          noPrivileges: true,
        },
        setup: (context) =>
          createRoundTripFixture({ ...context, major: Math.min(source.major, restore.major) }),
        comparison: {
          dumpComparison: 'semantic-only',
          dataOrder: 'physical',
          approvedDifferenceClassifications: ['expected version normalization'],
        },
      });
      expect(result.differences).toEqual([]);
    });

    it('round trips create-database mode on a distinct restore server', async () => {
      const source = {
        major: Number(process.env.PG_CROSS_SOURCE_MAJOR ?? 13),
        url: crossSourceUrl!,
      };
      const restore = {
        major: Number(process.env.PG_CROSS_TARGET_MAJOR ?? 18),
        url: crossTargetUrl!,
      };
      const result = await runRoundTrip({
        name: `pg${String(source.major)}-to-pg${String(restore.major)}-create-database`,
        source,
        restore,
        dumpOptions: {
          ...deterministicOptions,
          mode: 'schema-only',
          includeCreateDatabase: true,
          restoreTransactionMode: 'none',
          noOwner: true,
          noPrivileges: true,
        },
        setup: (context) =>
          createRoundTripFixture({ ...context, major: Math.min(source.major, restore.major) }),
        comparison: { dumpComparison: 'semantic-only', dataOrder: 'schema-only' },
      });
      expect(result.differences).toEqual([]);
    });

    it.skipIf(
      Number(process.env.PG_CROSS_SOURCE_MAJOR ?? 13) < 14 ||
        Number(process.env.PG_CROSS_TARGET_MAJOR ?? 18) >= 14,
    )('rejects unsupported newer syntax before writing output', async () => {
      const sourceMajor = Number(process.env.PG_CROSS_SOURCE_MAJOR);
      const targetMajor = Number(process.env.PG_CROSS_TARGET_MAJOR);
      await expect(
        runRoundTrip({
          name: `pg${String(sourceMajor)}-to-pg${String(targetMajor)}-unsupported`,
          source: { major: sourceMajor, url: crossSourceUrl! },
          restore: { major: targetMajor, url: crossTargetUrl! },
          dumpOptions: {
            ...deterministicOptions,
            mode: 'schema-only',
            targetVersion: {
              complete: `PostgreSQL ${String(targetMajor)}`,
              number: targetMajor * 10_000,
              normalizedMajor: String(targetMajor),
              major: targetMajor,
              minor: 0,
              patch: 0,
            },
          },
          setup: async (context) => {
            await createRoundTripFixture(context);
            await context.client.query(
              'ALTER TABLE roundtrip.values_with_key ALTER COLUMN controls SET COMPRESSION lz4',
            );
          },
          comparison: exactSchemaPolicy,
          expectedIncompatibility: /preflight found errors/iu,
        }),
      ).rejects.toThrow(/preflight found errors/iu);
    });
  },
);
