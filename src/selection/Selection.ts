/**
 * PostgreSQL-aware schema and table selection.
 *
 * Names are normalized as exact PostgreSQL identifiers; no case folding or SQL
 * pattern interpretation is applied. Catalog queries receive arrays as bound
 * parameters, so untrusted names are never interpolated into SQL.
 */

export interface DumpSelection {
  readonly includeSchemas?: readonly string[];
  readonly excludeSchemas?: readonly string[];
  readonly includeTables?: readonly string[];
  readonly excludeTables?: readonly string[];
  readonly includeSystemSchemas?: boolean;
  readonly includeTemporarySchemas?: boolean;
}

export interface NormalizedDumpSelection {
  readonly includeSchemas: readonly string[];
  readonly excludeSchemas: readonly string[];
  readonly includeTables: readonly string[];
  readonly excludeTables: readonly string[];
  readonly includeSystemSchemas: boolean;
  readonly includeTemporarySchemas: boolean;
}

function normalizeNames(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

export function normalizeDumpSelection(selection: DumpSelection = {}): NormalizedDumpSelection {
  return {
    includeSchemas: normalizeNames(selection.includeSchemas),
    excludeSchemas: normalizeNames(selection.excludeSchemas),
    includeTables: normalizeNames(selection.includeTables),
    excludeTables: normalizeNames(selection.excludeTables),
    includeSystemSchemas: selection.includeSystemSchemas ?? false,
    includeTemporarySchemas: selection.includeTemporarySchemas ?? false,
  };
}

export function isSchemaSelected(schemaName: string, selection: NormalizedDumpSelection): boolean {
  if (selection.includeSchemas.length > 0 && !selection.includeSchemas.includes(schemaName)) {
    return false;
  }
  if (selection.excludeSchemas.includes(schemaName)) {
    return false;
  }

  const isTemporary = schemaName.startsWith('pg_temp_') || schemaName.startsWith('pg_toast_temp_');
  if (isTemporary) {
    return selection.includeTemporarySchemas;
  }

  const isSystem =
    schemaName === 'pg_catalog' ||
    schemaName === 'information_schema' ||
    schemaName === 'pg_toast' ||
    schemaName.startsWith('pg_toast_');
  return selection.includeSystemSchemas || !isSystem;
}

/** Parses an exact `schema.table` selection at the first dot. */
export function splitTableSelection(value: string): {
  readonly schema: string | undefined;
  readonly table: string;
} {
  const separator = value.indexOf('.');
  return separator < 0
    ? { schema: undefined, table: value }
    : { schema: value.slice(0, separator), table: value.slice(separator + 1) };
}

export function isTableSelected(
  schemaName: string,
  tableName: string,
  selection: NormalizedDumpSelection,
): boolean {
  const matches = (candidate: string): boolean => {
    const parsed = splitTableSelection(candidate);
    return (
      parsed.table === tableName && (parsed.schema === undefined || parsed.schema === schemaName)
    );
  };
  if (selection.includeTables.length > 0 && !selection.includeTables.some(matches)) {
    return false;
  }
  return !selection.excludeTables.some(matches);
}
