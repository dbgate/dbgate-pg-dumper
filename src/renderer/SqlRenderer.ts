/**
 * PostgreSQL plain-SQL rendering for individual archive entries.
 *
 * This dispatcher is connection-free and emits bounded statement arrays for a
 * single entry. The outer plain renderer streams those statements immediately.
 */

import type { ArchiveEntry } from '../archive/ArchiveTypes.js';
import type { ArchiveExtension } from '../archive/ArchiveTypes.js';
import type {
  PostgresColumn,
  PostgresDatabase,
  PostgresSchema,
  PostgresTable,
} from '../model/PostgresDatabase.js';
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
import type {
  PostgresEventTrigger,
  PostgresExtension,
  PostgresForeignDataWrapper,
  PostgresForeignServer,
  PostgresForeignTableDefinition,
  PostgresLargeObject,
  PostgresOption,
  PostgresProceduralLanguage,
  PostgresPublication,
  PostgresRole,
  PostgresRoleMembership,
  PostgresStatisticsObject,
  PostgresSubscription,
  PostgresTablespace,
  PostgresUserMapping,
} from '../model/PostgresAdvancedObjects.js';
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
      case 'large-object':
        return this.renderLargeObject(context);
      case 'large-object-data':
        return [];
      case 'large-object-metadata':
        return this.renderLargeObjectMetadata(context);
      case 'foreign-data-wrapper':
        return this.renderForeignDataWrapper(context);
      case 'foreign-server':
        return this.renderForeignServer(context);
      case 'user-mapping':
        return this.renderUserMapping(context);
      case 'event-trigger':
        return this.renderEventTrigger(context);
      case 'procedural-language':
        return this.renderProceduralLanguage(context);
      case 'publication':
        return this.renderPublication(context);
      case 'subscription':
        return this.renderSubscription(context);
      case 'tablespace':
        return this.renderTablespace(context);
      case 'role':
        return this.renderRole(context);
      case 'role-membership':
        return this.renderRoleMembership(context);
      case 'statistics':
        return this.renderStatistics(context);
      case 'security-label':
      case 'text-search-parser':
      case 'text-search-template':
      case 'text-search-dictionary':
      case 'text-search-configuration':
      case 'composite-type':
      case 'range-type':
      case 'base-type':
      case 'cast':
      case 'transform':
      case 'operator':
      case 'operator-family':
      case 'operator-class':
      case 'conversion':
      case 'collation':
        return this.unsupportedObject(context, 'complete rendering metadata is unavailable');
      case 'table-data':
      case 'materialized-view-data':
        return [];
      case 'sequence-state':
        return this.renderSequenceState(context);
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
        if (entry.objectType === 'procedure' && !context.targetCapabilities.procedures) return [];
        const type =
          entry.objectType === 'aggregate' ? 'AGGREGATE' : entry.objectType.toUpperCase();
        return [
          `${this.k(`DROP ${type}`, context)}${ifExists} ${this.routineIdentity(entry, context)}${cascade};`,
        ];
      }
      case 'constraint':
      case 'foreign-key': {
        const constraint = entry.sourceObject as PostgresConstraint;
        if (constraint.kind === 'check' && constraint.domain !== undefined) return [];
        return entry.parent === undefined
          ? []
          : [
              `${this.k('ALTER TABLE', context)} ${this.objectIdentity(entry.parent, context)} ${this.k('DROP CONSTRAINT', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
            ];
      }
      case 'index':
        if (this.indexIsConstraintOwned(entry.sourceObject as PostgresIndex, context)) return [];
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
      case 'foreign-data-wrapper':
        return [
          `${this.k('DROP FOREIGN DATA WRAPPER', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
        ];
      case 'foreign-server':
        return [
          `${this.k('DROP SERVER', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
        ];
      case 'user-mapping': {
        const mapping = entry.sourceObject as PostgresUserMapping;
        return [
          `${this.k('DROP USER MAPPING', context)}${ifExists} ${this.k('FOR', context)} ${mapping.userName === 'PUBLIC' ? this.k('PUBLIC', context) : this.role(mapping.userName, context)} ${this.k('SERVER', context)} ${this.q(mapping.serverName, context)};`,
        ];
      }
      case 'event-trigger':
        return [
          `${this.k('DROP EVENT TRIGGER', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
        ];
      case 'procedural-language':
        return [
          `${this.k('DROP LANGUAGE', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
        ];
      case 'publication':
        if (!context.targetCapabilities.logicalReplication) return [];
        return [
          `${this.k('DROP PUBLICATION', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
        ];
      case 'subscription':
        if (!context.targetCapabilities.logicalReplication) return [];
        return [
          `${this.k('DROP SUBSCRIPTION', context)}${ifExists} ${this.q(entry.name, context)}${cascade};`,
        ];
      case 'tablespace':
        return [`${this.k('DROP TABLESPACE', context)}${ifExists} ${this.q(entry.name, context)};`];
      case 'role':
        return [`${this.k('DROP ROLE', context)}${ifExists} ${this.role(entry.name, context)};`];
      case 'statistics':
        if (!context.targetCapabilities.extendedStatistics) return [];
        return [
          `${this.k('DROP STATISTICS', context)}${ifExists} ${this.qn(entry.schema, entry.name, context)}${cascade};`,
        ];
      case 'large-object':
        return [`${this.k('SELECT', context)} pg_catalog.lo_unlink(${entry.name});`];
      default:
        return [];
    }
  }

  private renderDatabase(context: PlainSqlRenderContext): readonly string[] {
    if (!context.options.includeCreateDatabase) return [];
    const database = context.entry.sourceObject as PostgresDatabase;
    const clauses = [
      `${this.k('CREATE DATABASE', context)} ${this.q(database.name, context)}`,
      `${this.k('WITH OWNER', context)} = ${this.role(this.mapRole(database.owner, context), context)}`,
      `${this.k('ENCODING', context)} = ${quoteStringLiteral(database.encoding)}`,
      `${this.k('LC_COLLATE', context)} = ${quoteStringLiteral(database.collation)}`,
      `${this.k('LC_CTYPE', context)} = ${quoteStringLiteral(database.characterType)}`,
    ];
    if (database.tablespace !== undefined) {
      const tablespace = this.mapTablespace(database.tablespace, context);
      if (tablespace !== undefined) {
        clauses.push(`${this.k('TABLESPACE', context)} = ${this.q(tablespace, context)}`);
      }
    }
    if (database.connectionLimit !== undefined) {
      clauses.push(`${this.k('CONNECTION LIMIT', context)} = ${database.connectionLimit}`);
    }
    if (database.allowConnections !== undefined) {
      clauses.push(
        `${this.k('ALLOW_CONNECTIONS', context)} = ${database.allowConnections ? 'true' : 'false'}`,
      );
    }
    if (database.template !== undefined) {
      clauses.push(`${this.k('IS_TEMPLATE', context)} = ${database.template ? 'true' : 'false'}`);
    }
    const statements = [
      `${clauses.join(` ${context.writer.lineEnding}${context.options.indentation}`)};`,
      `\\connect ${this.q(database.name, context)}`,
    ];
    for (const configuration of database.configuration ?? []) {
      const separator = configuration.indexOf('=');
      if (separator <= 0) continue;
      statements.push(
        `${this.k('ALTER DATABASE', context)} ${this.q(database.name, context)} ${this.k('SET', context)} ${configuration.slice(0, separator)} ${this.k('TO', context)} ${quoteStringLiteral(configuration.slice(separator + 1))};`,
      );
    }
    return statements;
  }

  private renderExtension(context: PlainSqlRenderContext): readonly string[] {
    const extension = context.entry.sourceObject as ArchiveExtension & Partial<PostgresExtension>;
    const ifNotExists = context.options.extensionIfNotExists
      ? ` ${this.k('IF NOT EXISTS', context)}`
      : '';
    const schema =
      extension.schema === undefined
        ? ''
        : ` ${this.k('WITH SCHEMA', context)} ${this.q(extension.schema, context)}`;
    const version =
      context.options.extensionVersion === 'source' && extension.version !== undefined
        ? ` ${this.k('VERSION', context)} ${quoteStringLiteral(extension.version)}`
        : '';
    const statements = [
      `${this.k('CREATE EXTENSION', context)}${ifNotExists} ${this.q(extension.name, context)}${schema}${version};`,
    ];
    const update = context.options.extensionUpdate[extension.name];
    if (update !== undefined) {
      statements.push(
        `${this.k('ALTER EXTENSION', context)} ${this.q(extension.name, context)} ${this.k('UPDATE TO', context)} ${quoteStringLiteral(update)};`,
      );
    }
    return statements;
  }

  private renderSchema(context: PlainSqlRenderContext): readonly string[] {
    const schema = context.entry.sourceObject as PostgresSchema;
    if (schema.name === 'public') return [];
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
      ...(context.targetVersion.major >= 10
        ? [`${this.k('AS', context)} ${sequence.dataType}`]
        : []),
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

  private renderLargeObject(context: PlainSqlRenderContext): readonly string[] {
    const oid = this.largeObjectOid(context);
    return [`${this.k('SELECT', context)} pg_catalog.lo_create(${oid});`];
  }

  private renderLargeObjectMetadata(context: PlainSqlRenderContext): readonly string[] {
    const object = context.entry.sourceObject as PostgresLargeObject;
    const statements: string[] = [];
    if (!context.options.noOwner) {
      statements.push(
        `${this.k('ALTER LARGE OBJECT', context)} ${object.oid} ${this.k('OWNER TO', context)} ${this.role(this.mapRole(object.owner, context), context)};`,
      );
    }
    if (!context.options.noComments && object.comment !== undefined) {
      statements.push(
        `${this.k('COMMENT ON LARGE OBJECT', context)} ${object.oid} ${this.k('IS', context)} ${quoteStringLiteral(object.comment)};`,
      );
    }
    return statements;
  }

  private renderForeignDataWrapper(context: PlainSqlRenderContext): readonly string[] {
    const wrapper = context.entry.sourceObject as PostgresForeignDataWrapper;
    const handler =
      wrapper.handler === undefined
        ? ` ${this.k('NO HANDLER', context)}`
        : ` ${this.k('HANDLER', context)} ${wrapper.handler}`;
    const validator =
      wrapper.validator === undefined
        ? ` ${this.k('NO VALIDATOR', context)}`
        : ` ${this.k('VALIDATOR', context)} ${wrapper.validator}`;
    return [
      `${this.k('CREATE FOREIGN DATA WRAPPER', context)} ${this.q(wrapper.name, context)}${handler}${validator}${this.renderOptions(wrapper.options, context)};`,
    ];
  }

  private renderForeignServer(context: PlainSqlRenderContext): readonly string[] {
    const server = context.entry.sourceObject as PostgresForeignServer;
    const type =
      server.type === undefined
        ? ''
        : ` ${this.k('TYPE', context)} ${quoteStringLiteral(server.type)}`;
    const version =
      server.version === undefined
        ? ''
        : ` ${this.k('VERSION', context)} ${quoteStringLiteral(server.version)}`;
    return [
      `${this.k('CREATE SERVER', context)} ${this.q(server.name, context)}${type}${version} ${this.k('FOREIGN DATA WRAPPER', context)} ${this.q(server.wrapperName, context)}${this.renderOptions(server.options, context)};`,
    ];
  }

  private renderUserMapping(context: PlainSqlRenderContext): readonly string[] {
    const mapping = context.entry.sourceObject as PostgresUserMapping;
    if (mapping.containsSensitiveOptions && context.options.sensitiveValueMode === 'fail') {
      throw this.error(context, 'User mapping contains sensitive options rejected by policy.');
    }
    if (mapping.containsSensitiveOptions && context.options.sensitiveValueMode === 'provide') {
      throw this.error(
        context,
        'Secure callback values must be resolved before synchronous SQL rendering.',
      );
    }
    const user =
      mapping.userName === 'PUBLIC'
        ? this.k('PUBLIC', context)
        : this.role(this.mapRole(mapping.userName, context), context);
    return [
      `${this.k('CREATE USER MAPPING', context)} ${this.k('FOR', context)} ${user} ${this.k('SERVER', context)} ${this.q(mapping.serverName, context)}${this.renderOptions(mapping.options, context)};`,
    ];
  }

  private renderEventTrigger(context: PlainSqlRenderContext): readonly string[] {
    const trigger = context.entry.sourceObject as PostgresEventTrigger;
    const tags =
      trigger.tags.length === 0
        ? ''
        : ` ${this.k('WHEN TAG IN', context)} (${trigger.tags.map(quoteStringLiteral).join(', ')})`;
    const execute = context.targetVersion.major >= 11 ? 'FUNCTION' : 'PROCEDURE';
    const functionIdentity = /\([^)]*\)$/u.test(trigger.function)
      ? trigger.function
      : `${trigger.function}()`;
    const statements = [
      `${this.k('CREATE EVENT TRIGGER', context)} ${this.q(trigger.name, context)} ${this.k('ON', context)} ${trigger.event}${tags} ${this.k(`EXECUTE ${execute}`, context)} ${functionIdentity};`,
    ];
    if (trigger.enabled !== 'origin') {
      const state =
        trigger.enabled === 'disabled'
          ? 'DISABLE'
          : trigger.enabled === 'replica'
            ? 'ENABLE REPLICA'
            : 'ENABLE ALWAYS';
      statements.push(
        `${this.k('ALTER EVENT TRIGGER', context)} ${this.q(trigger.name, context)} ${this.k(state, context)};`,
      );
    }
    return statements;
  }

  private renderProceduralLanguage(context: PlainSqlRenderContext): readonly string[] {
    const language = context.entry.sourceObject as PostgresProceduralLanguage;
    const trusted = language.trusted ? `${this.k('TRUSTED', context)} ` : '';
    const clauses = [
      `${this.k('CREATE', context)} ${trusted}${this.k('LANGUAGE', context)} ${this.q(language.name, context)}`,
    ];
    if (language.handler !== undefined) {
      clauses.push(`${this.k('HANDLER', context)} ${language.handler}`);
    }
    if (language.inlineHandler !== undefined) {
      clauses.push(`${this.k('INLINE', context)} ${language.inlineHandler}`);
    }
    if (language.validator !== undefined) {
      clauses.push(`${this.k('VALIDATOR', context)} ${language.validator}`);
    }
    return [`${clauses.join(` ${context.writer.lineEnding}`)};`];
  }

  private renderPublication(context: PlainSqlRenderContext): readonly string[] {
    if (!context.targetCapabilities.logicalReplication) {
      return this.unsupported(context, 'logical-replication publications', false);
    }
    const publication = context.entry.sourceObject as PostgresPublication;
    const target = publication.allTables
      ? ` ${this.k('FOR ALL TABLES', context)}`
      : publication.tables.length === 0 && publication.schemas.length === 0
        ? ''
        : ` ${this.k('FOR', context)} ${[
            ...publication.schemas.map(
              (schema) => `${this.k('TABLES IN SCHEMA', context)} ${this.q(schema, context)}`,
            ),
            ...publication.tables.map((item) => {
              const columns =
                item.columns.length === 0
                  ? ''
                  : ` (${item.columns.map((column) => this.q(column, context)).join(', ')})`;
              const filter =
                item.rowFilter === undefined
                  ? ''
                  : ` ${this.k('WHERE', context)} (${item.rowFilter})`;
              return `${this.k('TABLE', context)} ${this.objectIdentity(item.table, context)}${columns}${filter}`;
            }),
          ].join(', ')}`;
    const publish = [
      publication.publishInsert ? 'insert' : undefined,
      publication.publishUpdate ? 'update' : undefined,
      publication.publishDelete ? 'delete' : undefined,
      publication.publishTruncate ? 'truncate' : undefined,
    ].flatMap((value) => (value === undefined ? [] : [value]));
    const options = [
      `publish = ${quoteStringLiteral(publish.join(', '))}`,
      ...(publication.publishViaPartitionRoot ? ['publish_via_partition_root = true'] : []),
    ];
    return [
      `${this.k('CREATE PUBLICATION', context)} ${this.q(publication.name, context)}${target} ${this.k('WITH', context)} (${options.join(', ')});`,
    ];
  }

  private renderSubscription(context: PlainSqlRenderContext): readonly string[] {
    if (!context.targetCapabilities.logicalReplication) {
      return this.unsupported(context, 'logical-replication subscriptions', false);
    }
    const subscription = context.entry.sourceObject as PostgresSubscription;
    if (context.options.sensitiveValueMode === 'fail') {
      throw this.error(context, 'Subscription connection information is rejected by policy.');
    }
    if (context.options.sensitiveValueMode === 'provide') {
      throw this.error(
        context,
        'Secure subscription connection information was not resolved before rendering.',
      );
    }
    const connection = quoteStringLiteral(context.options.sensitiveValuePlaceholder);
    const publications = subscription.publications
      .map((publication) => this.q(publication, context))
      .join(', ');
    return [
      `${this.k('CREATE SUBSCRIPTION', context)} ${this.q(subscription.name, context)} ${this.k('CONNECTION', context)} ${connection} ${this.k('PUBLICATION', context)} ${publications} ${this.k('WITH', context)} (connect = false, create_slot = false, enabled = false);`,
    ];
  }

  private renderTablespace(context: PlainSqlRenderContext): readonly string[] {
    const tablespace = context.entry.sourceObject as PostgresTablespace;
    if (context.options.tablespacePolicy === 'omit') return [];
    const mapped = context.options.tablespaceMappings[tablespace.name] ?? tablespace.name;
    if (
      context.options.tablespacePolicy === 'fail-unmapped' &&
      context.options.tablespaceMappings[tablespace.name] === undefined
    ) {
      throw this.error(context, 'Tablespace has no configured target mapping.');
    }
    const options =
      tablespace.options.length === 0
        ? ''
        : ` ${this.k('WITH', context)} (${tablespace.options.join(', ')})`;
    return [
      `${this.k('CREATE TABLESPACE', context)} ${this.q(mapped, context)} ${this.k('OWNER', context)} ${this.role(this.mapRole(tablespace.owner, context), context)} ${this.k('LOCATION', context)} ${quoteStringLiteral(tablespace.location)}${options};`,
    ];
  }

  private renderRole(context: PlainSqlRenderContext): readonly string[] {
    const role = context.entry.sourceObject as PostgresRole;
    const mapped = this.mapRole(role.name, context);
    const attributes = [
      this.k(role.superuser ? 'SUPERUSER' : 'NOSUPERUSER', context),
      this.k(role.inherit ? 'INHERIT' : 'NOINHERIT', context),
      this.k(role.createRole ? 'CREATEROLE' : 'NOCREATEROLE', context),
      this.k(role.createDatabase ? 'CREATEDB' : 'NOCREATEDB', context),
      this.k(role.canLogin ? 'LOGIN' : 'NOLOGIN', context),
      this.k(role.replication ? 'REPLICATION' : 'NOREPLICATION', context),
      this.k(role.bypassRowLevelSecurity ? 'BYPASSRLS' : 'NOBYPASSRLS', context),
      `${this.k('CONNECTION LIMIT', context)} ${role.connectionLimit}`,
      ...(role.validUntil === undefined
        ? []
        : [`${this.k('VALID UNTIL', context)} ${quoteStringLiteral(role.validUntil)}`]),
    ];
    const statements = [
      `${this.k('CREATE ROLE', context)} ${this.role(mapped, context)} ${this.k('WITH', context)} ${attributes.join(' ')};`,
    ];
    for (const configuration of role.configuration) {
      const separator = configuration.indexOf('=');
      if (separator <= 0) continue;
      statements.push(
        `${this.k('ALTER ROLE', context)} ${this.role(mapped, context)} ${this.k('SET', context)} ${configuration.slice(0, separator)} ${this.k('TO', context)} ${quoteStringLiteral(configuration.slice(separator + 1))};`,
      );
    }
    return statements;
  }

  private renderRoleMembership(context: PlainSqlRenderContext): readonly string[] {
    const membership = context.entry.sourceObject as PostgresRoleMembership;
    return [
      `${this.k('GRANT', context)} ${this.role(this.mapRole(membership.role, context), context)} ${this.k('TO', context)} ${this.role(this.mapRole(membership.member, context), context)}${membership.adminOption ? ` ${this.k('WITH ADMIN OPTION', context)}` : ''};`,
    ];
  }

  private renderStatistics(context: PlainSqlRenderContext): readonly string[] {
    if (!context.targetCapabilities.extendedStatistics) {
      return this.unsupported(context, 'extended statistics', false);
    }
    const statistics = context.entry.sourceObject as PostgresStatisticsObject;
    const statements = [ensureStatement(statistics.definition)];
    if (statistics.target !== undefined) {
      statements.push(
        `${this.k('ALTER STATISTICS', context)} ${this.qn(statistics.schema, statistics.name, context)} ${this.k('SET STATISTICS', context)} ${statistics.target};`,
      );
    }
    return statements;
  }

  private renderSequenceState(context: PlainSqlRenderContext): readonly string[] {
    const descriptor = context.entry.dataExport;
    if (
      descriptor?.kind !== 'sequence-state' ||
      descriptor.currentValue === undefined ||
      descriptor.isCalled === undefined
    ) {
      this.warn(context, 'unsupported-object', 'Sequence state is incomplete and was skipped.');
      return [];
    }
    if (!/^-?\d+$/u.test(descriptor.currentValue)) {
      throw this.error(context, 'Sequence current value is not an exact integer.');
    }
    const qualified = quoteQualifiedIdentifier(
      descriptor.schema === undefined ? [descriptor.name] : [descriptor.schema, descriptor.name],
      { quoteAllIdentifiers: true },
    );
    return [
      `${this.k('SELECT', context)} pg_catalog.setval(${quoteStringLiteral(qualified)}::pg_catalog.regclass, ${descriptor.currentValue}, ${descriptor.isCalled ? this.k('true', context) : this.k('false', context)});`,
    ];
  }

  private renderTable(context: PlainSqlRenderContext): readonly string[] {
    const table = context.entry.sourceObject as PostgresTable;
    if (table.kind === 'foreign') {
      return this.renderForeignTable(table, context);
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
        const tablespace = this.mapTablespace(table.tablespace, context);
        if (tablespace !== undefined) {
          clauses.push(`${this.k('TABLESPACE', context)} ${this.q(tablespace, context)}`);
        }
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
    if (table.accessMethod !== undefined && table.accessMethodIsDefault !== true) {
      if (!context.targetCapabilities.tableAccessMethods) {
        this.unsupported(context, 'table access methods', table.accessMethod === 'heap');
      } else {
        clauses.push(`${this.k('USING', context)} ${this.q(table.accessMethod, context)}`);
      }
    }
    if (table.tablespace !== undefined) {
      const tablespace = this.mapTablespace(table.tablespace, context);
      if (tablespace !== undefined) {
        clauses.push(`${this.k('TABLESPACE', context)} ${this.q(tablespace, context)}`);
      }
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
      if (column.storageIsDefault === true) continue;
      statements.push(
        `${this.k('ALTER TABLE', context)} ${name} ${this.k('ALTER COLUMN', context)} ${this.q(column.name, context)} ${this.k('SET STORAGE', context)} ${this.k(column.storage, context)};`,
      );
    }
    return statements;
  }

  private renderForeignTable(
    table: PostgresTable,
    context: PlainSqlRenderContext,
  ): readonly string[] {
    const database = context.archive.entries.find((entry) => entry.objectType === 'database')
      ?.sourceObject as
      { readonly foreignTables?: readonly PostgresForeignTableDefinition[] } | undefined;
    const metadata = database?.foreignTables?.find((item) => item.tableOid === table.oid);
    if (metadata === undefined) {
      return this.unsupportedObject(
        context,
        'foreign table server and option metadata is unavailable',
      );
    }
    const columns = [...table.columns]
      .sort((left, right) => left.ordinalPosition - right.ordinalPosition)
      .map((column) => {
        const columnOptions =
          metadata.columnOptions[column.name] === undefined
            ? ''
            : this.renderOptions(metadata.columnOptions[column.name]!, context);
        return `${context.options.indentation}${this.q(column.name, context)} ${column.formattedType}${columnOptions}`;
      })
      .join(`,${context.writer.lineEnding}`);
    return [
      `${this.k('CREATE FOREIGN TABLE', context)} ${this.qn(table.schema, table.name, context)} (${context.writer.lineEnding}${columns}${context.writer.lineEnding}) ${this.k('SERVER', context)} ${this.q(metadata.serverName, context)}${this.renderOptions(metadata.options, context)};`,
    ];
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
    if (column.collation !== undefined && column.collationIsDefault !== true)
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
      clauses.push(`${this.k('DEFAULT', context)} ${this.renderColumnDefault(column, context)}`);
    }
    if (!column.nullable) clauses.push(this.k('NOT NULL', context));
    return clauses.join(' ');
  }

  private renderColumnDefault(column: PostgresColumn, context: PlainSqlRenderContext): string {
    const expression = column.defaultExpression!;
    if (!/^\s*(?:pg_catalog\.)?nextval\s*\(/iu.test(expression)) return expression;

    const sequenceEntry = context.archive.entries.find((entry) => {
      if (entry.objectType !== 'sequence') return false;
      const sequence = entry.sourceObject as PostgresSequence;
      return (
        sequence.ownership === 'serial' &&
        sequence.ownedBy?.oid === column.tableOid &&
        sequence.ownedBy.subName === column.name
      );
    });
    if (sequenceEntry === undefined) return expression;

    const sequence = sequenceEntry.sourceObject as PostgresSequence;
    const qualifiedName = quoteQualifiedIdentifier([sequence.schema, sequence.name], {
      quoteAllIdentifiers: true,
    });
    return `pg_catalog.nextval(${quoteStringLiteral(qualifiedName)}::pg_catalog.regclass)`;
  }

  private renderConstraint(context: PlainSqlRenderContext): readonly string[] {
    const constraint = context.entry.sourceObject as PostgresConstraint;
    if (constraint.kind === 'foreign-key') return this.renderForeignKey(context);
    if (constraint.kind === 'check' && constraint.domain !== undefined) return [];
    const table = constraint.kind === 'check' ? constraint.table : constraint.table;
    if (table === undefined) return [];
    const tableEntry = context.archive.entries.find(
      (entry) =>
        entry.objectType === 'table' &&
        (entry.catalogOid === table.oid ||
          (entry.schema === table.schema && entry.name === table.name)),
    );
    const tableKind = (tableEntry?.sourceObject as Partial<PostgresTable> | undefined)?.kind;
    const alterTable = tableKind === 'partitioned' ? 'ALTER TABLE' : 'ALTER TABLE ONLY';
    const prefix = `${this.k(alterTable, context)} ${this.objectIdentity(table, context)} ${this.k('ADD CONSTRAINT', context)} ${this.q(constraint.name, context)} `;
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
    const update =
      constraint.onUpdate === 'no-action'
        ? ''
        : ` ${this.k('ON UPDATE', context)} ${this.k(constraint.onUpdate.replace('-', ' '), context)}`;
    const remove =
      constraint.onDelete === 'no-action'
        ? ''
        : ` ${this.k('ON DELETE', context)} ${this.k(constraint.onDelete.replace('-', ' '), context)}`;
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
      if (element.collation !== undefined && element.collationIsDefault !== true)
        pieces.push(`${this.k('COLLATE', context)} ${element.collation}`);
      if (element.operatorClass !== undefined && element.operatorClassIsDefault !== true)
        pieces.push(element.operatorClass);
      const descending = element.direction === 'descending';
      if (descending) pieces.push(this.k('DESC', context));
      const defaultNulls = descending ? 'first' : 'last';
      if (element.nulls !== undefined && element.nulls !== defaultNulls)
        pieces.push(this.k(`NULLS ${element.nulls}`, context));
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
      const tablespace = this.mapTablespace(index.tablespace, context);
      if (tablespace !== undefined) {
        clauses.push(`${this.k('TABLESPACE', context)} ${this.q(tablespace, context)}`);
      }
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

  private indexIsConstraintOwned(index: PostgresIndex, context: PlainSqlRenderContext): boolean {
    if (!index.exportable || index.primary) return true;
    return context.archive.entries.some((entry) => {
      if (entry.objectType !== 'constraint') return false;
      const constraint = entry.sourceObject as Partial<PostgresKeyConstraint>;
      return constraint.backingIndexOid === index.oid;
    });
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
      const tablespace = this.mapTablespace(view.tablespace, context);
      if (tablespace !== undefined) {
        clauses.push(`${this.k('TABLESPACE', context)} ${this.q(tablespace, context)}`);
      }
    }
    clauses.push(
      `${this.k('AS', context)}${context.writer.lineEnding}${view.definition.trim().replace(/;$/u, '')}`,
    );
    if (!view.populated) clauses.push(this.k('WITH NO DATA', context));
    return [`${clauses.join(` ${context.writer.lineEnding}${context.options.indentation}`)};`];
  }

  private renderFunction(context: PlainSqlRenderContext): readonly string[] {
    const routine = context.entry.sourceObject as PostgresFunction;
    if (
      routine.supportFunction !== undefined &&
      !context.targetCapabilities.functionSupportFunctions
    ) {
      return this.unsupported(context, 'function planner support functions', false);
    }
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
      `${this.k('ALTER', context)} ${target} ${this.k('OWNER TO', context)} ${this.role(this.mapRole(ownership.owner, context), context)};`,
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
      `${this.k('GRANT', context)} ${this.k(acl.privilege, context)} ${this.k('ON', context)} ${target} ${this.k('TO', context)} ${acl.grantee === 'PUBLIC' ? this.k('PUBLIC', context) : this.role(this.mapRole(acl.grantee, context), context)}${acl.grantOption ? ` ${this.k('WITH GRANT OPTION', context)}` : ''};`,
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
      (!safeToOmit &&
        policy !== 'warn-skip' &&
        !(policy === 'warn-downgrade' && downgrade !== undefined))
    ) {
      throw this.error(
        context,
        `Target PostgreSQL ${context.targetVersion.normalizedMajor} does not support ${feature}.`,
      );
    }
    const transformation =
      (policy === 'warn-downgrade' || policy === 'warn-skip') && downgrade !== undefined
        ? downgrade
        : `${feature} omitted`;
    this.warn(
      context,
      (policy === 'warn-downgrade' || policy === 'warn-skip') && downgrade !== undefined
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

  private mapRole(value: string, context: PlainSqlRenderContext): string {
    return context.options.roleMappings[value] ?? value;
  }

  private mapTablespace(value: string, context: PlainSqlRenderContext): string | undefined {
    if (context.options.tablespacePolicy === 'omit') return undefined;
    const mapped = context.options.tablespaceMappings[value];
    if (context.options.tablespacePolicy === 'fail-unmapped' && mapped === undefined) {
      throw this.error(context, 'Referenced tablespace has no configured target mapping.');
    }
    return mapped ?? value;
  }

  private renderOptions(
    options: readonly PostgresOption[],
    context: PlainSqlRenderContext,
  ): string {
    const rendered = options.flatMap((option) => {
      if (option.sensitive) {
        if (context.options.sensitiveValueMode === 'omit') return [];
        if (context.options.sensitiveValueMode === 'fail') {
          throw this.error(context, 'Sensitive object option was rejected by policy.');
        }
        if (context.options.sensitiveValueMode === 'provide') {
          throw this.error(
            context,
            'Secure option callback values were not resolved before rendering.',
          );
        }
        return [
          `${this.q(option.name, context)} ${quoteStringLiteral(context.options.sensitiveValuePlaceholder)}`,
        ];
      }
      return [`${this.q(option.name, context)} ${quoteStringLiteral(option.value ?? '')}`];
    });
    return rendered.length === 0 ? '' : ` ${this.k('OPTIONS', context)} (${rendered.join(', ')})`;
  }

  private largeObjectOid(context: PlainSqlRenderContext): number {
    const oid = Number(context.entry.name);
    if (!Number.isSafeInteger(oid) || oid <= 0) {
      throw this.error(context, 'Large-object OID is invalid.');
    }
    return oid;
  }

  private k(value: string, context: PlainSqlRenderContext): string {
    return keyword(value, context.options.keywordCase);
  }
}
