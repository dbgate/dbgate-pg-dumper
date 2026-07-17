/**
 * PostgreSQL-specific identifier and literal rendering.
 *
 * The keyword set is the conservative union of reserved words relevant to
 * PostgreSQL 9.6 through 18. Catalog SQL expressions are not passed through
 * these helpers; only identifiers and scalar literal values are.
 */

export type SqlKeywordCase = 'upper' | 'lower';

const RESERVED_KEYWORDS = new Set(
  `
  all analyse analyze and any array as asc asymmetric authorization binary both
  case cast check collate collate column concurrently constraint create
  cross current_catalog current_date current_role current_schema current_time
  current_timestamp current_user default deferrable desc distinct do else end
  except false fetch for foreign freeze from full grant group having ilike in
  initially inner intersect into is isnull join lateral leading left like
  limit localtime localtimestamp natural not notnull null offset on only or
  order outer overlaps placing primary references returning right select
  session_user similar some symmetric table tablesample then to trailing true
  union unique user using variadic verbose when where window with
  `
    .trim()
    .split(/\s+/u)
    .map((value) => value.toLowerCase()),
);

export interface IdentifierQuotingPolicy {
  readonly quoteAllIdentifiers: boolean;
}

export const DEFAULT_IDENTIFIER_QUOTING: IdentifierQuotingPolicy = {
  quoteAllIdentifiers: false,
};

export function quoteIdentifier(
  value: string,
  policy: IdentifierQuotingPolicy = DEFAULT_IDENTIFIER_QUOTING,
): string {
  const safe = /^[\p{Ll}_][\p{L}\p{N}_$]*$/u.test(value);
  if (policy.quoteAllIdentifiers || !safe || RESERVED_KEYWORDS.has(value.toLowerCase())) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function quoteQualifiedIdentifier(
  parts: readonly string[],
  policy: IdentifierQuotingPolicy = DEFAULT_IDENTIFIER_QUOTING,
): string {
  return parts.map((part) => quoteIdentifier(part, policy)).join('.');
}

export function quoteRoleName(
  value: string,
  policy: IdentifierQuotingPolicy = DEFAULT_IDENTIFIER_QUOTING,
): string {
  return value === 'PUBLIC' ? 'PUBLIC' : quoteIdentifier(value, policy);
}

export function quoteOperatorName(
  schema: string | undefined,
  operator: string,
  policy: IdentifierQuotingPolicy = DEFAULT_IDENTIFIER_QUOTING,
): string {
  const operatorPattern = /^[+\-*/<>=~!@#%^&|`?]+$/u;
  if (!operatorPattern.test(operator)) {
    throw new TypeError('Invalid PostgreSQL operator name.');
  }
  return schema === undefined
    ? `OPERATOR(${operator})`
    : `OPERATOR(${quoteIdentifier(schema, policy)}.${operator})`;
}

export function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteEscapedStringLiteral(value: string): string {
  return `E'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "''")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')}'`;
}

export function renderSqlLiteral(value: string | number | bigint | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers are not SQL literals.');
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  return quoteStringLiteral(value);
}

export function chooseDollarQuoteTag(body: string, preferred = 'function'): string {
  const normalized = preferred.replaceAll(/[^a-zA-Z0-9_]/gu, '_') || 'body';
  for (let index = 0; ; index += 1) {
    const tag = index === 0 ? `$${normalized}$` : `$${normalized}_${index}$`;
    if (!body.includes(tag)) return tag;
  }
}

export function dollarQuote(body: string, preferred?: string): string {
  const tag = chooseDollarQuoteTag(body, preferred);
  return `${tag}${body}${tag}`;
}

export function keyword(value: string, casing: SqlKeywordCase): string {
  return casing === 'upper' ? value.toUpperCase() : value.toLowerCase();
}

export function ensureStatement(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}
