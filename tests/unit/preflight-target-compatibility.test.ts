import { describe, expect, it } from 'vitest';

import { DumpPreflightAnalyzer } from '../../src/index.js';
import type {
  DumpArchiveInspection,
  DumpOptions,
  PostgresDatabase,
  PostgresVersion,
} from '../../src/index.js';

const version13: PostgresVersion = {
  complete: 'PostgreSQL 13',
  number: 130000,
  normalizedMajor: '13',
  major: 13,
  minor: 0,
  patch: 0,
};

describe('dump target compatibility preflight', () => {
  it('rejects unsupported column syntax before rendering starts', () => {
    const database = {
      owner: 'owner',
      schemas: [
        {
          tables: [
            {
              schema: 'app',
              name: 'items',
              kind: 'ordinary',
              persistence: 'permanent',
              estimatedRowCount: 0,
              columns: [{ name: 'payload', compression: 'lz4' }],
            },
          ],
        },
      ],
      procedures: [],
      indexes: [],
      views: [],
      policies: [],
      ownerships: [],
      accessControls: [],
    } as unknown as PostgresDatabase;
    const archive = {
      entries: [],
      orderedEntries: [],
    } as unknown as DumpArchiveInspection;
    const options = {
      unsupportedFeaturePolicy: 'error',
    } satisfies DumpOptions;

    const report = new DumpPreflightAnalyzer().analyze(
      database,
      archive,
      { ...version13, complete: 'PostgreSQL 18', number: 180000, normalizedMajor: '18', major: 18 },
      version13,
      options,
    );

    expect(report.canProceed).toBe(false);
    expect(report.targetVersionIncompatibilities).toEqual([
      expect.objectContaining({
        code: 'target-incompatibility',
        severity: 'error',
        objectIdentity: 'app.items.payload',
      }),
    ]);
  });
});
