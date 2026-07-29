import { describe, expect, it } from 'vitest';

import { DumpPreflightAnalyzer } from '../../src/index.js';
import { toPlainSqlRenderOptions } from '../../src/api/types.js';
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
  it('selects warn-skip rendering for best-effort dumps unless explicitly overridden', () => {
    expect(toPlainSqlRenderOptions({ bestEffort: true }).unsupportedFeaturePolicy).toBe(
      'warn-skip',
    );
    expect(
      toPlainSqlRenderOptions({
        bestEffort: true,
        unsupportedFeaturePolicy: 'error',
      }).unsupportedFeaturePolicy,
    ).toBe('error');
  });

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

  it('reports unsafe target incompatibilities as warnings in best-effort mode', () => {
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
              columns: [{ name: 'id', identity: 'always' }],
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

    const report = new DumpPreflightAnalyzer().analyze(
      database,
      archive,
      { ...version13, complete: 'PostgreSQL 16', number: 160000, normalizedMajor: '16', major: 16 },
      {
        ...version13,
        complete: 'PostgreSQL 9.6',
        number: 90600,
        normalizedMajor: '9.6',
        major: 9,
        minor: 6,
      },
      {},
    );

    expect(report.canProceed).toBe(true);
    expect(report.targetVersionIncompatibilities).toEqual([
      expect.objectContaining({
        code: 'target-incompatibility',
        severity: 'warning',
        objectIdentity: 'app.items.id',
      }),
    ]);
  });
});
