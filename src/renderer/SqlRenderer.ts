/**
 * PostgreSQL plain-SQL rendering for individual archive entries.
 *
 * This dispatcher is connection-free and emits bounded statement arrays for a
 * single entry. The outer plain renderer streams those statements immediately.
 */

import type { ArchiveEntry } from '../archive/ArchiveTypes.js';
import type { ArchiveExtension } from '../archive/ArchiveTypes.js';
import type { PostgresColumn, PostgresSchema, PostgresTable } from '../model/PostgresDatabase.js';
import type {
  PostgresAccessControlEntry,
  PostgresAggregate,
  PostgresComment,
  PostgresDefaultPrivilege,
  PostgresFunction,
  PostgresMaterializedView,
  PostgresOwnership,
  PostgresPolicy,
  PostgresProcedure,
  PostgresRule,
  PostgresTrigger,
  PostgresView,
} from '../model/PostgresHigherLevelObjects.js';
import type {
  PostgresConstraint,
  PostgresDomain,
  PostgresEnumType,
  PostgresForeignKeyConstraint,
  PostgresIndex,
  PostgresKeyConstraint,
  PostgresObjectReference,
  PostgresSequence,
} from '../model/PostgresStructuralObjects.js';
import { RenderError } from '../utils/errors.js';
import type { PlainSqlRenderContext } from './RenderTypes.js';
import {
  ensureStatement,
  keyword,
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteRoleName,
  quoteStringLiteral,
} from './SqlPrimitives.js';

export interface ArchiveEntrySqlRenderer {
  renderCreate(context: PlainSqlRenderContext): readonly string[];
  renderDrop(context: PlainSqlRenderContext): readonly string[];
}

export class PostgresSqlRenderer implements ArchiveEntrySqlRenderer {
  readonly #initializedAclTargets = new Set<string>();

  renderCreate(context: PlainSqlRenderContext): readonly string[] {
    const { entry } = context;
    switch (entry.objectType) {
      case 'database':
        return this.renderDatabase(context);
      case 'extension':
        return this.renderExtension(context);
      case 'schema':
        return this.renderSchema(context);
      case 'enum':
        return this.renderEnum(context);
      case 'domain':
        return this.renderDomain(context);
      case 'sequence':
        return this.renderSequence(context);
      case 'sequence-ownership':
        return this.renderSequenceOwnership(context);
      case 'table':
        return this.renderTable(context);
      case 'column':
        return [];
      case 'constraint':
        return this.renderConstraint(context);
      case 'foreign-key':
        return this.renderForeignKey(context);
      case 'index':
        return this.renderIndex(context);
      case 'view':
        return this.renderView(context);
      case 'materialized-view':
        return this.renderMaterializedView(context);
      case 'function':
        return this.renderFunction(context);
      case 'procedure':
        return this.renderProcedure(context);
      case 'aggregate':
        return this.renderAggregate(context);
      case 'trigger':
        return this.renderTrigger(context);
      case 'rule':
        return this.renderRule(context);
      case 'policy':
        return this.renderPolicy(context);
      case 'comment':
        return context.options.noComments ? [] : this.renderComment(context);
      case 'ownership':
        return context.options.noOwner ? [] : this.renderOwnership(context);
      case 'acl':
        return context.options.noPrivileges ? [] : this.renderAcl(context);
      case 'default-privilege':
        return context.options.noPrivileges ? [] : this.renderDefaultPrivilege(context);
      case 'table-data':
      case 'materialized-view-data':
      case 'sequence-state':
        return [];
    }
  }

  renderDrop(context: PlainSqlRenderContext): readonly string[] {
    const { entry } = context;
    const object = this.objectIdentity(entry.parent ?? this.entryReference(entry), context);
    const ifExists = context.options.ifExists ? ` ${this.k('IF EXISTS', context)}` : '';
    const cascade = context.options.cascade ? ` ${this.k('CASCADE', context)}` : '';
    switch (entry.objectType) {
      case 'schema':
        return [
          `${this.k('DROP SCHEMA', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
        ];
      case 'extension':
        return [
          `${this.k('DROP EXTENSION', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
        ];
      case 'enum':
      case 'domain':
        return [
          `${this.k('DROP TYPE', context)}${ifExists} ${this.qn(entry.schema, entry.name, context)}${cascade};`,
        ];
      case 'sequence':
        if (this.isIdentitySequence(context)) return [];
        return [
          `${this.k('DROP SEQUENCE', context)}${ifExists} ${this.qn(entry.schema, entry.name, context)}${cascade};`,
        ];
      case 'table':
        return [
          `${this.k('DROP TABLE', context)}${ifExists} ${this.qn(entry.schema, entry.name, context)}${cascade};`,
        ];
      case 'view':
        return [
          `${this.k('DROP VIEW', context)}${ifExists} ${this.qn(entry.schema, entry.name, context)}${cascade};`,
        ];
      case 'materialized-view':
        return [
          `${this.k('DROP MATERIALIZED VIEW', context)}${ifExists} ${this.qn(entry.schema, entry.name, context)}${cascade};`,
        ];
      case 'function':
      case 'procedure':
      case 'aggregate': {
        const type =
          entry.objectType === 'aggregate' ? 'AGGREGATE' : entry.objectType.toUpperCase();
        return [
          `${this.k(`DROP ${type}`, context)}${ifExists} ${this.routineIdentity(entry, context)}${cascade};`,
        ];
      }
      case 'constraint':
      case 'foreign-key':
        return entry.parent === undefined
          ? []
          : [
              `${this.k('ALTER TABLE', context)} ${this.objectIdentity(entry.parent, context)} ${this.k('DROP CONSTRAINT', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
            ];
      case 'index':
        return [
          `${this.k('DROP INDEX', context)}${ifExists} ${this.qn(entry.schema, entry.name, context)}${cascade};`,
        ];
      case 'trigger':
        return entry.parent === undefined
          ? []
          : [
              `${this.k('DROP TRIGGER', context)}${ifExists} ${this.q(entry.name, context)} ${this.k('ON', context)} ${object}${cascade};`,
            ];
      case 'rule':
        return entry.parent === undefined
          ? []
          : [
              `${this.k('DROP RULE', context)}${ifExists} ${this.q(entry.name, context)} ${this.k('ON', context)} ${object}${cascade};`,
            ];
      case 'policy':
        return entry.parent === undefined
          ? []
          : [
              `${this.k('DROP POLICY', context)}${ifExists} ${this.q(entry.name, context)} ${this.k('ON', context)} ${object}${cascade};`,
            ];
      default:
        return [];
    }
  }

  private renderDatabase(context: PlainSqlRenderContext): readonly string[] {
    if (!context.options.includeCreateDatabase) return [];
    return [`${this.k('CREATE DATABASE', context)} ${this.q(context.entry.name, context)};`];
  }

  private renderExtension(context: PlainSqlRenderContext): readonly string[] {
    const extension = context.entry.sourceObject as ArchiveExtension;
    const schema =
      extension.schema === undefined
        ? ''
        : ` ${this.k('WITH SCHEMA', context)} ${this.q(extension.schema, context)}`;
    return [
      `${this.k('CREATE EXTENSION IF NOT EXISTS', context)} ${this.q(extension.name, context)}${schema};`,
    ];
  }

  private renderSchema(context: PlainSqlRenderContext): readonly string[] {
    const schema = context.entry.sourceObject as PostgresSchema;
    const authorization =
      context.options.schemaAuthorization && !context.options.noOwner
        ? ` ${this.k('AUTHORIZATION', context)} ${this.role(schema.owner, context)}`
        : '';
    return [`${this.k('CREATE SCHEMA', context)} ${this.q(schema.name, context)}${authorization};`];
  }

  private renderEnum(context: PlainSqlRenderContext): readonly string[] {
    const type = context.entry.sourceObject as PostgresEnumType;
    const labels = [...type.labels]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((label) => quoteStringLiteral(label.label))
      .join(', ');
    return [
      `${this.k('CREATE TYPE', context)} ${this.qn(type.schema, type.name, context)} ${this.k('AS ENUM', context)} (${labels});`,
    ];
  }

  private renderDomain(context: PlainSqlRenderContext): readonly string[] {
    const domain = context.entry.sourceObject as PostgresDomain;
    const clauses = [
      `${this.k('CREATE DOMAIN', context)} ${this.qn(domain.schema, domain.name, context)} ${this.k('AS', context)} ${domain.formattedBaseType}`,
    ];
    if (domain.collation !== undefined)
      clauses.push(`${this.k('COLLATE', context)} ${domain.collation}`);
    if (domain.defaultExpression !== undefined) {
      clauses.push(`${this.k('DEFAULT', context)} ${domain.defaultExpression}`);
    }
    if (!domain.nullable) clauses.push(this.k('NOT NULL', context));
    for (const constraint of domain.constraints) {
      clauses.push(
        `${this.k('CONSTRAINT', context)} ${this.q(constraint.name, context)} ${this.k('CHECK', context)} (${constraint.expression})${constraint.validated ? '' : ` ${this.k('NOT VALID', context)}`}`,
      );
    }
    return [`${clauses.join(` ${context.writer.lineEnding}${context.options.indentation}`)};`];
  }

  private renderSequence(context: PlainSqlRenderContext): readonly string[] {
    if (this.isIdentitySequence(context)) return [];
    const sequence = context.entry.sourceObject as PostgresSequence;
    const clauses = [
      `${this.k('CREATE SEQUENCE', context)} ${this.qn(sequence.schema, sequence.name, context)}`,
      `${this.k('AS', context)} ${sequence.dataType}`,
      `${this.k('INCREMENT BY', context)} ${sequence.increment}`,
      `${this.k('MINVALUE', context)} ${sequence.minimumValue}`,
      `${this.k('MAXVALUE', context)} ${sequence.maximumValue}`,
      `${this.k('START WITH', context)} ${sequence.startValue}`,
      `${this.k('CACHE', context)} ${sequence.cacheSize}`,
      this.k(sequence.cycle ? 'CYCLE' : 'NO CYCLE', context),
    ];
    return [`${clauses.join(` ${context.writer.lineEnding}${context.options.indentation}`)};`];
  }

  private renderSequenceOwnership(context: PlainSqlRenderContext): readonly string[] {
    if (this.isIdentitySequence(context)) return [];
    const sequence = context.entry.sourceObject as PostgresSequence;
    if (sequence.ownedBy === undefined) return [];
    return [
      `${this.k('ALTER SEQUENCE', context)} ${this.qn(sequence.schema, sequence.name, context)} ${this.k('OWNED BY', context)} ${this.columnIdentity(sequence.ownedBy, context)};`,
    ];
  }

  private renderTable(context: PlainSqlRenderContext): readonly string[] {
    const table = context.entry.sourceObject as PostgresTable;
    if (table.kind === 'foreign') {
      return this.unsupportedObject(
        context,
        'foreign table server and option metadata is unavailable',
      );
    }
    if (
      (table.kind === 'partitioned' || table.kind === 'partition') &&
      !context.targetCapabilities.declarativePartitioning
    ) {
      return this.unsupported(context, 'declarative partitioning', false);
    }

    const name = this.qn(table.schema, table.name, context);
    if (table.kind === 'partition') {
      const parent = table.parents[0];
      if (parent === undefined || table.bound === undefined) {
        throw this.error(context, 'Partition metadata is incomplete.');
      }
      const boundExpression = table.bound.expression.trim();
      const bound =
        table.bound.default || boundExpression.toUpperCase() === 'DEFAULT'
          ? this.k('DEFAULT', context)
          : /^FOR\s+VALUES\b/iu.test(boundExpression)
            ? boundExpression
            : `${this.k('FOR VALUES', context)} ${boundExpression}`;
      const clauses = [
        `${this.k('CREATE TABLE', context)} ${name} ${this.k('PARTITION OF', context)} ${this.qn(parent.schema, parent.name, context)}`,
        bound,
      ];
      if (table.tablespace !== undefined) {
        clauses.push(`${this.k('TABLESPACE', context)} ${this.q(table.tablespace, context)}`);
      }
      return [`${clauses.join(` ${context.writer.lineEnding}${context.options.indentation}`)};`];
    }

    const persistence =
      table.persistence === 'unlogged'
        ? `${this.k('UNLOGGED', context)} `
        : table.persistence === 'temporary'
          ? `${this.k('TEMPORARY', context)} `
          : '';
    const columns = [...table.columns]
      .sort((left, right) => left.ordinalPosition - right.ordinalPosition)
      .map((column) => this.renderColumn(column, context))
      .join(`,${context.writer.lineEnding}`);
    const clauses = [
      `${this.k(`CREATE ${persistence}TABLE`, context)} ${name} (${context.writer.lineEnding}${columns}${context.writer.lineEnding})`,
    ];
    if (table.kind === 'partitioned') {
      if (table.partition === undefined)
        throw this.error(context, 'Partition key metadata is missing.');
      clauses.push(`${this.k('PARTITION BY', context)} ${table.partition.keyDefinition}`);
    } else if (table.parents.length > 0) {
      clauses.push(
        `${this.k('INHERITS', context)} (${table.parents
          .map((parent) => this.qn(parent.schema, parent.name, context))
          .join(', ')})`,
      );
    }
    if (table.accessMethod !== undefined) {
      if (!context.targetCapabilities.tableAccessMethods) {
        this.unsupported(context, 'table access methods', table.accessMethod === 'heap');
      } else {
        clauses.push(`${this.k('USING', context)} ${this.q(table.accessMethod, context)}`);
      }
    }
    if (table.tablespace !== undefined) {
      clauses.push(`${this.k('TABLESPACE', context)} ${this.q(table.tablespace, context)}`);
    }
    const statements = [
      `${clauses.join(` ${context.writer.lineEnding}${context.options.indentation}`)};`,
    ];
    if (table.rowLevelSecurity) {
      statements.push(
        `${this.k('ALTER TABLE', context)} ${name} ${this.k('ENABLE ROW LEVEL SECURITY', context)};`,
      );
    }
    if (table.forceRowLevelSecurity) {
      statements.push(
        `${this.k('ALTER TABLE', context)} ${name} ${this.k('FORCE ROW LEVEL SECURITY', context)};`,
      );
    }
    for (const column of table.columns) {
      statements.push(
        `${this.k('ALTER TABLE', context)} ${name} ${this.k('ALTER COLUMN', context)} ${this.q(column.name, context)} ${this.k('SET STORAGE', context)} ${this.k(column.storage, context)};`,
      );
    }
    return statements;
  }

  private renderColumn(column: PostgresColumn, context: PlainSqlRenderContext): string {
    const clauses = [
      `${context.options.indentation}${this.q(column.name, context)} ${column.formattedType}`,
    ];
    if (column.compression !== undefined) {
      if (context.targetCapabilities.columnCompression) {
        clauses.push(`${this.k('COMPRESSION', context)} ${this.q(column.compression, context)}`);
      } else {
        this.unsupported(context, 'column compression', true);
      }
    }
    if (column.collation !== undefined)
      clauses.push(`${this.k('COLLATE', context)} ${column.collation}`);
    if (column.identity !== undefined) {
      if (context.targetCapabilities.identityColumns) {
        clauses.push(
          `${this.k('GENERATED', context)} ${this.k(column.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT', context)} ${this.k('AS IDENTITY', context)}`,
        );
      } else {
        this.unsupported(context, 'identity columns', false);
      }
    } else if (column.generatedExpression !== undefined) {
      if (context.targetCapabilities.generatedColumns) {
        clauses.push(
          `${this.k('GENERATED ALWAYS AS', context)} (${column.generatedExpression}) ${this.k('STORED', context)}`,
        );
      } else {
        this.unsupported(context, 'generated columns', false);
      }
    } else if (column.defaultExpression !== undefined) {
      clauses.push(`${this.k('DEFAULT', context)} ${column.defaultExpression}`);
    }
    if (!column.nullable) clauses.push(this.k('NOT NULL', context));
    return clauses.join(' ');
  }

  private renderConstraint(context: PlainSqlRenderContext): readonly string[] {
    const constraint = context.entry.sourceObject as PostgresConstraint;
    if (constraint.kind === 'foreign-key') return this.renderForeignKey(context);
    if (constraint.kind === 'check' && constraint.domain !== undefined) return [];
    const table = constraint.kind === 'check' ? constraint.table : constraint.table;
    if (table === undefined) return [];
    const prefix = `${this.k('ALTER TABLE ONLY', context)} ${this.objectIdentity(table, context)} ${this.k('ADD CONSTRAINT', context)} ${this.q(constraint.name, context)} `;
    if (constraint.kind === 'check') {
      return [
        `${prefix}${this.k('CHECK', context)} (${constraint.expression})${constraint.noInherit ? ` ${this.k('NO INHERIT', context)}` : ''}${constraint.validated ? '' : ` ${this.k('NOT VALID', context)}`};`,
      ];
    }
    return [`${prefix}${this.renderKeyConstraint(constraint, context)};`];
  }

  private renderKeyConstraint(
    constraint: PostgresKeyConstraint,
    context: PlainSqlRenderContext,
  ): string {
    const type = constraint.kind === 'primary-key' ? 'PRIMARY KEY' : 'UNIQUE';
    const nulls = constraint.nullsNotDistinct
      ? context.targetCapabilities.nullsNotDistinct
        ? ` ${this.k('NULLS NOT DISTINCT', context)}`
        : this.unsupportedClause(context, 'NULLS NOT DISTINCT', false)
      : '';
    const columns = constraint.columns
      .map((column) => this.q(column.subName ?? column.name, context))
      .join(', ');
    return `${this.k(type, context)}${nulls} (${columns})${this.deferrability(constraint, context)}`;
  }

  private renderForeignKey(context: PlainSqlRenderContext): readonly string[] {
    const constraint = context.entry.sourceObject as PostgresForeignKeyConstraint;
    const sourceColumns = constraint.sourceColumns
      .map((column) => this.q(column.subName ?? column.name, context))
      .join(', ');
    const targetColumns = constraint.targetColumns
      .map((column) => this.q(column.subName ?? column.name, context))
      .join(', ');
    const match =
      constraint.match === 'simple' ? '' : ` ${this.k(`MATCH ${constraint.match}`, context)}`;
    const update = ` ${this.k('ON UPDATE', context)} ${this.k(constraint.onUpdate.replace('-', ' '), context)}`;
    const remove = ` ${this.k('ON DELETE', context)} ${this.k(constraint.onDelete.replace('-', ' '), context)}`;
    const notValid = constraint.validated ? '' : ` ${this.k('NOT VALID', context)}`;
    return [
      `${this.k('ALTER TABLE ONLY', context)} ${this.objectIdentity(constraint.sourceTable, context)} ${this.k('ADD CONSTRAINT', context)} ${this.q(constraint.name, context)} ${this.k('FOREIGN KEY', context)} (${sourceColumns}) ${this.k('REFERENCES', context)} ${this.objectIdentity(constraint.targetTable, context)} (${targetColumns})${match}${update}${remove}${this.deferrability(constraint, context)}${notValid};`,
    ];
  }

  private renderIndex(context: PlainSqlRenderContext): readonly string[] {
    const index = context.entry.sourceObject as Partial<PostgresIndex> & {
      readonly definition?: string;
      readonly valid?: boolean;
    };
    if (index.definition === undefined) {
      return this.unsupportedObject(context, 'materialized-view index definition is unavailable');
    }
    if (index.valid === false || index.ready === false || index.exportable === false) {
      this.warn(context, 'unsupported-object', 'Invalid or unfinished index was skipped.');
      return [];
    }
    if (index.primary || this.isConstraintBackingIndex(context)) return [];
    if (
      index.elements === undefined ||
      index.table === undefined ||
      index.accessMethod === undefined
    ) {
      return [ensureStatement(index.definition)];
    }
    const keyElements = index.elements.filter((element) => element.key);
    const includeElements = index.elements.filter((element) => !element.key);
    const renderedKeys = keyElements.map((element) => {
      const pieces = [
        element.column === undefined
          ? (element.expression ?? '')
          : this.q(element.column.subName ?? element.column.name, context),
      ];
      if (element.collation !== undefined)
        pieces.push(`${this.k('COLLATE', context)} ${element.collation}`);
      if (element.operatorClass !== undefined) pieces.push(element.operatorClass);
      if (element.direction !== undefined)
        pieces.push(this.k(element.direction === 'descending' ? 'DESC' : 'ASC', context));
      if (element.nulls !== undefined) pieces.push(this.k(`NULLS ${element.nulls}`, context));
      return pieces.join(' ');
    });
    const unique = index.unique ? `${this.k('UNIQUE', context)} ` : '';
    const clauses = [
      `${this.k('CREATE', context)} ${unique}${this.k('INDEX', context)} ${this.q(index.name ?? context.entry.name, context)} ${this.k('ON', context)} ${this.objectIdentity(index.table, context)} ${this.k('USING', context)} ${this.q(index.accessMethod, context)} (${renderedKeys.join(', ')})`,
    ];
    if (includeElements.length > 0) {
      if (context.targetCapabilities.includeIndexes) {
        clauses.push(
          `${this.k('INCLUDE', context)} (${includeElements
            .map((element) =>
              this.q(element.column?.subName ?? element.column?.name ?? '', context),
            )
            .join(', ')})`,
        );
      } else {
        this.unsupported(context, 'INCLUDE indexes', true, 'INCLUDE columns omitted');
      }
    }
    if ((index.storageParameters?.length ?? 0) > 0) {
      clauses.push(`${this.k('WITH', context)} (${index.storageParameters!.join(', ')})`);
    }
    if (index.tablespace !== undefined) {
      clauses.push(`${this.k('TABLESPACE', context)} ${this.q(index.tablespace, context)}`);
    }
    if (index.predicate !== undefined)
      clauses.push(`${this.k('WHERE', context)} ${index.predicate}`);
    const statements = [
      `${clauses.join(` ${context.writer.lineEnding}${context.options.indentation}`)};`,
    ];
    if (index.clustered) {
      statements.push(
        `${this.k('ALTER TABLE', context)} ${this.objectIdentity(index.table, context)} ${this.k('CLUSTER ON', context)} ${this.q(index.name ?? context.entry.name, context)};`,
      );
    }
    if (index.replicaIdentity) {
      statements.push(
        `${this.k('ALTER TABLE ONLY', context)} ${this.objectIdentity(index.table, context)} ${this.k('REPLICA IDENTITY USING INDEX', context)} ${this.q(index.name ?? context.entry.name, context)};`,
      );
    }
    return statements;
  }

  private renderView(context: PlainSqlRenderContext): readonly string[] {
    const view = context.entry.sourceObject as PostgresView;
    const options: string[] = [];
    if (view.securityBarrier) options.push('security_barrier=true');
    if (view.securityInvoker) {
      if (context.targetCapabilities.securityInvokerViews) {
        options.push('security_invoker=true');
      } else {
        this.unsupported(context, 'security-invoker views', false);
      }
    }
    if (view.checkOption !== 'none') options.push(`check_option=${view.checkOption}`);
    const optionSql =
      options.length === 0 ? '' : ` ${this.k('WITH', context)} (${options.join(', ')})`;
    const replace = context.options.createOrReplaceViews ? ' OR REPLACE' : '';
    return [
      `${this.k(`CREATE${replace} VIEW`, context)} ${this.qn(view.schema, view.name, context)}${optionSql} ${this.k('AS', context)}${context.writer.lineEnding}${view.definition.trim().replace(/;$/u, '')};`,
    ];
  }

  private renderMaterializedView(context: PlainSqlRenderContext): readonly string[] {
    const view = context.entry.sourceObject as PostgresMaterializedView;
    const clauses = [
      `${this.k('CREATE MATERIALIZED VIEW', context)} ${this.qn(view.schema, view.name, context)}`,
    ];
    if (view.accessMethod !== undefined) {
      if (context.targetCapabilities.tableAccessMethods) {
        clauses.push(`${this.k('USING', context)} ${this.q(view.accessMethod, context)}`);
      } else {
        this.unsupported(context, 'materialized-view access methods', view.accessMethod === 'heap');
      }
    }
    if (view.storageParameters.length > 0) {
      clauses.push(`${this.k('WITH', context)} (${view.storageParameters.join(', ')})`);
    }
    if (view.tablespace !== undefined) {
      clauses.push(`${this.k('TABLESPACE', context)} ${this.q(view.tablespace, context)}`);
    }
    clauses.push(
      `${this.k('AS', context)}${context.writer.lineEnding}${view.definition.trim().replace(/;$/u, '')}`,
    );
    if (!view.populated) clauses.push(this.k('WITH NO DATA', context));
    return [`${clauses.join(` ${context.writer.lineEnding}${context.options.indentation}`)};`];
  }

  private renderFunction(context: PlainSqlRenderContext): readonly string[] {
    const routine = context.entry.sourceObject as PostgresFunction;
    return [ensureStatement(routine.definition)];
  }

  private renderProcedure(context: PlainSqlRenderContext): readonly string[] {
    if (!context.targetCapabilities.procedures) {
      return this.unsupported(context, 'procedures', false);
    }
    const routine = context.entry.sourceObject as PostgresProcedure;
    return [ensureStatement(routine.definition)];
  }

  private renderAggregate(context: PlainSqlRenderContext): readonly string[] {
    const aggregate = context.entry.sourceObject as PostgresAggregate;
    if (aggregate.definition !== undefined) return [ensureStatement(aggregate.definition)];
    if (aggregate.transitionFunction === undefined) {
      return this.unsupportedObject(context, 'aggregate transition function is unavailable');
    }
    const options = [
      `${this.k('SFUNC', context)} = ${this.supportFunction(aggregate.transitionFunction, context)}`,
      `${this.k('STYPE', context)} = ${aggregate.stateTypeName}`,
    ];
    if (aggregate.finalFunction !== undefined) {
      options.push(
        `${this.k('FINALFUNC', context)} = ${this.supportFunction(aggregate.finalFunction, context)}`,
      );
    }
    if (aggregate.combineFunction !== undefined) {
      options.push(
        `${this.k('COMBINEFUNC', context)} = ${this.supportFunction(aggregate.combineFunction, context)}`,
      );
    }
    if (aggregate.serializationFunction !== undefined) {
      options.push(
        `${this.k('SERIALFUNC', context)} = ${this.supportFunction(aggregate.serializationFunction, context)}`,
      );
    }
    if (aggregate.deserializationFunction !== undefined) {
      options.push(
        `${this.k('DESERIALFUNC', context)} = ${this.supportFunction(aggregate.deserializationFunction, context)}`,
      );
    }
    if (aggregate.initialCondition !== undefined) {
      options.push(
        `${this.k('INITCOND', context)} = ${quoteStringLiteral(aggregate.initialCondition)}`,
      );
    }
    return [
      `${this.k('CREATE AGGREGATE', context)} ${this.qn(aggregate.schema, aggregate.name, context)} (${aggregate.identityArguments}) (${context.writer.lineEnding}${context.options.indentation}${options.join(`,${context.writer.lineEnding}${context.options.indentation}`)}${context.writer.lineEnding});`,
    ];
  }

  private renderTrigger(context: PlainSqlRenderContext): readonly string[] {
    const trigger = context.entry.sourceObject as PostgresTrigger;
    const statements = [ensureStatement(trigger.definition)];
    if (trigger.enabled !== 'origin') {
      const mode =
        trigger.enabled === 'disabled'
          ? 'DISABLE'
          : trigger.enabled === 'always'
            ? 'ENABLE ALWAYS'
            : 'ENABLE REPLICA';
      statements.push(
        `${this.k('ALTER TABLE', context)} ${this.objectIdentity(trigger.table, context)} ${this.k(`${mode} TRIGGER`, context)} ${this.q(trigger.name, context)};`,
      );
    }
    return statements;
  }

  private renderRule(context: PlainSqlRenderContext): readonly string[] {
    const rule = context.entry.sourceObject as PostgresRule;
    if (rule.name === '_RETURN') return [];
    const statements = [ensureStatement(rule.definition)];
    if (rule.enabled !== 'origin') {
      const mode =
        rule.enabled === 'disabled'
          ? 'DISABLE'
          : rule.enabled === 'always'
            ? 'ENABLE ALWAYS'
            : 'ENABLE REPLICA';
      statements.push(
        `${this.k('ALTER TABLE', context)} ${this.objectIdentity(rule.relation, context)} ${this.k(`${mode} RULE`, context)} ${this.q(rule.name, context)};`,
      );
    }
    return statements;
  }

  private renderPolicy(context: PlainSqlRenderContext): readonly string[] {
    const policy = context.entry.sourceObject as PostgresPolicy;
    if (!policy.permissive && !context.targetCapabilities.restrictivePolicies) {
      return this.unsupported(context, 'restrictive row-security policies', false);
    }
    const clauses = [
      `${this.k('CREATE POLICY', context)} ${this.q(policy.name, context)} ${this.k('ON', context)} ${this.objectIdentity(policy.table, context)}`,
    ];
    if (!policy.permissive) clauses.push(this.k('AS RESTRICTIVE', context));
    if (policy.command !== 'all') clauses.push(this.k(`FOR ${policy.command}`, context));
    clauses.push(
      `${this.k('TO', context)} ${policy.roles.map((role) => this.role(role, context)).join(', ')}`,
    );
    if (policy.usingExpression !== undefined) {
      clauses.push(`${this.k('USING', context)} (${policy.usingExpression})`);
    }
    if (policy.checkExpression !== undefined) {
      clauses.push(`${this.k('WITH CHECK', context)} (${policy.checkExpression})`);
    }
    return [`${clauses.join(` ${context.writer.lineEnding}${context.options.indentation}`)};`];
  }

  private renderComment(context: PlainSqlRenderContext): readonly string[] {
    const comment = context.entry.sourceObject as PostgresComment;
    if (comment.object.kind === 'database' && !context.options.includeCreateDatabase) return [];
    return [
      `${this.k('COMMENT ON', context)} ${this.metadataTarget(comment.object, context)} ${this.k('IS', context)} ${quoteStringLiteral(comment.text)};`,
    ];
  }

  private renderOwnership(context: PlainSqlRenderContext): readonly string[] {
    const ownership = context.entry.sourceObject as PostgresOwnership;
    if (ownership.object.kind === 'database' && !context.options.includeCreateDatabase) return [];
    const target = this.ownershipTarget(ownership.object, context);
    if (target === undefined) {
      return [];
    }
    return [
      `${this.k('ALTER', context)} ${target} ${this.k('OWNER TO', context)} ${this.role(ownership.owner, context)};`,
    ];
  }

  private renderAcl(context: PlainSqlRenderContext): readonly string[] {
    const acl = context.entry.sourceObject as PostgresAccessControlEntry;
    if (acl.object.kind === 'database' && !context.options.includeCreateDatabase) return [];
    const target = this.privilegeTarget(acl.object, context);
    if (target === undefined) {
      return this.unsupportedObject(context, 'privileges are unsupported for this object type');
    }
    const targetKey = `${acl.object.kind}:${acl.object.oid}:${acl.object.subName ?? ''}`;
    const statements: string[] = [];
    if (!this.#initializedAclTargets.has(targetKey)) {
      this.#initializedAclTargets.add(targetKey);
      statements.push(
        `${this.k('REVOKE ALL ON', context)} ${target} ${this.k('FROM PUBLIC', context)};`,
      );
    }
    statements.push(
      `${this.k('GRANT', context)} ${this.k(acl.privilege, context)} ${this.k('ON', context)} ${target} ${this.k('TO', context)} ${this.role(acl.grantee, context)}${acl.grantOption ? ` ${this.k('WITH GRANT OPTION', context)}` : ''};`,
    );
    return statements;
  }

  private renderDefaultPrivilege(context: PlainSqlRenderContext): readonly string[] {
    const privilege = context.entry.sourceObject as PostgresDefaultPrivilege;
    const category =
      privilege.objectType === 'table'
        ? 'TABLES'
        : privilege.objectType === 'sequence'
          ? 'SEQUENCES'
          : privilege.objectType === 'function'
            ? 'FUNCTIONS'
            : privilege.objectType === 'type'
              ? 'TYPES'
              : privilege.objectType === 'schema'
                ? 'SCHEMAS'
                : undefined;
    if (category === undefined) {
      return this.unsupportedObject(context, 'default privilege object category is unknown');
    }
    const schema =
      privilege.schema === undefined
        ? ''
        : ` ${this.k('IN SCHEMA', context)} ${this.q(privilege.schema, context)}`;
    return [
      `${this.k('ALTER DEFAULT PRIVILEGES FOR ROLE', context)} ${this.role(privilege.owner, context)}${schema} ${this.k('GRANT', context)} ${this.k(privilege.privilege, context)} ${this.k('ON', context)} ${this.k(category, context)} ${this.k('TO', context)} ${this.role(privilege.grantee, context)}${privilege.grantOption ? ` ${this.k('WITH GRANT OPTION', context)}` : ''};`,
    ];
  }

  private metadataTarget(
    reference: PostgresObjectReference,
    context: PlainSqlRenderContext,
  ): string {
    const identity = this.objectIdentity(reference, context);
    switch (reference.kind) {
      case 'column':
        return `${this.k('COLUMN', context)} ${this.columnIdentity(reference, context)}`;
      case 'constraint':
        return `${this.k('CONSTRAINT', context)} ${this.q(reference.name, context)}${this.metadataParent(reference, context)}`;
      case 'function':
      case 'procedure':
      case 'aggregate':
        return `${this.k(reference.kind, context)} ${identity}`;
      case 'trigger':
      case 'rule':
      case 'policy':
        return `${this.k(reference.kind, context)} ${this.q(reference.name, context)}${this.metadataParent(reference, context)}`;
      case 'enum':
      case 'domain':
      case 'type':
        return `${this.k('TYPE', context)} ${identity}`;
      case 'materialized-view':
        return `${this.k('MATERIALIZED VIEW', context)} ${identity}`;
      default:
        return `${this.k(reference.kind, context)} ${identity}`;
    }
  }

  private metadataParent(
    reference: PostgresObjectReference,
    context: PlainSqlRenderContext,
  ): string {
    const target = context.archive.entries.find(
      (entry) =>
        (entry.catalogOid ??
          (entry.sourceObject as { readonly oid?: number } | undefined)?.oid ??
          0) === reference.oid &&
        (entry.objectType === reference.kind ||
          (reference.kind === 'constraint' && entry.objectType === 'foreign-key')),
    );
    return target?.parent === undefined
      ? ''
      : ` ${this.k('ON', context)} ${this.objectIdentity(target.parent, context)}`;
  }

  private ownershipTarget(
    reference: PostgresObjectReference,
    context: PlainSqlRenderContext,
  ): string | undefined {
    const identity = this.objectIdentity(reference, context);
    switch (reference.kind) {
      case 'enum':
      case 'domain':
      case 'type':
        return `${this.k('TYPE', context)} ${identity}`;
      case 'materialized-view':
        return `${this.k('MATERIALIZED VIEW', context)} ${identity}`;
      case 'function':
      case 'procedure':
      case 'aggregate':
        return `${this.k(reference.kind, context)} ${identity}`;
      case 'database':
      case 'schema':
      case 'table':
      case 'sequence':
      case 'view':
        return `${this.k(reference.kind, context)} ${identity}`;
      default:
        return undefined;
    }
  }

  private privilegeTarget(
    reference: PostgresObjectReference,
    context: PlainSqlRenderContext,
  ): string | undefined {
    const identity = this.objectIdentity(reference, context);
    switch (reference.kind) {
      case 'enum':
      case 'domain':
      case 'type':
        return `${this.k('TYPE', context)} ${identity}`;
      case 'materialized-view':
      case 'view':
      case 'table':
        return `${this.k('TABLE', context)} ${identity}`;
      case 'function':
      case 'procedure':
      case 'aggregate':
        return `${this.k('FUNCTION', context)} ${identity}`;
      case 'database':
      case 'schema':
      case 'sequence':
        return `${this.k(reference.kind, context)} ${identity}`;
      default:
        return undefined;
    }
  }

  private objectIdentity(
    reference: PostgresObjectReference,
    context: PlainSqlRenderContext,
  ): string {
    if (reference.kind === 'database' || reference.kind === 'schema') {
      return this.q(reference.name, context);
    }
    if (
      reference.kind === 'function' ||
      reference.kind === 'procedure' ||
      reference.kind === 'aggregate'
    ) {
      return `${this.qn(reference.schema, reference.name, context)}(${reference.subName ?? ''})`;
    }
    return this.qn(reference.schema, reference.name, context);
  }

  private entryReference(entry: ArchiveEntry): PostgresObjectReference {
    return {
      kind:
        entry.objectType === 'enum' || entry.objectType === 'domain'
          ? entry.objectType
          : entry.objectType === 'materialized-view'
            ? 'materialized-view'
            : entry.objectType === 'database'
              ? 'database'
              : entry.objectType === 'extension'
                ? 'type'
                : (entry.objectType as PostgresObjectReference['kind']),
      oid: entry.catalogOid ?? 0,
      ...(entry.schema === undefined ? {} : { schema: entry.schema }),
      name: entry.name,
      ...(entry.specificIdentity === '' ? {} : { subName: entry.specificIdentity }),
    };
  }

  private columnIdentity(
    reference: PostgresObjectReference,
    context: PlainSqlRenderContext,
  ): string {
    return `${this.qn(reference.schema, reference.name, context)}.${this.q(reference.subName ?? '', context)}`;
  }

  private routineIdentity(entry: ArchiveEntry, context: PlainSqlRenderContext): string {
    return `${this.qn(entry.schema, entry.name, context)}(${entry.specificIdentity})`;
  }

  private supportFunction(
    reference: PostgresObjectReference,
    context: PlainSqlRenderContext,
  ): string {
    const name = reference.name.replace(/\(.*$/u, '');
    return reference.schema === undefined
      ? name
          .split('.')
          .map((part) => this.q(part.replaceAll(/^"|"$/gu, ''), context))
          .join('.')
      : this.qn(reference.schema, name, context);
  }

  private deferrability(
    constraint: { readonly deferrable: boolean; readonly initiallyDeferred: boolean },
    context: PlainSqlRenderContext,
  ): string {
    if (!constraint.deferrable) return '';
    return ` ${this.k('DEFERRABLE', context)}${constraint.initiallyDeferred ? ` ${this.k('INITIALLY DEFERRED', context)}` : ''}`;
  }

  private isIdentitySequence(context: PlainSqlRenderContext): boolean {
    const sequence = context.entry.sourceObject as Partial<PostgresSequence>;
    if (sequence.ownedBy === undefined) return false;
    return context.archive.entries.some(
      (entry) =>
        entry.objectType === 'column' &&
        entry.catalogOid === sequence.ownedBy!.oid &&
        entry.name === sequence.ownedBy!.subName &&
        (entry.sourceObject as PostgresColumn).identity !== undefined,
    );
  }

  private isConstraintBackingIndex(context: PlainSqlRenderContext): boolean {
    return context.archive.entries.some((entry) => {
      if (entry.objectType !== 'constraint') return false;
      const constraint = entry.sourceObject as Partial<PostgresKeyConstraint>;
      return constraint.backingIndexOid === context.entry.catalogOid;
    });
  }

  private unsupported(
    context: PlainSqlRenderContext,
    feature: string,
    safeToOmit: boolean,
    downgrade?: string,
  ): readonly string[] {
    const policy = context.options.unsupportedFeaturePolicy;
    if (
      policy === 'error' ||
      (!safeToOmit && !(policy === 'warn-downgrade' && downgrade !== undefined))
    ) {
      throw this.error(
        context,
        `Target PostgreSQL ${context.targetVersion.normalizedMajor} does not support ${feature}.`,
      );
    }
    const transformation =
      policy === 'warn-downgrade' && downgrade !== undefined ? downgrade : `${feature} omitted`;
    this.warn(
      context,
      policy === 'warn-downgrade' && downgrade !== undefined
        ? 'compatibility-downgrade'
        : 'compatibility-omission',
      `Target PostgreSQL ${context.targetVersion.normalizedMajor} does not support ${feature}; ${transformation}.`,
      feature,
      transformation,
    );
    return [];
  }

  private unsupportedClause(
    context: PlainSqlRenderContext,
    feature: string,
    safeToOmit: boolean,
  ): string {
    this.unsupported(context, feature, safeToOmit);
    return '';
  }

  private unsupportedObject(context: PlainSqlRenderContext, reason: string): readonly string[] {
    if (context.options.unsupportedFeaturePolicy === 'error') {
      throw this.error(context, `Cannot render ${context.entry.objectType}: ${reason}.`);
    }
    this.warn(context, 'unsupported-object', `Skipped ${context.entry.objectType}: ${reason}.`);
    return [];
  }

  private warn(
    context: PlainSqlRenderContext,
    code:
      | 'unsupported-feature'
      | 'compatibility-omission'
      | 'compatibility-downgrade'
      | 'unsupported-object',
    message: string,
    feature?: string,
    transformation?: string,
  ): void {
    context.warnings.add({
      code,
      message,
      archiveIdentity: context.entry.archiveIdentity,
      dumpId: context.entry.dumpId,
      ...(feature === undefined ? {} : { feature }),
      ...(transformation === undefined ? {} : { transformation }),
    });
  }

  private error(context: PlainSqlRenderContext, message: string): RenderError {
    return new RenderError(`${message} Archive entry: ${context.entry.archiveIdentity}.`);
  }

  private q(value: string, context: PlainSqlRenderContext): string {
    return quoteIdentifier(value, context.identifierPolicy);
  }

  private qn(schema: string | undefined, name: string, context: PlainSqlRenderContext): string {
    return quoteQualifiedIdentifier(
      schema === undefined ? [name] : [schema, name],
      context.identifierPolicy,
    );
  }

  private role(value: string, context: PlainSqlRenderContext): string {
    return quoteRoleName(value, context.identifierPolicy);
  }

  private k(value: string, context: PlainSqlRenderContext): string {
    return keyword(value, context.options.keywordCase);
  }
}
