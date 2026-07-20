/**
 * Format-neutral PostgreSQL value classification.
 *
 * Normalization is intentionally shallow: large strings, buffers, arrays, and
 * parsed JSON objects retain their driver-owned references. Serializers may
 * inspect the tag later without forcing a second conversion or a deep copy.
 */

import type { ColumnExportDescriptor, DataExportFormatter } from './DataExportDescriptor.js';

export type PostgresValueKind =
  | 'null'
  | 'boolean'
  | 'integer'
  | 'numeric'
  | 'text'
  | 'uuid'
  | 'json'
  | 'xml'
  | 'binary'
  | 'array'
  | 'enum'
  | 'domain'
  | 'composite'
  | 'range'
  | 'multirange'
  | 'network'
  | 'bit-string'
  | 'timestamp'
  | 'timestamptz'
  | 'date'
  | 'interval'
  | 'money'
  | 'geometric'
  | 'oid'
  | 'unknown';

export interface NormalizedPostgresValue {
  readonly kind: PostgresValueKind;
  readonly typeOid: number;
  readonly formattedType: string;
  /** Exact adapter value. Buffers and containers are not copied. */
  readonly value: unknown;
  readonly binary: boolean;
  /**
   * `canonical-text` means PostgreSQL, rather than JavaScript or the adapter,
   * produced the value. Serializers may pass that text to PostgreSQL input
   * functions without lossy Date, Number, JSON, array, or range conversion.
   */
  readonly representation: 'canonical-text' | 'native';
}

const INTEGER_OIDS = new Set([20, 21, 23]);
const NUMERIC_OIDS = new Set([700, 701, 790, 1700]);
const TEXT_OIDS = new Set([18, 19, 25, 1042, 1043]);
const JSON_OIDS = new Set([114, 3802]);
const NETWORK_OIDS = new Set([650, 829, 869, 774]);
const BIT_OIDS = new Set([1560, 1562]);
const OID_OIDS = new Set([26, 27, 28, 29, 30, 2202, 2203, 2204, 2205, 2206]);
const TEMPORAL_OIDS = new Set([1082, 1083, 1114, 1184, 1186, 1266]);

export function inferExportFormatter(typeOid: number, formattedType: string): DataExportFormatter {
  const type = formattedType.toLowerCase();
  if (typeOid === 16) return 'boolean';
  if (INTEGER_OIDS.has(typeOid) || OID_OIDS.has(typeOid)) return 'integer';
  if (NUMERIC_OIDS.has(typeOid)) return 'numeric';
  if (typeOid === 17) return 'binary';
  if (JSON_OIDS.has(typeOid)) return 'json';
  if (TEMPORAL_OIDS.has(typeOid)) return 'temporal';
  if (NETWORK_OIDS.has(typeOid)) return 'network';
  if (BIT_OIDS.has(typeOid)) return 'bit-string';
  if (type.endsWith('[]') || (typeOid >= 1000 && typeOid <= 1034)) return 'array';
  if (type.includes('multirange') || type.endsWith('range')) return 'range';
  if (TEXT_OIDS.has(typeOid) || typeOid === 2950 || typeOid === 142) return 'text';
  return 'other';
}

export class PostgresValueNormalizer {
  normalize(
    value: unknown,
    column: ColumnExportDescriptor,
    representation: NormalizedPostgresValue['representation'] = 'native',
  ): NormalizedPostgresValue {
    const kind = this.kind(value, column);
    return {
      kind,
      typeOid: column.typeOid,
      formattedType: column.formattedType,
      value,
      binary: kind === 'binary',
      representation,
    };
  }

  private kind(value: unknown, column: ColumnExportDescriptor): PostgresValueKind {
    if (value === null || value === undefined) return 'null';
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || this.isBinaryStream(value)) {
      return 'binary';
    }

    const type = column.formattedType.toLowerCase();
    if (column.typeCategory === 'enum') return 'enum';
    if (column.typeCategory === 'domain') return 'domain';
    if (column.typeCategory === 'composite') return 'composite';
    if (column.typeCategory === 'range') return 'range';
    if (column.typeCategory === 'multirange') return 'multirange';
    if (column.typeOid === 17) return 'binary';
    if (column.typeOid === 16) return 'boolean';
    if (OID_OIDS.has(column.typeOid)) return 'oid';
    if (INTEGER_OIDS.has(column.typeOid)) return 'integer';
    if (NUMERIC_OIDS.has(column.typeOid)) return column.typeOid === 790 ? 'money' : 'numeric';
    if (column.typeOid === 2950) return 'uuid';
    if (JSON_OIDS.has(column.typeOid)) return 'json';
    if (column.typeOid === 142) return 'xml';
    if (column.typeOid === 1082) return 'date';
    if (column.typeOid === 1114) return 'timestamp';
    if (column.typeOid === 1184) return 'timestamptz';
    if (column.typeOid === 1186) return 'interval';
    if (NETWORK_OIDS.has(column.typeOid)) return 'network';
    if (BIT_OIDS.has(column.typeOid)) return 'bit-string';
    if (Array.isArray(value) || column.formatter === 'array') return 'array';
    if (type.includes('multirange')) return 'multirange';
    if (type.endsWith('range')) return 'range';
    if (/^(point|line|lseg|box|path|polygon|circle)\b/u.test(type)) return 'geometric';
    if (column.formatter === 'composite' || this.isPlainObject(value)) return 'composite';
    if (column.formatter === 'text' || TEXT_OIDS.has(column.typeOid)) return 'text';
    return 'unknown';
  }

  private isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isBinaryStream(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as { readonly pipe?: unknown; readonly read?: unknown };
    return typeof candidate.pipe === 'function' && typeof candidate.read === 'function';
  }
}
