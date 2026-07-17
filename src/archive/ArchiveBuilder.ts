/**
 * Converts the normalized PostgreSQL model into archive entries.
 *
 * Entry construction and semantic dependency discovery happen in two passes:
 * every identity is registered first, then references are resolved. This keeps
 * dependency behavior independent of source array order.
 */

import type { PostgresColumn, PostgresDatabase, PostgresTable } from '../model/PostgresDatabase.js';
import type {
  PostgresAccessControlEntry,
  PostgresComment,
  PostgresDefaultPrivilege,
  PostgresOwnership,
} from '../model/PostgresHigherLevelObjects.js';
import type {
  PostgresConstraint,
  PostgresObjectReference,
  PostgresStructuralObject,
} from '../model/PostgresStructuralObjects.js';
import { createArchiveIdentity, createDumpId } from './ArchiveIdentity.js';
import type {
  ArchiveBuildOptions,
  ArchiveDependency,
  ArchiveDependencySource,
  ArchiveDependencyStrength,
  ArchiveDiagnostic,
  ArchiveEntry,
  ArchiveExtensionMember,
  ArchiveObjectType,
} from './ArchiveTypes.js';
import { assignDumpSection } from './SectionRules.js';

interface MutableEntry {
  readonly dumpId: string;
  readonly archiveIdentity: string;
  readonly catalogOid?: number;
  readonly objectType: ArchiveObjectType;
  readonly schema?: string;
  readonly name: string;
  readonly specificIdentity: string;
  readonly parent?: PostgresObjectReference;
  readonly owner?: string;
  readonly section: ArchiveEntry['section'];
  readonly sourceObject: unknown;
  readonly createMetadata?: Readonly<Record<string, unknown>>;
  readonly dropMetadata?: Readonly<Record<string, unknown>>;
  readonly commentMetadata?: Readonly<Record<string, unknown>>;
  readonly aclMetadata?: Readonly<Record<string, unknown>>;
  readonly dataExport?: ArchiveEntry['dataExport'];
  extensionMembership?: ArchiveEntry['extensionMembership'];
  readonly dependencies: Map<string, ArchiveDependency>;
  readonly diagnostics: ArchiveDiagnostic[];
}

interface AddEntryInput {
  readonly objectType: ArchiveObjectType;
  readonly schema?: string;
  readonly name: string;
  readonly specificIdentity?: string;
  readonly parent?: PostgresObjectReference;
  readonly owner?: string;
  readonly catalogOid?: number;
  readonly sourceObject: unknown;
  readonly createMetadata?: Readonly<Record<string, unknown>>;
  readonly dropMetadata?: Readonly<Record<string, unknown>>;
  readonly commentMetadata?: Readonly<Record<string, unknown>>;
  readonly aclMetadata?: Readonly<Record<string, unknown>>;
  readonly dataExport?: ArchiveEntry['dataExport'];
}

type AddEntry = (input: AddEntryInput) => MutableEntry | undefined;

export interface ArchiveBuildResult {
  readonly entries: readonly ArchiveEntry[];
  readonly diagnostics: readonly ArchiveDiagnostic[];
}

function referenceKey(reference: PostgresObjectReference): string {
  return `${reference.kind}:${reference.oid}:${reference.subName ?? ''}`;
}

function catalogKey(kind: string, oid: number, subName = ''): string {
  return `${kind}:${oid}:${subName}`;
}

function relationParent(table: PostgresTable): PostgresObjectReference {
  return { kind: 'table', oid: table.oid, schema: table.schema, name: table.name };
}

export class DumpArchiveBuilder {
  build(database: PostgresDatabase, options: ArchiveBuildOptions = {}): ArchiveBuildResult {
    const entries = new Map<string, MutableEntry>();
    const identities = new Map<string, string>();
    const dumpIds = new Map<string, string>();
    const references = new Map<string, string>();
    const diagnostics: ArchiveDiagnostic[] = [];
    const schemaEntries = new Map<string, string>();
    const tableDataEntries = new Map<number, string>();
    const ownedSequencesByColumn = new Map<string, string>();

    const addEntry: AddEntry = (input) => {
      const specificIdentity = input.specificIdentity ?? '';
      const parentIdentity =
        input.parent === undefined
          ? undefined
          : `${input.parent.kind}:${input.parent.schema ?? ''}:${input.parent.name}:${input.parent.subName ?? ''}`;
      const archiveIdentity = createArchiveIdentity({
        objectType: input.objectType,
        name: input.name,
        specificIdentity,
        ...(input.schema === undefined ? {} : { schema: input.schema }),
        ...(parentIdentity === undefined ? {} : { parentIdentity }),
      });
      const dumpId = createDumpId(archiveIdentity);
      const existingIdentity = identities.get(archiveIdentity);
      if (existingIdentity !== undefined) {
        diagnostics.push({
          code: 'duplicate-archive-identity',
          severity: 'error',
          message: 'Two source objects produced the same canonical archive identity.',
          dumpId: existingIdentity,
          relatedDumpIds: [existingIdentity],
          identity: archiveIdentity,
        });
        return undefined;
      }
      const collidingIdentity = dumpIds.get(dumpId);
      if (collidingIdentity !== undefined && collidingIdentity !== archiveIdentity) {
        diagnostics.push({
          code: 'dump-id-collision',
          severity: 'error',
          message: 'Two distinct archive identities produced the same stable dump ID.',
          dumpId,
          identity: archiveIdentity,
        });
        return undefined;
      }
      const entry: MutableEntry = {
        dumpId,
        archiveIdentity,
        ...(input.catalogOid === undefined ? {} : { catalogOid: input.catalogOid }),
        objectType: input.objectType,
        ...(input.schema === undefined ? {} : { schema: input.schema }),
        name: input.name,
        specificIdentity,
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        ...(input.owner === undefined ? {} : { owner: input.owner }),
        section: assignDumpSection(input.objectType),
        sourceObject: input.sourceObject,
        ...(input.createMetadata === undefined ? {} : { createMetadata: input.createMetadata }),
        ...(input.dropMetadata === undefined ? {} : { dropMetadata: input.dropMetadata }),
        ...(input.commentMetadata === undefined ? {} : { commentMetadata: input.commentMetadata }),
        ...(input.aclMetadata === undefined ? {} : { aclMetadata: input.aclMetadata }),
        ...(input.dataExport === undefined ? {} : { dataExport: input.dataExport }),
        dependencies: new Map(),
        diagnostics: [],
      };
      entries.set(dumpId, entry);
      identities.set(archiveIdentity, dumpId);
      dumpIds.set(dumpId, archiveIdentity);
      return entry;
    };

    const registerReference = (
      reference: PostgresObjectReference,
      entry: MutableEntry | undefined,
      aliases: readonly string[] = [],
    ): void => {
      if (entry === undefined) return;
      references.set(referenceKey(reference), entry.dumpId);
      for (const alias of aliases) {
        references.set(catalogKey(alias, reference.oid, reference.subName), entry.dumpId);
      }
    };

    const addDependency = (
      from: MutableEntry | undefined,
      toDumpId: string | undefined,
      strength: ArchiveDependencyStrength,
      source: ArchiveDependencySource,
      unresolved?: PostgresObjectReference,
    ): void => {
      if (from === undefined) return;
      if (toDumpId === undefined) {
        const code =
          source === 'metadata-target'
            ? 'orphaned-metadata'
            : from.objectType === 'materialized-view-data'
              ? 'materialized-view-data-without-definition'
              : from.objectType === 'sequence-state'
                ? 'sequence-state-without-definition'
                : from.objectType === 'table-data'
                  ? 'selected-data-without-definition'
                  : 'unresolved-dependency';
        const diagnostic: ArchiveDiagnostic = {
          code,
          severity: 'warning',
          message: 'An archive dependency reference could not be resolved.',
          dumpId: from.dumpId,
          identity: unresolved === undefined ? from.archiveIdentity : referenceKey(unresolved),
        };
        from.diagnostics.push(diagnostic);
        diagnostics.push(diagnostic);
        return;
      }
      if (toDumpId === from.dumpId) return;
      const key = `${toDumpId}:${strength}:${source}`;
      from.dependencies.set(key, { dumpId: toDumpId, strength, source });
    };

    for (const extension of options.extensions ?? []) {
      const entry = addEntry({
        objectType: 'extension',
        name: extension.name,
        sourceObject: extension,
        ...(extension.schema === undefined ? {} : { schema: extension.schema }),
        ...(extension.owner === undefined ? {} : { owner: extension.owner }),
        ...(extension.oid === undefined ? {} : { catalogOid: extension.oid }),
      });
      if (entry !== undefined && extension.oid !== undefined) {
        references.set(catalogKey('extension', extension.oid), entry.dumpId);
      }
    }

    const databaseEntry = addEntry({
      objectType: 'database',
      name: database.name,
      owner: database.owner,
      catalogOid: database.oid,
      sourceObject: database,
    });
    registerReference({ kind: 'database', oid: database.oid, name: database.name }, databaseEntry);

    for (const schema of database.schemas) {
      const entry = addEntry({
        objectType: 'schema',
        schema: schema.name,
        name: schema.name,
        owner: schema.owner,
        catalogOid: schema.oid,
        sourceObject: schema,
      });
      if (entry !== undefined) {
        schemaEntries.set(schema.name, entry.dumpId);
        registerReference(
          { kind: 'schema', oid: schema.oid, schema: schema.name, name: schema.name },
          entry,
        );
      }
    }

    for (const schema of database.schemas) {
      for (const type of schema.enumTypes) {
        const entry = this.addStructuralEntry(addEntry, 'enum', type);
        registerReference(
          { kind: 'enum', oid: type.oid, schema: type.schema, name: type.name },
          entry,
          ['type'],
        );
      }
      for (const domain of schema.domains) {
        const entry = this.addStructuralEntry(addEntry, 'domain', domain);
        registerReference(
          { kind: 'domain', oid: domain.oid, schema: domain.schema, name: domain.name },
          entry,
          ['type'],
        );
      }
      for (const table of schema.tables) {
        const tableEntry = this.addStructuralEntry(addEntry, 'table', table);
        registerReference(relationParent(table), tableEntry);
        for (const column of table.columns) {
          const columnEntry = addEntry({
            objectType: 'column',
            schema: table.schema,
            name: column.name,
            parent: relationParent(table),
            catalogOid: table.oid,
            specificIdentity: String(column.ordinalPosition),
            sourceObject: column,
          });
          registerReference(
            {
              kind: 'column',
              oid: table.oid,
              schema: table.schema,
              name: table.name,
              subName: column.name,
            },
            columnEntry,
          );
        }
        if (table.kind !== 'partitioned' && table.kind !== 'foreign') {
          const dataEntry = addEntry({
            objectType: 'table-data',
            schema: table.schema,
            name: table.name,
            parent: relationParent(table),
            catalogOid: table.oid,
            sourceObject: table,
            dataExport: {
              kind: 'table',
              relationOid: table.oid,
              schema: table.schema,
              name: table.name,
            },
          });
          if (dataEntry !== undefined) tableDataEntries.set(table.oid, dataEntry.dumpId);
        }
      }
      for (const sequence of schema.sequences) {
        const sequenceEntry = this.addStructuralEntry(addEntry, 'sequence', sequence);
        registerReference(
          {
            kind: 'sequence',
            oid: sequence.oid,
            schema: sequence.schema,
            name: sequence.name,
          },
          sequenceEntry,
        );
        if (sequence.ownedBy !== undefined && sequenceEntry !== undefined) {
          ownedSequencesByColumn.set(referenceKey(sequence.ownedBy), sequenceEntry.dumpId);
          addEntry({
            objectType: 'sequence-ownership',
            schema: sequence.schema,
            name: sequence.name,
            catalogOid: sequence.oid,
            parent: sequence.ownedBy,
            specificIdentity: sequence.ownership,
            sourceObject: sequence,
          });
        }
        if (sequence.currentValue !== undefined || sequence.isCalled !== undefined) {
          addEntry({
            objectType: 'sequence-state',
            schema: sequence.schema,
            name: sequence.name,
            catalogOid: sequence.oid,
            parent: {
              kind: 'sequence',
              oid: sequence.oid,
              schema: sequence.schema,
              name: sequence.name,
            },
            sourceObject: sequence,
            dataExport: {
              kind: 'sequence-state',
              relationOid: sequence.oid,
              schema: sequence.schema,
              name: sequence.name,
              ...(sequence.currentValue === undefined
                ? {}
                : { currentValue: sequence.currentValue }),
              ...(sequence.isCalled === undefined ? {} : { isCalled: sequence.isCalled }),
            },
          });
        }
      }
    }

    for (const constraint of database.constraints) {
      const parent =
        constraint.kind === 'foreign-key'
          ? constraint.sourceTable
          : constraint.kind === 'check'
            ? (constraint.table ?? constraint.domain)
            : constraint.table;
      const objectType = constraint.kind === 'foreign-key' ? 'foreign-key' : 'constraint';
      const entry = addEntry({
        objectType,
        schema: constraint.schema,
        name: constraint.name,
        catalogOid: constraint.oid,
        specificIdentity: constraint.kind,
        sourceObject: constraint,
        ...(parent === undefined ? {} : { parent }),
      });
      registerReference(
        {
          kind: 'constraint',
          oid: constraint.oid,
          schema: constraint.schema,
          name: constraint.name,
        },
        entry,
      );
    }

    for (const index of database.indexes) {
      const entry = this.addStructuralEntry(addEntry, 'index', index, index.table);
      registerReference(
        { kind: 'index', oid: index.oid, schema: index.schema, name: index.name },
        entry,
      );
    }

    for (const view of database.views) {
      const entry = this.addStructuralEntry(addEntry, 'view', view);
      registerReference(
        { kind: 'view', oid: view.oid, schema: view.schema, name: view.name },
        entry,
      );
    }
    for (const view of database.materializedViews) {
      const entry = this.addStructuralEntry(addEntry, 'materialized-view', view);
      registerReference(
        { kind: 'materialized-view', oid: view.oid, schema: view.schema, name: view.name },
        entry,
      );
      for (const index of view.indexes) {
        if (references.has(referenceKey(index))) continue;
        const indexEntry = addEntry({
          objectType: 'index',
          schema: index.schema ?? view.schema,
          name: index.name,
          catalogOid: index.oid,
          parent: {
            kind: 'materialized-view',
            oid: view.oid,
            schema: view.schema,
            name: view.name,
          },
          sourceObject: index,
        });
        registerReference(index, indexEntry);
      }
      addEntry({
        objectType: 'materialized-view-data',
        schema: view.schema,
        name: view.name,
        catalogOid: view.oid,
        parent: {
          kind: 'materialized-view',
          oid: view.oid,
          schema: view.schema,
          name: view.name,
        },
        sourceObject: view,
        dataExport: {
          kind: 'materialized-view',
          relationOid: view.oid,
          schema: view.schema,
          name: view.name,
          populated: view.populated,
        },
      });
    }

    for (const [objectType, routines] of [
      ['function', database.functions],
      ['procedure', database.procedures],
      ['aggregate', database.aggregates],
    ] as const) {
      for (const routine of routines) {
        const entry = this.addStructuralEntry(
          addEntry,
          objectType,
          routine,
          undefined,
          routine.identityArguments,
        );
        registerReference(
          {
            kind: objectType,
            oid: routine.oid,
            schema: routine.schema,
            name: routine.name,
            subName: routine.identityArguments,
          },
          entry,
          objectType === 'aggregate' ? ['function'] : [],
        );
      }
    }

    for (const trigger of database.triggers) {
      const entry = this.addStructuralEntry(
        addEntry,
        'trigger',
        trigger,
        trigger.table,
        trigger.table.name,
      );
      registerReference(
        { kind: 'trigger', oid: trigger.oid, schema: trigger.schema, name: trigger.name },
        entry,
      );
    }
    for (const rule of database.rules) {
      const entry = this.addStructuralEntry(
        addEntry,
        'rule',
        rule,
        rule.relation,
        rule.relation.name,
      );
      registerReference(
        { kind: 'rule', oid: rule.oid, schema: rule.schema, name: rule.name },
        entry,
      );
    }
    for (const policy of database.policies) {
      const entry = this.addStructuralEntry(
        addEntry,
        'policy',
        policy,
        policy.table,
        policy.table.name,
      );
      registerReference(
        { kind: 'policy', oid: policy.oid, schema: policy.schema, name: policy.name },
        entry,
      );
    }

    for (const comment of database.comments) {
      this.addCommentEntry(addEntry, comment);
    }
    for (const ownership of database.ownerships) {
      this.addOwnershipEntry(addEntry, ownership);
    }
    database.accessControls.forEach((acl) => this.addAclEntry(addEntry, acl));
    database.defaultPrivileges.forEach((privilege) =>
      this.addDefaultPrivilegeEntry(addEntry, privilege),
    );

    const resolve = (value: PostgresObjectReference): string | undefined => {
      const direct = references.get(referenceKey(value));
      if (direct !== undefined) return direct;
      if (value.kind === 'type') {
        return (
          references.get(catalogKey('type', value.oid, value.subName)) ??
          references.get(catalogKey('enum', value.oid, value.subName)) ??
          references.get(catalogKey('domain', value.oid, value.subName))
        );
      }
      if (value.kind === 'function') {
        return (
          references.get(catalogKey('function', value.oid, value.subName)) ??
          references.get(catalogKey('aggregate', value.oid, value.subName))
        );
      }
      return undefined;
    };

    for (const entry of entries.values()) {
      if (entry.schema !== undefined && entry.objectType !== 'schema') {
        addDependency(entry, schemaEntries.get(entry.schema), 'hard', 'schema-membership');
      }
      const source = entry.sourceObject;
      if (this.isStructuralObject(source)) {
        for (const dependency of source.dependencies) {
          if (
            entry.objectType === 'sequence' &&
            'ownedBy' in source &&
            source.ownedBy !== undefined &&
            referenceKey(source.ownedBy as PostgresObjectReference) === referenceKey(dependency)
          ) {
            continue;
          }
          addDependency(entry, resolve(dependency), 'hard', 'catalog', dependency);
        }
      }
      if (entry.parent !== undefined) {
        const hasSpecialParentDependency = [
          'comment',
          'ownership',
          'acl',
          'table-data',
          'materialized-view-data',
          'sequence-state',
        ].includes(entry.objectType);
        if (!hasSpecialParentDependency) {
          addDependency(entry, resolve(entry.parent), 'hard', 'parent-object', entry.parent);
        }
      }
      this.addSemanticDependencies(
        entry,
        source,
        resolve,
        addDependency,
        tableDataEntries,
        ownedSequencesByColumn,
      );
    }

    this.applyExtensionMembership(
      entries,
      options.extensionMembers ?? [],
      options.extensions ?? [],
      references,
      diagnostics,
      addDependency,
    );

    return {
      entries: [...entries.values()].map((entry) => this.freezeEntry(entry)),
      diagnostics,
    };
  }

  private addStructuralEntry(
    addEntry: AddEntry,
    objectType: ArchiveObjectType,
    object: PostgresStructuralObject,
    parent?: PostgresObjectReference,
    specificIdentity?: string,
  ): MutableEntry | undefined {
    return addEntry({
      objectType,
      schema: object.schema,
      name: object.name,
      ...(specificIdentity === undefined ? {} : { specificIdentity }),
      ...(parent === undefined ? {} : { parent }),
      catalogOid: object.oid,
      sourceObject: object,
      ...(object.owner === undefined ? {} : { owner: object.owner }),
    });
  }

  private addCommentEntry(addEntry: AddEntry, comment: PostgresComment): void {
    addEntry({
      objectType: 'comment',
      name: comment.object.name,
      parent: comment.object,
      specificIdentity: `${comment.object.kind}:${comment.object.subName ?? ''}`,
      catalogOid: comment.object.oid,
      sourceObject: comment,
      commentMetadata: { text: comment.text },
      ...(comment.object.schema === undefined ? {} : { schema: comment.object.schema }),
    });
  }

  private addOwnershipEntry(addEntry: AddEntry, ownership: PostgresOwnership): void {
    addEntry({
      objectType: 'ownership',
      name: ownership.object.name,
      parent: ownership.object,
      specificIdentity: ownership.object.kind,
      catalogOid: ownership.object.oid,
      owner: ownership.owner,
      sourceObject: ownership,
      ...(ownership.object.schema === undefined ? {} : { schema: ownership.object.schema }),
    });
  }

  private addAclEntry(addEntry: AddEntry, acl: PostgresAccessControlEntry): void {
    addEntry({
      objectType: 'acl',
      name: acl.object.name,
      parent: acl.object,
      specificIdentity: `${acl.object.kind}:${acl.object.subName ?? ''}:${acl.grantee}:${acl.grantor}:${acl.privilege}:${acl.grantOption}`,
      catalogOid: acl.object.oid,
      sourceObject: acl,
      aclMetadata: {
        grantee: acl.grantee,
        grantor: acl.grantor,
        privilege: acl.privilege,
        grantOption: acl.grantOption,
        rawAcl: acl.rawAcl,
      },
      ...(acl.object.schema === undefined ? {} : { schema: acl.object.schema }),
    });
  }

  private addDefaultPrivilegeEntry(addEntry: AddEntry, privilege: PostgresDefaultPrivilege): void {
    addEntry({
      objectType: 'default-privilege',
      name: privilege.owner,
      specificIdentity: `${privilege.oid}:${privilege.objectType}:${privilege.grantee}:${privilege.grantor}:${privilege.privilege}:${privilege.grantOption}`,
      catalogOid: privilege.oid,
      owner: privilege.owner,
      sourceObject: privilege,
      aclMetadata: {
        objectType: privilege.objectType,
        grantee: privilege.grantee,
        grantor: privilege.grantor,
        privilege: privilege.privilege,
        grantOption: privilege.grantOption,
        rawAcl: privilege.rawAcl,
      },
      ...(privilege.schema === undefined ? {} : { schema: privilege.schema }),
    });
  }

  private isStructuralObject(value: unknown): value is PostgresStructuralObject {
    return (
      typeof value === 'object' &&
      value !== null &&
      'dependencies' in value &&
      Array.isArray(value.dependencies)
    );
  }

  private addSemanticDependencies(
    entry: MutableEntry,
    source: unknown,
    resolve: (reference: PostgresObjectReference) => string | undefined,
    addDependency: (
      from: MutableEntry | undefined,
      toDumpId: string | undefined,
      strength: ArchiveDependencyStrength,
      dependencySource: ArchiveDependencySource,
      unresolved?: PostgresObjectReference,
    ) => void,
    tableDataEntries: ReadonlyMap<number, string>,
    ownedSequencesByColumn: ReadonlyMap<string, string>,
  ): void {
    if (entry.objectType === 'column') {
      const column = source as PostgresColumn;
      if (column.typeDependency !== undefined) {
        addDependency(
          entry,
          resolve(column.typeDependency),
          'hard',
          'type-reference',
          column.typeDependency,
        );
      }
      const columnReference: PostgresObjectReference = {
        kind: 'column',
        oid: column.tableOid,
        ...(entry.schema === undefined ? {} : { schema: entry.schema }),
        name: entry.parent?.name ?? entry.name,
        subName: column.name,
      };
      const sequenceDumpId = ownedSequencesByColumn.get(referenceKey(columnReference));
      if (sequenceDumpId !== undefined) {
        addDependency(entry, sequenceDumpId, 'hard', 'sequence-ownership');
      }
    }
    if (entry.objectType === 'table') {
      const table = source as PostgresTable;
      for (const parent of table.parents) {
        const reference: PostgresObjectReference = {
          kind: 'table',
          oid: parent.oid,
          schema: parent.schema,
          name: parent.name,
        };
        addDependency(entry, resolve(reference), 'hard', 'partition-parent', reference);
      }
    }
    if (entry.objectType === 'sequence-ownership') {
      const sequence = source as {
        readonly oid: number;
        readonly schema: string;
        readonly name: string;
      };
      const sequenceReference: PostgresObjectReference = {
        kind: 'sequence',
        oid: sequence.oid,
        schema: sequence.schema,
        name: sequence.name,
      };
      addDependency(
        entry,
        resolve(sequenceReference),
        'hard',
        'sequence-ownership',
        sequenceReference,
      );
    }
    if (entry.objectType === 'foreign-key') {
      const constraint = source as Extract<PostgresConstraint, { kind: 'foreign-key' }>;
      addDependency(
        entry,
        resolve(constraint.sourceTable),
        'hard',
        'table-object',
        constraint.sourceTable,
      );
      addDependency(
        entry,
        resolve(constraint.targetTable),
        'hard',
        'table-object',
        constraint.targetTable,
      );
      addDependency(
        entry,
        tableDataEntries.get(constraint.sourceTable.oid),
        'preference',
        'restore-safety',
      );
      addDependency(
        entry,
        tableDataEntries.get(constraint.targetTable.oid),
        'preference',
        'restore-safety',
      );
    }
    if (entry.objectType === 'constraint' || entry.objectType === 'index') {
      const parentOid = entry.parent?.oid;
      if (parentOid !== undefined) {
        addDependency(entry, tableDataEntries.get(parentOid), 'preference', 'restore-safety');
      }
    }
    if (entry.objectType === 'trigger') {
      const trigger = source as {
        readonly table: PostgresObjectReference;
        readonly function: PostgresObjectReference;
      };
      addDependency(entry, resolve(trigger.table), 'hard', 'table-object', trigger.table);
      addDependency(
        entry,
        resolve(trigger.function),
        'hard',
        'routine-reference',
        trigger.function,
      );
      addDependency(entry, tableDataEntries.get(trigger.table.oid), 'preference', 'restore-safety');
    }
    if (
      entry.objectType === 'comment' ||
      entry.objectType === 'ownership' ||
      entry.objectType === 'acl'
    ) {
      if (entry.parent !== undefined) {
        addDependency(entry, resolve(entry.parent), 'hard', 'metadata-target', entry.parent);
      }
    }
    if (entry.objectType === 'table-data' || entry.objectType === 'materialized-view-data') {
      if (entry.parent !== undefined) {
        addDependency(entry, resolve(entry.parent), 'hard', 'data-owner', entry.parent);
      }
    }
    if (entry.objectType === 'sequence-state' && entry.parent !== undefined) {
      addDependency(entry, resolve(entry.parent), 'hard', 'data-owner', entry.parent);
    }
  }

  private applyExtensionMembership(
    entries: ReadonlyMap<string, MutableEntry>,
    members: readonly ArchiveExtensionMember[],
    extensions: ArchiveBuildOptions['extensions'],
    references: ReadonlyMap<string, string>,
    diagnostics: ArchiveDiagnostic[],
    addDependency: (
      from: MutableEntry | undefined,
      toDumpId: string | undefined,
      strength: ArchiveDependencyStrength,
      source: ArchiveDependencySource,
      unresolved?: PostgresObjectReference,
    ) => void,
  ): void {
    const extensionEntries = new Map<string, string>();
    for (const extension of extensions ?? []) {
      const identity = createArchiveIdentity({
        objectType: 'extension',
        name: extension.name,
        ...(extension.schema === undefined ? {} : { schema: extension.schema }),
      });
      extensionEntries.set(extension.name, createDumpId(identity));
    }
    for (const membership of members) {
      const objectDumpId = references.get(referenceKey(membership.object));
      const extensionDumpId = extensionEntries.get(membership.extensionName);
      const objectEntry = objectDumpId === undefined ? undefined : entries.get(objectDumpId);
      if (objectEntry === undefined || extensionDumpId === undefined) {
        diagnostics.push({
          code: 'unresolved-dependency',
          severity: 'error',
          message: 'Extension membership references an unknown extension or object.',
          identity: `${membership.extensionName}:${referenceKey(membership.object)}`,
        });
        continue;
      }
      objectEntry.extensionMembership = {
        extensionDumpId,
        emitIndependently: false,
      };
      addDependency(objectEntry, extensionDumpId, 'hard', 'extension-membership');
      for (const dependent of entries.values()) {
        if (
          dependent.dumpId !== objectEntry.dumpId &&
          [...dependent.dependencies.values()].some(
            (dependency) => dependency.dumpId === objectEntry.dumpId,
          )
        ) {
          addDependency(dependent, extensionDumpId, 'hard', 'extension-membership');
        }
      }
    }
  }

  private freezeEntry(entry: MutableEntry): ArchiveEntry {
    const sourcePriority: Readonly<Record<ArchiveDependencySource, number>> = {
      'extension-membership': 0,
      'metadata-target': 1,
      'data-owner': 2,
      'sequence-ownership': 3,
      'partition-parent': 4,
      'routine-reference': 5,
      'type-reference': 6,
      'table-object': 7,
      'parent-object': 8,
      'schema-membership': 9,
      'restore-safety': 10,
      catalog: 11,
    };
    const consolidated = new Map<string, ArchiveDependency>();
    for (const dependency of entry.dependencies.values()) {
      const existing = consolidated.get(dependency.dumpId);
      if (
        existing === undefined ||
        (existing.strength === 'preference' && dependency.strength === 'hard') ||
        (existing.strength === dependency.strength &&
          sourcePriority[dependency.source] < sourcePriority[existing.source])
      ) {
        consolidated.set(dependency.dumpId, dependency);
      }
    }
    const dependencies = [...consolidated.values()].sort((left, right) => {
      const id = left.dumpId.localeCompare(right.dumpId);
      if (id !== 0) return id;
      const strength = left.strength.localeCompare(right.strength);
      return strength !== 0 ? strength : left.source.localeCompare(right.source);
    });
    return {
      dumpId: entry.dumpId,
      archiveIdentity: entry.archiveIdentity,
      ...(entry.catalogOid === undefined ? {} : { catalogOid: entry.catalogOid }),
      objectType: entry.objectType,
      ...(entry.schema === undefined ? {} : { schema: entry.schema }),
      name: entry.name,
      specificIdentity: entry.specificIdentity,
      ...(entry.parent === undefined ? {} : { parent: entry.parent }),
      ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      section: entry.section,
      dependencyDumpIds: [...new Set(dependencies.map((dependency) => dependency.dumpId))],
      dependencies,
      selection: { selected: true, reason: 'explicit', requiredByDumpIds: [] },
      ...(entry.createMetadata === undefined ? {} : { createMetadata: entry.createMetadata }),
      ...(entry.dropMetadata === undefined ? {} : { dropMetadata: entry.dropMetadata }),
      ...(entry.commentMetadata === undefined ? {} : { commentMetadata: entry.commentMetadata }),
      ...(entry.aclMetadata === undefined ? {} : { aclMetadata: entry.aclMetadata }),
      ...(entry.dataExport === undefined ? {} : { dataExport: entry.dataExport }),
      ...(entry.extensionMembership === undefined
        ? {}
        : { extensionMembership: entry.extensionMembership }),
      sourceObject: entry.sourceObject,
      diagnostics: [...entry.diagnostics],
    };
  }
}
