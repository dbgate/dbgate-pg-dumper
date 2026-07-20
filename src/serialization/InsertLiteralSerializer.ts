/**
 * INSERT literal rendering from PostgreSQL canonical text.
 *
 * Every non-NULL value is a standard-conforming string literal followed by
 * its catalog-formatted type cast. This delegates parsing to PostgreSQL's
 * input function and avoids ambiguous unknown literals or JavaScript-derived
 * numeric, temporal, JSON, array, enum, domain, range, and geometric syntax.
 */

import type { ColumnExportDescriptor } from '../data/DataExportDescriptor.js';
import type { NormalizedPostgresValue } from '../data/PostgresValueNormalizer.js';
import { quoteStringLiteral } from '../renderer/SqlPrimitives.js';
import { postgresTextValue } from './PostgresTextValue.js';

export function renderInsertLiteral(
  value: NormalizedPostgresValue,
  column: ColumnExportDescriptor,
): string {
  const text = postgresTextValue(value, column);
  return text === null ? 'NULL' : `${quoteStringLiteral(text)}::${column.formattedType}`;
}
