/**
 * INSERT literal rendering from PostgreSQL canonical text.
 *
 * Every non-NULL value is emitted as a standard-conforming string literal.
 * PostgreSQL coerces the literal to the target column type while processing
 * the INSERT, so repeating the catalog-formatted type for every value is not
 * necessary.
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
  return text === null ? 'NULL' : quoteStringLiteral(text);
}
