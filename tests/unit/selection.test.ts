import { describe, expect, it } from 'vitest';

import { isSchemaSelected, isTableSelected, normalizeDumpSelection } from '../../src/index.js';

describe('dump selection', () => {
  it('normalizes exact names deterministically', () => {
    expect(
      normalizeDumpSelection({
        includeSchemas: [' app ', 'app', 'MixedCase'],
        excludeTables: ['audit.events', ' audit.events '],
      }),
    ).toMatchObject({
      includeSchemas: ['MixedCase', 'app'],
      excludeTables: ['audit.events'],
      includeSystemSchemas: false,
      includeTemporarySchemas: false,
    });
  });

  it('excludes system, toast, and temporary schemas by default', () => {
    const selection = normalizeDumpSelection();
    expect(isSchemaSelected('public', selection)).toBe(true);
    expect(isSchemaSelected('pg_catalog', selection)).toBe(false);
    expect(isSchemaSelected('information_schema', selection)).toBe(false);
    expect(isSchemaSelected('pg_toast', selection)).toBe(false);
    expect(isSchemaSelected('pg_temp_4', selection)).toBe(false);
    expect(isSchemaSelected('pg_toast_temp_4', selection)).toBe(false);
  });

  it('supports qualified and unqualified exact table filters', () => {
    const selection = normalizeDumpSelection({
      includeTables: ['app.users', 'events'],
      excludeTables: ['audit.events'],
    });
    expect(isTableSelected('app', 'users', selection)).toBe(true);
    expect(isTableSelected('app', 'events', selection)).toBe(true);
    expect(isTableSelected('audit', 'events', selection)).toBe(false);
    expect(isTableSelected('app', 'other', selection)).toBe(false);
  });
});
