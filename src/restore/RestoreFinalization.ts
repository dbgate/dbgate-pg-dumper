import {
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteRoleName,
  quoteStringLiteral,
} from '../renderer/SqlPrimitives.js';
import type {
  RestoreAclOperation,
  RestoreCommentOperation,
  RestoreDefaultPrivilegeOperation,
  RestoreObjectTarget,
  RestoreOwnershipOperation,
} from './RestoreArchive.js';
import type { RestoreTargetSnapshot } from './RestoreTarget.js';
import type {
  RestoreGrantorPolicy,
  RestoreMissingRolePolicy,
  RestoreRoleMapping,
} from './RestoreTypes.js';

const QUOTE_ALL = { quoteAllIdentifiers: true } as const;
const PRIVILEGES = new Set([
  'ALL',
  'CONNECT',
  'CREATE',
  'DELETE',
  'EXECUTE',
  'INSERT',
  'MAINTAIN',
  'REFERENCES',
  'SELECT',
  'SET',
  'TEMPORARY',
  'TRIGGER',
  'TRUNCATE',
  'UPDATE',
  'USAGE',
]);

export type RestoreRoleResolution =
  | { readonly status: 'public'; readonly sourceRole: 'PUBLIC'; readonly targetRole: 'PUBLIC' }
  | {
      readonly status: 'preserved' | 'mapped' | 'current-user';
      readonly sourceRole: string;
      readonly targetRole: string;
    }
  | {
      readonly status: 'omitted' | 'unresolved';
      readonly sourceRole: string;
      readonly reason: string;
    };

export interface RestoreRoleResolutionContext {
  readonly target: RestoreTargetSnapshot;
  readonly mappings: readonly RestoreRoleMapping[];
  readonly missingRolePolicy: RestoreMissingRolePolicy;
}

export interface RestoreFinalizationSql {
  readonly statements: readonly string[];
  readonly executeAsRole?: string;
}

export function resolveRestoreRole(
  sourceRole: string,
  context: RestoreRoleResolutionContext,
): RestoreRoleResolution {
  if (sourceRole === 'PUBLIC') {
    return { status: 'public', sourceRole: 'PUBLIC', targetRole: 'PUBLIC' };
  }
  const mapping = context.mappings.find((item) => item.sourceRole === sourceRole);
  if (mapping?.action === 'omit') {
    return { status: 'omitted', sourceRole, reason: 'Role mapping explicitly omits this role.' };
  }
  if (mapping?.action === 'current-user') {
    return {
      status: 'current-user',
      sourceRole,
      targetRole: context.target.currentUser.name,
    };
  }
  const targetRole =
    mapping?.action === 'map'
      ? mapping.targetRole
      : mapping?.action === 'preserve'
        ? sourceRole
        : sourceRole;
  if (targetRole !== undefined && context.target.roles.includes(targetRole)) {
    return {
      status: mapping?.action === 'map' ? 'mapped' : 'preserved',
      sourceRole,
      targetRole,
    };
  }
  if (mapping?.action === 'map' && mapping.targetRole === undefined) {
    return { status: 'unresolved', sourceRole, reason: 'Role mapping has no target role.' };
  }
  if (context.missingRolePolicy === 'map-to-current-user') {
    return {
      status: 'current-user',
      sourceRole,
      targetRole: context.target.currentUser.name,
    };
  }
  if (context.missingRolePolicy === 'warn-and-omit') {
    return { status: 'omitted', sourceRole, reason: 'Role is absent on the target.' };
  }
  return { status: 'unresolved', sourceRole, reason: 'Role is absent on the target.' };
}

function qualified(target: RestoreObjectTarget): string {
  return quoteQualifiedIdentifier(
    target.schema === undefined ? [target.name] : [target.schema, target.name],
    QUOTE_ALL,
  );
}

function routineIdentity(target: RestoreObjectTarget): string {
  const argumentsSql = target.identityArguments ?? '';
  if (/;|--|\/\*/u.test(argumentsSql)) throw new TypeError('Unsafe routine identity arguments.');
  return `${qualified(target)}(${argumentsSql})`;
}

function parentIdentity(target: RestoreObjectTarget): string {
  if (target.parent === undefined) throw new TypeError('Metadata target requires a parent object.');
  return quoteQualifiedIdentifier(
    target.parent.schema === undefined
      ? [target.parent.name]
      : [target.parent.schema, target.parent.name],
    QUOTE_ALL,
  );
}

function ownershipIdentity(target: RestoreObjectTarget): string {
  const simple: Readonly<Partial<Record<RestoreObjectTarget['kind'], string>>> = {
    database: 'DATABASE',
    schema: 'SCHEMA',
    table: 'TABLE',
    sequence: 'SEQUENCE',
    view: 'VIEW',
    'materialized-view': 'MATERIALIZED VIEW',
    enum: 'TYPE',
    domain: 'TYPE',
    type: 'TYPE',
    'composite-type': 'TYPE',
    'range-type': 'TYPE',
    'base-type': 'TYPE',
    collation: 'COLLATION',
    conversion: 'CONVERSION',
    'foreign-data-wrapper': 'FOREIGN DATA WRAPPER',
    'foreign-server': 'SERVER',
    'event-trigger': 'EVENT TRIGGER',
    publication: 'PUBLICATION',
    statistics: 'STATISTICS',
  };
  const prefix = simple[target.kind];
  if (prefix !== undefined) return `${prefix} ${qualified(target)}`;
  if (target.kind === 'large-object') {
    if (!/^\d+$/u.test(target.name)) throw new TypeError('Large-object identity must be numeric.');
    return `LARGE OBJECT ${target.name}`;
  }
  if (target.kind === 'function' || target.kind === 'procedure' || target.kind === 'aggregate') {
    return `${target.kind === 'function' ? 'FUNCTION' : target.kind === 'procedure' ? 'PROCEDURE' : 'AGGREGATE'} ${routineIdentity(target)}`;
  }
  if (target.kind === 'operator-class' || target.kind === 'operator-family') {
    if (target.accessMethod === undefined)
      throw new TypeError('Operator metadata requires an access method.');
    return `${target.kind === 'operator-class' ? 'OPERATOR CLASS' : 'OPERATOR FAMILY'} ${qualified(target)} USING ${quoteIdentifier(target.accessMethod, QUOTE_ALL)}`;
  }
  throw new TypeError(`Ownership is not supported for PostgreSQL object kind ${target.kind}.`);
}

function commentIdentity(target: RestoreObjectTarget): string {
  if (target.kind === 'column') {
    return `COLUMN ${parentIdentity(target)}.${quoteIdentifier(target.subName ?? target.name, QUOTE_ALL)}`;
  }
  if (
    target.kind === 'constraint' ||
    target.kind === 'trigger' ||
    target.kind === 'rule' ||
    target.kind === 'policy'
  ) {
    const prefix = target.kind === 'constraint' ? 'CONSTRAINT' : target.kind.toUpperCase();
    return `${prefix} ${quoteIdentifier(target.subName ?? target.name, QUOTE_ALL)} ON ${parentIdentity(target)}`;
  }
  return ownershipIdentity(target);
}

function privilege(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!PRIVILEGES.has(normalized))
    throw new TypeError(`Unsupported PostgreSQL privilege ${value}.`);
  return normalized;
}

function aclTarget(target: RestoreObjectTarget): string {
  if (target.kind === 'column') return `TABLE ${parentIdentity(target)}`;
  if (target.kind === 'table' || target.kind === 'view' || target.kind === 'materialized-view') {
    return `TABLE ${qualified(target)}`;
  }
  if (target.kind === 'function' || target.kind === 'aggregate')
    return `FUNCTION ${routineIdentity(target)}`;
  if (target.kind === 'procedure') return `PROCEDURE ${routineIdentity(target)}`;
  const prefixes: Readonly<Partial<Record<RestoreObjectTarget['kind'], string>>> = {
    database: 'DATABASE',
    schema: 'SCHEMA',
    sequence: 'SEQUENCE',
    domain: 'DOMAIN',
    type: 'TYPE',
    'foreign-data-wrapper': 'FOREIGN DATA WRAPPER',
    'foreign-server': 'FOREIGN SERVER',
    'procedural-language': 'LANGUAGE',
    tablespace: 'TABLESPACE',
    'large-object': 'LARGE OBJECT',
  };
  const prefix = prefixes[target.kind];
  if (prefix === undefined)
    throw new TypeError(`ACL is not supported for PostgreSQL object kind ${target.kind}.`);
  return `${prefix} ${qualified(target)}`;
}

function resolvedName(role: RestoreRoleResolution): string {
  if ('targetRole' in role) return role.targetRole;
  throw new TypeError(`Role ${role.sourceRole} is ${role.status}.`);
}

export function buildOwnershipSql(
  operation: RestoreOwnershipOperation,
  owner: RestoreRoleResolution,
): RestoreFinalizationSql {
  return {
    statements: [
      `ALTER ${ownershipIdentity(operation.target)} OWNER TO ${quoteRoleName(resolvedName(owner), QUOTE_ALL)}`,
    ],
  };
}

export function buildCommentSql(operation: RestoreCommentOperation): RestoreFinalizationSql {
  return {
    statements: [
      `COMMENT ON ${commentIdentity(operation.target)} IS ${operation.text === null ? 'NULL' : quoteStringLiteral(operation.text)}`,
    ],
  };
}

export function buildAclSql(
  operation: RestoreAclOperation,
  grantee: RestoreRoleResolution,
  grantor: RestoreRoleResolution | undefined,
  grantorPolicy: RestoreGrantorPolicy,
): RestoreFinalizationSql {
  const action = operation.action ?? 'grant';
  const column =
    operation.target.kind === 'column'
      ? ` (${quoteIdentifier(operation.target.subName ?? operation.target.name, QUOTE_ALL)})`
      : '';
  const privilegeSql = `${privilege(operation.privilege)}${column}`;
  const granteeSql = quoteRoleName(resolvedName(grantee), QUOTE_ALL);
  const targetSql = aclTarget(operation.target);
  const statements: string[] = [];
  if (operation.baseline === 'exact-new-object')
    statements.push(`REVOKE ALL ON ${targetSql} FROM PUBLIC`);
  if (action === 'grant') {
    statements.push(
      `GRANT ${privilegeSql} ON ${targetSql} TO ${granteeSql}${operation.grantOption ? ' WITH GRANT OPTION' : ''}`,
    );
  } else {
    statements.push(
      `REVOKE ${action === 'revoke-grant-option' ? 'GRANT OPTION FOR ' : ''}${privilegeSql} ON ${targetSql} FROM ${granteeSql}`,
    );
  }
  return {
    statements,
    ...(grantorPolicy === 'preserve-when-possible' && grantor !== undefined
      ? { executeAsRole: resolvedName(grantor) }
      : {}),
  };
}

export function buildDefaultPrivilegeSql(
  operation: RestoreDefaultPrivilegeOperation,
  owner: RestoreRoleResolution,
  grantee: RestoreRoleResolution,
  grantor: RestoreRoleResolution | undefined,
  grantorPolicy: RestoreGrantorPolicy,
): RestoreFinalizationSql {
  const categories = {
    table: 'TABLES',
    sequence: 'SEQUENCES',
    function: 'FUNCTIONS',
    type: 'TYPES',
    schema: 'SCHEMAS',
  } as const;
  const action = operation.action ?? 'grant';
  const prefix = `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteRoleName(resolvedName(owner), QUOTE_ALL)}${operation.schema === undefined ? '' : ` IN SCHEMA ${quoteIdentifier(operation.schema, QUOTE_ALL)}`}`;
  const granteeSql = quoteRoleName(resolvedName(grantee), QUOTE_ALL);
  const command =
    action === 'grant'
      ? `GRANT ${privilege(operation.privilege)} ON ${categories[operation.objectType]} TO ${granteeSql}${operation.grantOption ? ' WITH GRANT OPTION' : ''}`
      : `REVOKE ${action === 'revoke-grant-option' ? 'GRANT OPTION FOR ' : ''}${privilege(operation.privilege)} ON ${categories[operation.objectType]} FROM ${granteeSql}`;
  const executionRole = grantor ?? owner;
  return {
    statements: [`${prefix} ${command}`],
    ...(grantorPolicy === 'preserve-when-possible'
      ? { executeAsRole: resolvedName(executionRole) }
      : {}),
  };
}
