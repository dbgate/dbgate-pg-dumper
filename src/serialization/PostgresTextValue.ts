/**
 * Safe conversion from normalized values to PostgreSQL canonical text.
 *
 * Production cursor reads arrive as `canonical-text`. Native conversion is
 * intentionally limited to provably lossless primitives for adapter tests and
 * custom connection implementations. Parsed Date, JSON, arrays, composites,
 * ranges, and unsafe Numbers are rejected instead of silently corrupted.
 */

import type { ColumnExportDescriptor } from '../data/DataExportDescriptor.js';
import type { NormalizedPostgresValue } from '../data/PostgresValueNormalizer.js';

export function postgresTextValue(
  normalized: NormalizedPostgresValue,
  column: ColumnExportDescriptor,
): string | null {
  if (normalized.kind === 'null' || normalized.value === null || normalized.value === undefined) {
    return null;
  }
  const value = normalized.value;
  if (normalized.representation === 'canonical-text') {
    if (typeof value !== 'string') {
      throw new TypeError('A canonical PostgreSQL text value was not returned as a string.');
    }
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `\\x${Buffer.from(value).toString('hex')}`;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) {
    return String(value);
  }
  throw new TypeError(
    `Native ${column.formattedType} values cannot be serialized without a lossless PostgreSQL text representation.`,
  );
}

export function safelyDescribeValue(value: unknown, maximumLength = 96): string {
  let description: string;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    description = `<binary ${value.byteLength} bytes>`;
  } else if (typeof value === 'string') {
    description = value;
  } else {
    description = Object.prototype.toString.call(value);
  }
  return description.length <= maximumLength
    ? description
    : `${description.slice(0, maximumLength)}…`;
}
