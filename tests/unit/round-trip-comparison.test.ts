import { describe, expect, it } from 'vitest';

import { canonicalizeDump, describeDumpDifference } from '../integration/support/dumpComparison.js';
import {
  compareDatabaseModels,
  normalizeDatabaseModel,
} from '../integration/support/modelComparison.js';
import type { PostgresDatabase } from '../../src/index.js';

describe('round-trip dump comparison support', () => {
  it('normalizes only documented non-semantic text differences', () => {
    const left = '-- Generated at: yesterday\r\n\r\nSELECT 1;   \r\n\r\n\r\n';
    const right = '-- Generated at: today\n\nSELECT 1;\n\n';
    expect(canonicalizeDump(left)).toBe(canonicalizeDump(right));
    expect(canonicalizeDump('SELECT 1;\n')).not.toBe(canonicalizeDump('SELECT 2;\n'));
  });

  it('reports the first byte, line, archive entry, and a useful diff', () => {
    const difference = describeDumpDifference(
      Buffer.from('-- Entry 42: table public.items\nSELECT 1;\n'),
      Buffer.from('-- Entry 42: table public.items\nSELECT 2;\n'),
    );
    expect(difference).toMatchObject({
      firstLine: 2,
      archiveEntry: '-- Entry 42: table public.items',
    });
    expect(difference?.unifiedDiff).toContain('-SELECT 1;');
    expect(difference?.unifiedDiff).toContain('+SELECT 2;');
  });

  it('removes environment identifiers but reports semantic property paths', () => {
    const source = {
      oid: 1,
      name: 'source_database',
      owner: 'dumper',
      schemas: [{ oid: 2, name: 'app', owner: 'dumper', tables: [] }],
    } as unknown as PostgresDatabase;
    const restored = {
      oid: 99,
      name: 'restored_database',
      owner: 'other',
      schemas: [{ oid: 100, name: 'app', owner: 'dumper', tables: [] }],
    } as unknown as PostgresDatabase;
    expect(normalizeDatabaseModel(source)).toMatchObject({ owner: 'dumper' });
    expect(compareDatabaseModels(source, restored)).toEqual([
      expect.objectContaining({
        propertyPath: '$.owner',
        sourceValue: 'dumper',
        restoredValue: 'other',
        classification: 'ownership or ACL difference',
      }),
    ]);
  });

  it('compares roles only when they are included in the dump', () => {
    const source = {
      name: 'source_database',
      roles: [{ name: 'pg_monitor' }],
      roleMemberships: [],
    } as unknown as PostgresDatabase;
    const restored = {
      name: 'restored_database',
      roles: [{ name: 'pg_monitor' }, { name: 'pg_maintain' }],
      roleMemberships: [{ role: 'pg_monitor', member: 'pg_maintain', grantor: 'postgres' }],
    } as unknown as PostgresDatabase;

    expect(compareDatabaseModels(source, restored)).toEqual([]);
    expect(compareDatabaseModels(source, restored, { includeRoles: true })).toEqual([
      expect.objectContaining({
        propertyPath: '$.roleMemberships[0]',
        classification: 'ownership or ACL difference',
      }),
      expect.objectContaining({
        propertyPath: '$.roles[1]',
        classification: 'ownership or ACL difference',
      }),
    ]);
  });
});
