/**
 * Unit coverage for PostgreSQL-specific identifier and literal boundaries.
 *
 * Catalog expressions deliberately bypass these helpers; every value exercised
 * here represents an identifier or scalar value supplied to generated SQL.
 */

import { describe, expect, it } from 'vitest';

import {
  chooseDollarQuoteTag,
  dollarQuote,
  quoteEscapedStringLiteral,
  quoteIdentifier,
  quoteOperatorName,
  quoteQualifiedIdentifier,
  quoteRoleName,
  quoteStringLiteral,
  renderSqlLiteral,
} from '../../src/index.js';

describe('PostgreSQL SQL primitives', () => {
  it.each([
    ['ordinary_name', 'ordinary_name'],
    ['select', '"select"'],
    ['MixedCase', '"MixedCase"'],
    ['has space', '"has space"'],
    ['embedded"quote', '"embedded""quote"'],
    ['žluťoučký', 'žluťoučký'],
    ['Δelta', '"Δelta"'],
  ])('quotes identifier %s as %s', (input, expected) => {
    expect(quoteIdentifier(input)).toBe(expected);
  });

  it('supports qualified and quote-all identifier policies', () => {
    expect(quoteQualifiedIdentifier(['app', 'Order'])).toBe('app."Order"');
    expect(quoteQualifiedIdentifier(['app', 'items'], { quoteAllIdentifiers: true })).toBe(
      '"app"."items"',
    );
  });

  it('renders role and operator names with PostgreSQL-specific rules', () => {
    expect(quoteRoleName('PUBLIC')).toBe('PUBLIC');
    expect(quoteRoleName('report reader')).toBe('"report reader"');
    expect(quoteOperatorName('custom', '->>')).toBe('OPERATOR(custom.->>)');
    expect(() => quoteOperatorName(undefined, 'not an operator')).toThrow(TypeError);
  });

  it('escapes ordinary and E-prefixed string literals deterministically', () => {
    expect(quoteStringLiteral('first\r\nsecond')).toBe("E'first\\r\\nsecond'");
    expect(quoteStringLiteral("O'Reilly\\notes\nž")).toBe("'O''Reilly\\notes\nž'");
    expect(quoteEscapedStringLiteral("O'Reilly\\notes\n\t")).toBe("E'O''Reilly\\\\notes\\n\\t'");
  });

  it('renders scalar literals without unsafe interpolation', () => {
    expect([null, true, false, 12.5, 42n, "x'y"].map((value) => renderSqlLiteral(value))).toEqual([
      'NULL',
      'TRUE',
      'FALSE',
      '12.5',
      '42',
      "'x''y'",
    ]);
    expect(() => renderSqlLiteral(Number.NaN)).toThrow(TypeError);
  });

  it('selects a dollar tag absent from the routine body', () => {
    const body = 'BEGIN\n  RAISE NOTICE $function$inside$function$;\nEND';
    expect(chooseDollarQuoteTag(body)).toBe('$function_1$');
    expect(dollarQuote('return 1', 'sql-body')).toBe('$sql_body$return 1$sql_body$');
  });
});
