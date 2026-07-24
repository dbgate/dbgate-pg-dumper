import { quoteIdentifier, quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import type {
  RestoreArchiveEntry,
  RestoreArchiveOperation,
  RestoreObjectTarget,
  RestoreSqlFragment,
} from './RestoreArchive.js';
import type {
  RestoreOptions,
  RestoreSchemaMapping,
  RestoreTablespaceMapping,
} from './RestoreTypes.js';

const QUOTE_ALL = { quoteAllIdentifiers: true } as const;

export type ResolvedRestoreSchema =
  | {
      readonly kind: 'preserved' | 'mapped';
      readonly sourceSchema: string;
      readonly targetSchema: string;
    }
  | {
      readonly kind: 'omitted' | 'unresolved';
      readonly sourceSchema: string;
      readonly reason: string;
    };

export type ResolvedRestoreTablespace =
  | {
      readonly kind: 'preserved' | 'mapped';
      readonly sourceTablespace: string;
      readonly targetTablespace: string;
    }
  | {
      readonly kind: 'omitted' | 'default-target' | 'unresolved';
      readonly sourceTablespace: string;
      readonly reason: string;
    };

export interface RestoreMappingContext {
  readonly options: RestoreOptions;
  readonly availableSchemas?: ReadonlySet<string>;
  readonly availableTablespaces?: ReadonlySet<string>;
  readonly protectedSchemas?: ReadonlySet<string>;
}

export function isProtectedRestoreSchema(
  schema: string,
  additional: ReadonlySet<string> = new Set(),
): boolean {
  return (
    schema === 'pg_catalog' ||
    schema === 'information_schema' ||
    schema.startsWith('pg_toast') ||
    schema.startsWith('pg_temp') ||
    additional.has(schema)
  );
}

export function resolveRestoreSchema(
  sourceSchema: string,
  context: RestoreMappingContext,
): ResolvedRestoreSchema {
  const mapping = context.options.schemaMappings.find(
    (item: RestoreSchemaMapping) => item.sourceSchema === sourceSchema,
  );
  const protectedSchema = isProtectedRestoreSchema(
    sourceSchema,
    context.protectedSchemas ?? new Set(),
  );
  if (protectedSchema) {
    if (
      mapping?.action === 'map' ||
      mapping?.action === 'omit' ||
      context.options.schemaMappingPolicy === 'single-target-schema'
    ) {
      return {
        kind: 'unresolved',
        sourceSchema,
        reason: 'System, temporary, TOAST, or extension-managed schemas cannot be remapped.',
      };
    }
    return { kind: 'preserved', sourceSchema, targetSchema: sourceSchema };
  }
  if (mapping?.action === 'omit') {
    return {
      kind: 'omitted',
      sourceSchema,
      reason: 'Schema mapping explicitly omits this schema.',
    };
  }
  let targetSchema = sourceSchema;
  if (context.options.schemaMappingPolicy === 'single-target-schema') {
    if (
      context.options.singleTargetSchema === undefined ||
      context.options.singleTargetSchema === ''
    ) {
      return {
        kind: 'unresolved',
        sourceSchema,
        reason: 'single-target-schema requires a non-empty singleTargetSchema.',
      };
    }
    targetSchema = context.options.singleTargetSchema;
  } else if (context.options.schemaMappingPolicy === 'explicit' && mapping?.action === 'map') {
    if (mapping.targetSchema === undefined || mapping.targetSchema === '') {
      return { kind: 'unresolved', sourceSchema, reason: 'Schema mapping has no target schema.' };
    }
    targetSchema = mapping.targetSchema;
  }
  return targetSchema === sourceSchema
    ? { kind: 'preserved', sourceSchema, targetSchema }
    : { kind: 'mapped', sourceSchema, targetSchema };
}

export function resolveRestoreTablespace(
  sourceTablespace: string,
  context: RestoreMappingContext,
): ResolvedRestoreTablespace {
  if (context.options.tablespaceMappingPolicy === 'omit') {
    return { kind: 'omitted', sourceTablespace, reason: 'Tablespace clauses are omitted.' };
  }
  if (context.options.tablespaceMappingPolicy === 'default-target') {
    return {
      kind: 'default-target',
      sourceTablespace,
      reason: 'The target database default tablespace is used.',
    };
  }
  const mapping = context.options.tablespaceMappings.find(
    (item: RestoreTablespaceMapping) => item.sourceTablespace === sourceTablespace,
  );
  if (mapping?.action === 'omit') {
    return { kind: 'omitted', sourceTablespace, reason: 'Tablespace mapping omits this clause.' };
  }
  const targetTablespace = mapping?.action === 'map' ? mapping.targetTablespace : sourceTablespace;
  if (targetTablespace === undefined || targetTablespace === '') {
    return {
      kind: 'unresolved',
      sourceTablespace,
      reason: 'Tablespace mapping has no target tablespace.',
    };
  }
  if (
    context.availableTablespaces !== undefined &&
    !context.availableTablespaces.has(targetTablespace)
  ) {
    return {
      kind: 'unresolved',
      sourceTablespace,
      reason: 'The resolved tablespace is unavailable on the target.',
    };
  }
  return targetTablespace === sourceTablespace
    ? { kind: 'preserved', sourceTablespace, targetTablespace }
    : { kind: 'mapped', sourceTablespace, targetTablespace };
}

export function mapRestoreObjectTarget(
  target: RestoreObjectTarget,
  context: RestoreMappingContext,
): RestoreObjectTarget | undefined {
  const mapSchema = (schema: string | undefined): string | undefined => {
    if (schema === undefined) return undefined;
    const resolution = resolveRestoreSchema(schema, context);
    return 'targetSchema' in resolution ? resolution.targetSchema : undefined;
  };
  const mappedSchema = target.kind === 'schema' ? mapSchema(target.name) : mapSchema(target.schema);
  if ((target.kind === 'schema' || target.schema !== undefined) && mappedSchema === undefined) {
    return undefined;
  }
  let parent: RestoreObjectTarget['parent'];
  if (target.parent !== undefined) {
    const parentSchema = mapSchema(target.parent.schema);
    if (target.parent.schema !== undefined && parentSchema === undefined) return undefined;
    parent = {
      ...target.parent,
      ...(parentSchema === undefined ? {} : { schema: parentSchema }),
    };
  }
  return {
    ...target,
    ...(target.kind === 'schema'
      ? { name: mappedSchema! }
      : target.schema === undefined
        ? {}
        : { schema: mappedSchema! }),
    ...(parent === undefined ? {} : { parent }),
  };
}

function renderStructuredFragments(
  fragments: readonly RestoreSqlFragment[],
  context: RestoreMappingContext,
): string | undefined {
  const rendered: string[] = [];
  for (const fragment of fragments) {
    if (fragment.kind === 'sql') {
      rendered.push(fragment.text);
      continue;
    }
    if (fragment.kind === 'tablespace' || fragment.kind === 'tablespace-clause') {
      const resolution = resolveRestoreTablespace(fragment.name, context);
      if (resolution.kind === 'unresolved') return undefined;
      if ('targetTablespace' in resolution) {
        const identifier = quoteIdentifier(resolution.targetTablespace, QUOTE_ALL);
        rendered.push(
          fragment.kind === 'tablespace-clause' ? ` TABLESPACE ${identifier}` : identifier,
        );
      }
      continue;
    }
    const parts = [...fragment.parts];
    if (fragment.schemaPart !== undefined) {
      const sourceSchema = parts[fragment.schemaPart];
      if (sourceSchema === undefined) return undefined;
      const resolution = resolveRestoreSchema(sourceSchema, context);
      if (!('targetSchema' in resolution)) return undefined;
      parts[fragment.schemaPart] = resolution.targetSchema;
    }
    rendered.push(quoteQualifiedIdentifier(parts, QUOTE_ALL));
  }
  return rendered.join('');
}

export function mapRestoreArchiveEntry(
  entry: RestoreArchiveEntry,
  context: RestoreMappingContext,
): RestoreArchiveEntry | undefined {
  const operation = entry.operation;
  let mapped: RestoreArchiveOperation;
  if (operation.kind === 'table-data') {
    const schema = resolveRestoreSchema(operation.table.schema, context);
    if (!('targetSchema' in schema)) return undefined;
    mapped = { ...operation, table: { ...operation.table, schema: schema.targetSchema } };
  } else if (operation.kind === 'sequence-state') {
    const schema = resolveRestoreSchema(operation.schema, context);
    if (!('targetSchema' in schema)) return undefined;
    const ownedSchema =
      operation.ownedBy === undefined
        ? undefined
        : resolveRestoreSchema(operation.ownedBy.schema, context);
    if (ownedSchema !== undefined && !('targetSchema' in ownedSchema)) return undefined;
    mapped = {
      ...operation,
      schema: schema.targetSchema,
      ...(operation.ownedBy === undefined
        ? {}
        : {
            ownedBy: {
              ...operation.ownedBy,
              schema: (ownedSchema as Extract<ResolvedRestoreSchema, { targetSchema: string }>)
                .targetSchema,
            },
          }),
    };
  } else if (
    operation.kind === 'ownership' ||
    operation.kind === 'comment' ||
    operation.kind === 'acl'
  ) {
    const target = mapRestoreObjectTarget(operation.target, context);
    if (target === undefined) return undefined;
    mapped = { ...operation, target };
  } else if (operation.kind === 'default-privilege') {
    if (operation.schema === undefined) mapped = operation;
    else {
      const schema = resolveRestoreSchema(operation.schema, context);
      if (!('targetSchema' in schema)) return undefined;
      mapped = { ...operation, schema: schema.targetSchema };
    }
  } else {
    const target =
      operation.target === undefined
        ? undefined
        : mapRestoreObjectTarget(operation.target, context);
    if (operation.target !== undefined && target === undefined) return undefined;
    const sql =
      operation.structuredFragments === undefined
        ? operation.sql
        : renderStructuredFragments(operation.structuredFragments, context);
    if (sql === undefined) return undefined;
    const tablespaceResolution =
      operation.tablespace === undefined
        ? undefined
        : resolveRestoreTablespace(operation.tablespace, context);
    mapped = {
      ...operation,
      sql,
      ...(target === undefined ? {} : { target }),
      ...(tablespaceResolution !== undefined && 'targetTablespace' in tablespaceResolution
        ? { tablespace: tablespaceResolution.targetTablespace }
        : {}),
    };
  }
  const mappedSchema =
    entry.objectType === 'schema'
      ? resolveRestoreSchema(entry.objectIdentity ?? '', context)
      : undefined;
  return {
    ...entry,
    operation: mapped,
    ...(mappedSchema !== undefined && 'targetSchema' in mappedSchema
      ? { objectIdentity: mappedSchema.targetSchema }
      : {}),
  };
}

export function restoreEntryTarget(entry: RestoreArchiveEntry): RestoreObjectTarget | undefined {
  const operation = entry.operation;
  if (operation.kind === 'table-data') {
    return { kind: 'table', schema: operation.table.schema, name: operation.table.table };
  }
  if (operation.kind === 'sequence-state') {
    return { kind: 'sequence', schema: operation.schema, name: operation.sequence };
  }
  if (operation.kind === 'ownership' || operation.kind === 'comment' || operation.kind === 'acl') {
    return operation.target;
  }
  if (operation.kind === 'sql') return operation.target;
  return undefined;
}

export function restoreTargetIdentity(target: RestoreObjectTarget): string {
  const name = target.schema === undefined ? target.name : `${target.schema}.${target.name}`;
  const routine =
    target.kind === 'function' || target.kind === 'procedure' || target.kind === 'aggregate'
      ? `(${target.identityArguments ?? ''})`
      : '';
  const child = target.parent === undefined ? '' : ` ON ${restoreTargetIdentity(target.parent)}`;
  return `${target.kind}:${name}${routine}${target.subName === undefined ? '' : `:${target.subName}`}${child}`;
}
