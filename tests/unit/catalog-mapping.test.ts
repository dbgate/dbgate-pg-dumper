import { describe, expect, it } from 'vitest';

import {
  mapColumnCatalogRow,
  mapPersistence,
  mapReplicaIdentity,
  mapTableKind,
  type ColumnCatalogRow,
} from '../../src/introspection/catalogTypes.js';

function column(overrides: Partial<ColumnCatalogRow> = {}): ColumnCatalogRow {
  return {
    table_oid: 42,
    attribute_number: 3,
    column_name: 'Display Name',
    formatted_type: 'character varying(100)',
    type_oid: 1043,
    type_modifier: 104,
    type_kind: 'b',
    not_null: true,
    default_expression: "'unknown'::character varying",
    identity_mode: '',
    generated_mode: '',
    collation_schema: 'pg_catalog',
    collation_name: 'C',
    compression: null,
    storage_mode: 'x',
    default_storage_mode: 'p',
    is_dropped: false,
    ...overrides,
  };
}

describe('catalog row mapping', () => {
  it('maps table kinds and persistence flags', () => {
    expect(mapTableKind('r', false)).toBe('ordinary');
    expect(mapTableKind('p', false)).toBe('partitioned');
    expect(mapTableKind('r', true)).toBe('partition');
    expect(mapTableKind('f', false)).toBe('foreign');
    expect(mapPersistence('u')).toBe('unlogged');
    expect(mapPersistence('t')).toBe('temporary');
    expect(mapReplicaIdentity('d')).toBe('default');
    expect(mapReplicaIdentity('n')).toBe('nothing');
    expect(mapReplicaIdentity('f')).toBe('full');
    expect(mapReplicaIdentity('i')).toBe('index');
  });

  it('marks inherited collation and storage defaults without discarding their effective values', () => {
    expect(
      mapColumnCatalogRow(
        column({
          collation_is_default: true,
          storage_mode: 'x',
          default_storage_mode: 'x',
        }),
      ),
    ).toMatchObject({
      column: {
        collation: '"pg_catalog"."C"',
        collationIsDefault: true,
        storage: 'extended',
        storageIsDefault: true,
      },
    });
  });

  it('maps visible columns while retaining physical attribute numbers', () => {
    expect(mapColumnCatalogRow(column())).toMatchObject({
      tableOid: 42,
      attributeNumber: 3,
      isDropped: false,
      column: {
        ordinalPosition: 3,
        nullable: false,
        storage: 'extended',
        collation: '"pg_catalog"."C"',
      },
    });
  });

  it('retains dropped attributes internally without exposing a column', () => {
    expect(mapColumnCatalogRow(column({ is_dropped: true }))).toEqual({
      tableOid: 42,
      attributeNumber: 3,
      isDropped: true,
    });
  });
});
