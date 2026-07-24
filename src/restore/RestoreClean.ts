import { quoteIdentifier, quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import type { RestoreObjectTarget } from './RestoreArchive.js';
import type { RestoreExistingObjectConflict } from './RestoreConflicts.js';
import { RestorePlanningError } from './RestoreErrors.js';

const QUOTE_ALL = { quoteAllIdentifiers: true } as const;

function qualified(target: RestoreObjectTarget): string {
  return quoteQualifiedIdentifier(
    target.schema === undefined ? [target.name] : [target.schema, target.name],
    QUOTE_ALL,
  );
}

function parent(target: RestoreObjectTarget): string {
  if (target.parent === undefined) {
    throw new RestorePlanningError(`Drop target ${target.kind} requires a parent identity.`);
  }
  return quoteQualifiedIdentifier(
    target.parent.schema === undefined
      ? [target.parent.name]
      : [target.parent.schema, target.parent.name],
    QUOTE_ALL,
  );
}

function routine(target: RestoreObjectTarget): string {
  const argumentsSql = target.identityArguments ?? '';
  if (/;|--|\/\*/u.test(argumentsSql)) {
    throw new RestorePlanningError('Unsafe routine identity arguments in clean plan.');
  }
  return `${qualified(target)}(${argumentsSql})`;
}

export function buildRestoreDropSql(target: RestoreObjectTarget): string {
  const ordinary: Readonly<Partial<Record<RestoreObjectTarget['kind'], string>>> = {
    schema: 'SCHEMA',
    table: 'TABLE',
    view: 'VIEW',
    'materialized-view': 'MATERIALIZED VIEW',
    sequence: 'SEQUENCE',
    enum: 'TYPE',
    domain: 'DOMAIN',
    type: 'TYPE',
    'composite-type': 'TYPE',
    'range-type': 'TYPE',
    'base-type': 'TYPE',
    index: 'INDEX',
    extension: 'EXTENSION',
    publication: 'PUBLICATION',
    statistics: 'STATISTICS',
    conversion: 'CONVERSION',
    collation: 'COLLATION',
    'event-trigger': 'EVENT TRIGGER',
    'foreign-data-wrapper': 'FOREIGN DATA WRAPPER',
    'foreign-server': 'SERVER',
    'text-search-parser': 'TEXT SEARCH PARSER',
    'text-search-template': 'TEXT SEARCH TEMPLATE',
    'text-search-dictionary': 'TEXT SEARCH DICTIONARY',
    'text-search-configuration': 'TEXT SEARCH CONFIGURATION',
  };
  const prefix = ordinary[target.kind];
  if (prefix !== undefined) return `DROP ${prefix} ${qualified(target)}`;
  if (target.kind === 'function' || target.kind === 'procedure' || target.kind === 'aggregate') {
    const routinePrefix =
      target.kind === 'function'
        ? 'FUNCTION'
        : target.kind === 'procedure'
          ? 'PROCEDURE'
          : 'AGGREGATE';
    return `DROP ${routinePrefix} ${routine(target)}`;
  }
  if (
    target.kind === 'constraint' ||
    target.kind === 'trigger' ||
    target.kind === 'rule' ||
    target.kind === 'policy'
  ) {
    const name = quoteIdentifier(target.subName ?? target.name, QUOTE_ALL);
    if (target.kind === 'constraint')
      return `ALTER TABLE ${parent(target)} DROP CONSTRAINT ${name}`;
    return `DROP ${target.kind.toUpperCase()} ${name} ON ${parent(target)}`;
  }
  throw new RestorePlanningError(`Clean is unsupported for PostgreSQL object kind ${target.kind}.`);
}

export const REPLACE_SAFE_OBJECT_KINDS = new Set<RestoreObjectTarget['kind']>([
  'view',
  'function',
  'procedure',
  'trigger',
  'policy',
  'statistics',
]);

export function conflictSupportsSafeReplacement(conflict: RestoreExistingObjectConflict): boolean {
  return (
    conflict.compatibility === 'compatible' &&
    conflict.classification !== 'extension-managed' &&
    REPLACE_SAFE_OBJECT_KINDS.has(conflict.target.kind)
  );
}
