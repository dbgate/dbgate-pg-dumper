import type { PostgresDatabase } from '../../../src/index.js';

export type DifferenceClassification =
  | 'semantic schema difference'
  | 'semantic data difference'
  | 'sequence-state difference'
  | 'ownership or ACL difference'
  | 'formatting-only difference'
  | 'expected version normalization'
  | 'environment-dependent difference'
  | 'unsupported feature'
  | 'nondeterministic output defect';

export interface ComparisonDifference {
  readonly objectIdentity: string;
  readonly propertyPath: string;
  readonly sourceValue: unknown;
  readonly restoredValue: unknown;
  readonly classification: DifferenceClassification;
}

const environmentKeys = new Set([
  'oid',
  'relationOid',
  'tableOid',
  'typeOid',
  'baseTypeOid',
  'backingIndexOid',
  'parentIndexOid',
  'parentConstraintOid',
  'defaultPartitionOid',
  'estimatedRowCount',
]);

export interface ModelNormalizationOptions {
  readonly includeSequenceState?: boolean;
  readonly includeComments?: boolean;
  readonly includeRoles?: boolean;
}

export function normalizeDatabaseModel(
  database: PostgresDatabase,
  options: ModelNormalizationOptions = {},
): unknown {
  return normalizeValue(database, options, true);
}

function normalizeValue(
  value: unknown,
  options: ModelNormalizationOptions,
  databaseRoot = false,
  sequence = false,
  collection?: string,
): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeValue(item, options, false, sequence));
    // Comments are a catalog set. PostgreSQL may return them in OID order,
    // which legitimately changes after a dump is restored into a new database.
    if (collection === 'comments') {
      normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return normalized;
  }
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const databaseReference = record.kind === 'database';
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (environmentKeys.has(key) || key.endsWith('Oid')) continue;
    if ((databaseRoot || databaseReference) && key === 'name') continue;
    if (
      databaseRoot &&
      options.includeRoles !== true &&
      (key === 'roles' || key === 'roleMemberships')
    ) {
      continue;
    }
    if (options.includeComments === false && (key === 'comment' || key === 'comments')) continue;
    if (
      sequence &&
      options.includeSequenceState === false &&
      (key === 'currentValue' || key === 'isCalled')
    ) {
      continue;
    }
    result[key] = normalizeValue(item, options, false, key === 'sequences', key);
  }
  return result;
}

export function compareDatabaseModels(
  source: PostgresDatabase,
  restored: PostgresDatabase,
  options: ModelNormalizationOptions = {},
): readonly ComparisonDifference[] {
  const differences: ComparisonDifference[] = [];
  compareValue(
    normalizeDatabaseModel(source, options),
    normalizeDatabaseModel(restored, options),
    '$',
    'database',
    differences,
  );
  return differences;
}

function compareValue(
  source: unknown,
  restored: unknown,
  path: string,
  identity: string,
  differences: ComparisonDifference[],
): void {
  if (Object.is(source, restored)) return;
  if (Array.isArray(source) && Array.isArray(restored)) {
    const sourceItems = source as readonly unknown[];
    const restoredItems = restored as readonly unknown[];
    const count = Math.max(sourceItems.length, restoredItems.length);
    for (let index = 0; index < count; index += 1) {
      const sourceItem: unknown = sourceItems[index];
      const restoredItem: unknown = restoredItems[index];
      const itemIdentity = objectIdentity(sourceItem) ?? objectIdentity(restoredItem) ?? identity;
      compareValue(
        sourceItem,
        restoredItem,
        `${path}[${String(index)}]`,
        itemIdentity,
        differences,
      );
    }
    return;
  }
  if (
    source !== null &&
    restored !== null &&
    typeof source === 'object' &&
    typeof restored === 'object'
  ) {
    const keys = new Set([...Object.keys(source), ...Object.keys(restored)]);
    const nextIdentity = objectIdentity(source) ?? objectIdentity(restored) ?? identity;
    for (const key of [...keys].sort()) {
      compareValue(
        (source as Record<string, unknown>)[key],
        (restored as Record<string, unknown>)[key],
        `${path}.${key}`,
        nextIdentity,
        differences,
      );
    }
    return;
  }
  differences.push({
    objectIdentity: identity,
    propertyPath: path,
    sourceValue: source,
    restoredValue: restored,
    classification: classifyPath(path),
  });
}

function objectIdentity(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== 'string') return undefined;
  return `${typeof item.schema === 'string' ? `${item.schema}.` : ''}${item.name}${
    typeof item.subName === 'string' ? `(${item.subName})` : ''
  }`;
}

function classifyPath(path: string): DifferenceClassification {
  if (/\.(?:owner|ownerships|accessControls|defaultPrivileges|roles|roleMemberships)/u.test(path)) {
    return 'ownership or ACL difference';
  }
  if (/sequences/u.test(path) && /\.(?:currentValue|isCalled)/u.test(path)) {
    return 'sequence-state difference';
  }
  return 'semantic schema difference';
}
