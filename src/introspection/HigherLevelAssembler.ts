/**
 * Pure assembly of views, routines, triggers, rules, comments, and security.
 *
 * This module resolves catalog OIDs against the already assembled structural
 * model. Recoverable inconsistencies become structured diagnostics instead of
 * silently dropping metadata or leaking raw PostgreSQL rows into the model.
 */

import type { PostgresDatabase, PostgresTable } from '../model/PostgresDatabase.js';
import type {
  PostgresAccessControlEntry,
  PostgresAggregate,
  PostgresAggregateKind,
  PostgresComment,
  PostgresDefaultPrivilege,
  PostgresDefaultPrivilegeObjectType,
  PostgresFunction,
  PostgresMaterializedView,
  PostgresMaterializedViewIndex,
  PostgresOwnership,
  PostgresParallelSafety,
  PostgresPolicy,
  PostgresPolicyCommand,
  PostgresProcedure,
  PostgresRoutineVolatility,
  PostgresRule,
  PostgresRuleEnabled,
  PostgresRuleEvent,
  PostgresTrigger,
  PostgresTriggerEnabled,
  PostgresTriggerEvent,
  PostgresTriggerTiming,
  PostgresView,
  PostgresViewCheckOption,
} from '../model/PostgresHigherLevelObjects.js';
import type {
  PostgresObjectKind,
  PostgresObjectReference,
} from '../model/PostgresStructuralObjects.js';
import type { NormalizedDumpSelection } from '../selection/Selection.js';
import { isSchemaSelected } from '../selection/Selection.js';
import type { SourceCapabilities } from '../version/SourceCapabilities.js';
import type { IntrospectionDiagnostic } from './diagnostics.js';
import { IntrospectionDiagnostics } from './diagnostics.js';
import type {
  AclCatalogRow,
  AggregateCatalogRow,
  CommentCatalogRow,
  DefaultPrivilegeCatalogRow,
  DependencyCatalogRow,
  MaterializedViewIndexCatalogRow,
  PolicyCatalogRow,
  RoleCatalogRow,
  RoutineCatalogRow,
  RuleCatalogRow,
  TriggerCatalogRow,
  ViewCatalogRow,
  ViewColumnCatalogRow,
} from './higherCatalogTypes.js';

export interface HigherCatalogSnapshot {
  readonly roles: readonly RoleCatalogRow[];
  readonly views: readonly ViewCatalogRow[];
  readonly viewColumns: readonly ViewColumnCatalogRow[];
  readonly materializedViewIndexes: readonly MaterializedViewIndexCatalogRow[];
  readonly routines: readonly RoutineCatalogRow[];
  readonly aggregates: readonly AggregateCatalogRow[];
  readonly triggers: readonly TriggerCatalogRow[];
  readonly rules: readonly RuleCatalogRow[];
  readonly policies: readonly PolicyCatalogRow[];
  readonly comments: readonly CommentCatalogRow[];
  readonly acls: readonly AclCatalogRow[];
  readonly defaultPrivileges: readonly DefaultPrivilegeCatalogRow[];
  readonly dependencies: readonly DependencyCatalogRow[];
}

export interface HigherAssemblyResult {
  readonly database: PostgresDatabase;
  readonly diagnostics: readonly IntrospectionDiagnostic[];
}

interface ObjectLookup {
  readonly byKey: ReadonlyMap<string, PostgresObjectReference>;
  readonly byCatalogKey: ReadonlyMap<string, PostgresObjectReference>;
  readonly columns: ReadonlyMap<string, PostgresObjectReference>;
  readonly routines: ReadonlyMap<number, PostgresObjectReference>;
}

function columnKey(oid: number, subId: number): string {
  return `${oid}:${subId}`;
}

function objectKey(kind: string, oid: number): string {
  return `${kind}:${oid}`;
}

function reference(
  kind: PostgresObjectKind,
  oid: number,
  name: string,
  schema?: string,
  subName?: string,
): PostgresObjectReference {
  return {
    kind,
    oid,
    name,
    ...(schema === undefined ? {} : { schema }),
    ...(subName === undefined ? {} : { subName }),
  };
}

function tableReference(table: PostgresTable): PostgresObjectReference {
  return reference('table', table.oid, table.name, table.schema);
}

export class HigherLevelAssembler {
  assemble(
    database: PostgresDatabase,
    snapshot: HigherCatalogSnapshot,
    selection: NormalizedDumpSelection,
    capabilities: SourceCapabilities,
  ): HigherAssemblyResult {
    const diagnostics = new IntrospectionDiagnostics();
    const selectedViews = snapshot.views.filter((row) =>
      isSchemaSelected(row.schema_name, selection),
    );
    const selectedRoutines = snapshot.routines.filter((row) =>
      isSchemaSelected(row.schema_name, selection),
    );
    const selectedAggregates = snapshot.aggregates.filter((row) =>
      isSchemaSelected(row.schema_name, selection),
    );
    const columns = this.groupViewColumns(snapshot.viewColumns);
    const indexes = this.groupMaterializedIndexes(snapshot.materializedViewIndexes);
    const dependencyRows = this.groupDependencies(snapshot.dependencies);

    const views: PostgresView[] = [];
    const materializedViews: PostgresMaterializedView[] = [];
    for (const row of selectedViews) {
      const dependencies = this.mapDependencies(
        dependencyRows.get(`view:${row.oid}`) ?? [],
        diagnostics,
        row.oid,
        `${row.schema_name}.${row.view_name}`,
        'unresolved-view-dependency',
      );
      const options = new Set(row.storage_parameters ?? []);
      if (row.relation_kind === 'v') {
        views.push({
          oid: row.oid,
          schema: row.schema_name,
          name: row.view_name,
          owner: row.owner,
          definition: row.definition,
          columns: columns.get(row.oid) ?? [],
          persistence: this.mapPersistence(row.persistence),
          securityBarrier: options.has('security_barrier=true'),
          ...(capabilities.securityInvokerViews
            ? { securityInvoker: options.has('security_invoker=true') }
            : {}),
          checkOption: this.mapViewCheckOption(options),
          dependencies,
        });
      } else if (row.relation_kind === 'm') {
        if (row.definition.trim() === '') {
          diagnostics.add({
            code: 'invalid-materialized-view',
            severity: 'warning',
            message: 'A materialized view has an empty catalog definition.',
            objectOid: row.oid,
            objectIdentity: `${row.schema_name}.${row.view_name}`,
          });
        }
        materializedViews.push({
          oid: row.oid,
          schema: row.schema_name,
          name: row.view_name,
          owner: row.owner,
          definition: row.definition,
          columns: columns.get(row.oid) ?? [],
          persistence: this.mapPersistence(row.persistence),
          ...(row.tablespace === null ? {} : { tablespace: row.tablespace }),
          ...(row.access_method === null ? {} : { accessMethod: row.access_method }),
          storageParameters: row.storage_parameters ?? [],
          populated: row.populated,
          indexes: indexes.get(row.oid) ?? [],
          dependencies,
        });
      } else {
        diagnostics.add({
          code: 'unsupported-object-kind',
          severity: 'warning',
          message: 'An unsupported relation kind was returned by view introspection.',
          objectOid: row.oid,
          objectIdentity: `${row.schema_name}.${row.view_name}`,
        });
      }
    }

    const routineLookup = new Map<number, PostgresObjectReference>();
    for (const row of selectedRoutines) {
      routineLookup.set(
        row.oid,
        reference(
          row.routine_kind === 'p' ? 'procedure' : 'function',
          row.oid,
          row.routine_name,
          row.schema_name,
          row.identity_arguments,
        ),
      );
    }
    for (const row of selectedAggregates) {
      routineLookup.set(
        row.oid,
        reference(
          'aggregate',
          row.oid,
          row.aggregate_name,
          row.schema_name,
          row.identity_arguments,
        ),
      );
    }

    const functions: PostgresFunction[] = [];
    const procedures: PostgresProcedure[] = [];
    for (const row of selectedRoutines) {
      const dependencies = this.mapDependencies(
        dependencyRows.get(`function:${row.oid}`) ?? [],
        diagnostics,
        row.oid,
        `${row.schema_name}.${row.routine_name}(${row.identity_arguments})`,
        'unresolved-function-type',
      );
      const base = {
        oid: row.oid,
        schema: row.schema_name,
        name: row.routine_name,
        owner: row.owner,
        identityArguments: row.identity_arguments,
        arguments: row.arguments,
        language: row.language,
        source: row.source,
        definition: row.definition,
        securityDefiner: row.security_definer,
        configuration: row.configuration ?? [],
        argumentTypeOids: row.argument_type_oids,
        resultTypeOid: row.result_type_oid,
        dependencies,
      };
      if (row.routine_kind === 'p') {
        procedures.push({ ...base, result: row.result });
      } else {
        const supportFunction =
          row.support_function_oid === 0 ||
          row.support_function_schema === null ||
          row.support_function_name === null
            ? undefined
            : reference(
                'function',
                row.support_function_oid,
                row.support_function_name,
                row.support_function_schema,
                row.support_function_identity_arguments ?? undefined,
              );
        functions.push({
          ...base,
          routineKind: row.routine_kind === 'w' ? 'window' : 'function',
          resultType: row.result,
          volatility: this.mapVolatility(row.volatility),
          strict: row.strict,
          leakproof: row.leakproof,
          parallelSafety: this.mapParallelSafety(row.parallel_safety),
          estimatedCost: row.estimated_cost,
          estimatedRows: row.estimated_rows,
          ...(supportFunction === undefined ? {} : { supportFunction }),
          transformTypeOids: row.transform_type_oids ?? [],
        });
      }
    }

    const aggregates = selectedAggregates.map((row) =>
      this.mapAggregate(row, routineLookup, dependencyRows, diagnostics),
    );
    const relationLookup = this.createRelationLookup(database, views, materializedViews);
    const triggers = this.mapTriggers(
      snapshot.triggers,
      relationLookup,
      routineLookup,
      dependencyRows,
      diagnostics,
    );
    const rules = this.mapRules(snapshot.rules, relationLookup, dependencyRows, diagnostics);
    const policies = this.mapPolicies(
      snapshot.policies,
      relationLookup,
      dependencyRows,
      diagnostics,
    );

    const lookup = this.createObjectLookup(
      database,
      views,
      materializedViews,
      functions,
      procedures,
      aggregates,
      triggers,
      rules,
      policies,
    );
    const comments = this.mapComments(snapshot.comments, database.oid, lookup);
    const accessControls = this.mapAcls(snapshot.acls, lookup, diagnostics);
    const defaultPrivileges = this.mapDefaultPrivileges(snapshot.defaultPrivileges, diagnostics);
    const ownerships = this.createOwnerships(
      database,
      lookup,
      snapshot.roles,
      [
        ...selectedViews.map((row) => [row.oid, row.owner, row.owner_oid] as const),
        ...selectedRoutines.map((row) => [row.oid, row.owner, row.owner_oid] as const),
        ...selectedAggregates.map((row) => [row.oid, row.owner, row.owner_oid] as const),
      ],
      diagnostics,
    );

    if (!capabilities.procedures) {
      // Intentionally empty: the query builder avoids unsupported prokind values.
    }
    if (!capabilities.securityInvokerViews && views.length > 0) {
      diagnostics.add({
        code: 'unsupported-catalog-metadata',
        severity: 'warning',
        message: 'Security-invoker view metadata is unavailable on this source version.',
      });
    }

    return {
      database: {
        ...database,
        views,
        materializedViews,
        functions,
        procedures,
        aggregates,
        triggers,
        rules,
        policies,
        comments,
        ownerships,
        accessControls,
        defaultPrivileges,
      },
      diagnostics: diagnostics.getAll(),
    };
  }

  private groupViewColumns(
    rows: readonly ViewColumnCatalogRow[],
  ): ReadonlyMap<number, PostgresView['columns']> {
    const result = new Map<number, PostgresView['columns'][number][]>();
    for (const row of rows) {
      const values = result.get(row.relation_oid) ?? [];
      values.push({
        attributeNumber: row.attribute_number,
        name: row.column_name,
        formattedType: row.formatted_type,
        typeOid: row.type_oid,
      });
      result.set(row.relation_oid, values);
    }
    return result;
  }

  private groupMaterializedIndexes(
    rows: readonly MaterializedViewIndexCatalogRow[],
  ): ReadonlyMap<number, PostgresMaterializedViewIndex[]> {
    const result = new Map<number, PostgresMaterializedViewIndex[]>();
    for (const row of rows) {
      const values = result.get(row.view_oid) ?? [];
      values.push({
        kind: 'index',
        oid: row.index_oid,
        schema: row.schema_name,
        name: row.index_name,
        definition: row.definition,
        valid: row.valid,
        ready: row.ready,
      });
      result.set(row.view_oid, values);
    }
    return result;
  }

  private groupDependencies(
    rows: readonly DependencyCatalogRow[],
  ): ReadonlyMap<string, DependencyCatalogRow[]> {
    const result = new Map<string, DependencyCatalogRow[]>();
    for (const row of rows) {
      const key = `${row.source_kind}:${row.source_oid}`;
      const values = result.get(key) ?? [];
      values.push(row);
      result.set(key, values);
    }
    return result;
  }

  private mapDependencies(
    rows: readonly DependencyCatalogRow[],
    diagnostics: IntrospectionDiagnostics,
    sourceOid: number,
    identity: string,
    diagnosticCode: 'unresolved-function-type' | 'unresolved-view-dependency',
  ): readonly PostgresObjectReference[] {
    const result = new Map<string, PostgresObjectReference>();
    for (const row of rows) {
      if (row.referenced_oid === sourceOid && row.referenced_class.endsWith('pg_class')) continue;
      const mapped = this.mapDependencyReference(row);
      if (mapped === undefined) {
        if (
          row.referenced_class.endsWith('pg_class') ||
          row.referenced_class.endsWith('pg_proc') ||
          row.referenced_class.endsWith('pg_type')
        ) {
          diagnostics.add({
            code: diagnosticCode,
            severity: 'warning',
            message: 'A catalog dependency could not be resolved to a normalized object.',
            objectOid: sourceOid,
            objectIdentity: identity,
          });
        }
        continue;
      }
      result.set(`${mapped.kind}:${mapped.oid}:${mapped.subName ?? ''}`, mapped);
    }
    return [...result.values()];
  }

  private mapDependencyReference(row: DependencyCatalogRow): PostgresObjectReference | undefined {
    if (row.referenced_name === null) return undefined;
    if (row.referenced_class.endsWith('pg_proc')) {
      return reference(
        'function',
        row.referenced_oid,
        row.referenced_name,
        row.referenced_schema ?? undefined,
        row.referenced_identity_arguments ?? undefined,
      );
    }
    if (row.referenced_class.endsWith('pg_type')) {
      return reference(
        'type',
        row.referenced_oid,
        row.referenced_name,
        row.referenced_schema ?? undefined,
      );
    }
    if (row.referenced_class.endsWith('pg_class')) {
      const kind =
        row.referenced_relation_kind === 'v'
          ? 'view'
          : row.referenced_relation_kind === 'm'
            ? 'materialized-view'
            : row.referenced_relation_kind === 'S'
              ? 'sequence'
              : 'table';
      return reference(
        kind,
        row.referenced_oid,
        row.referenced_name,
        row.referenced_schema ?? undefined,
        row.referenced_sub_id === 0 ? undefined : String(row.referenced_sub_id),
      );
    }
    return undefined;
  }

  private mapAggregate(
    row: AggregateCatalogRow,
    routines: ReadonlyMap<number, PostgresObjectReference>,
    dependencyRows: ReadonlyMap<string, DependencyCatalogRow[]>,
    diagnostics: IntrospectionDiagnostics,
  ): PostgresAggregate {
    const ownReference = reference(
      'aggregate',
      row.oid,
      row.aggregate_name,
      row.schema_name,
      row.identity_arguments,
    );
    const routineReference = (oid: number, rawName: string | null) =>
      oid === 0
        ? undefined
        : (routines.get(oid) ?? reference('function', oid, rawName ?? String(oid)));
    const typeReference = (oid: number, name: string | null) =>
      oid === 0 || name === null ? undefined : reference('type', oid, name);
    const dependencies = [
      ...this.mapDependencies(
        dependencyRows.get(`function:${row.oid}`) ?? [],
        diagnostics,
        row.oid,
        `${row.schema_name}.${row.aggregate_name}(${row.identity_arguments})`,
        'unresolved-function-type',
      ),
      routineReference(row.transition_function_oid, row.transition_function_name),
      routineReference(row.final_function_oid, row.final_function_name),
      routineReference(row.combine_function_oid, row.combine_function_name),
      routineReference(row.serialization_function_oid, row.serialization_function_name),
      routineReference(row.deserialization_function_oid, row.deserialization_function_name),
      routineReference(row.moving_transition_function_oid, row.moving_transition_function_name),
      routineReference(row.moving_inverse_function_oid, row.moving_inverse_function_name),
      routineReference(row.moving_final_function_oid, row.moving_final_function_name),
      typeReference(row.state_type_oid, row.state_type_name),
      typeReference(row.moving_state_type_oid, row.moving_state_type_name),
    ].filter(
      (value): value is PostgresObjectReference =>
        value !== undefined &&
        !(value.oid === ownReference.oid && value.kind === ownReference.kind),
    );
    return {
      oid: row.oid,
      schema: row.schema_name,
      name: row.aggregate_name,
      owner: row.owner,
      identityArguments: row.identity_arguments,
      arguments: row.arguments,
      aggregateKind: this.mapAggregateKind(row.aggregate_kind),
      parallelSafety: this.mapParallelSafety(row.parallel_safety),
      ...(routineReference(row.transition_function_oid, row.transition_function_name) === undefined
        ? {}
        : {
            transitionFunction: routineReference(
              row.transition_function_oid,
              row.transition_function_name,
            )!,
          }),
      ...(typeReference(row.state_type_oid, row.state_type_name) === undefined
        ? {}
        : { stateType: typeReference(row.state_type_oid, row.state_type_name)! }),
      stateTypeName: row.state_type_name,
      ...(routineReference(row.final_function_oid, row.final_function_name) === undefined
        ? {}
        : { finalFunction: routineReference(row.final_function_oid, row.final_function_name)! }),
      ...(routineReference(row.combine_function_oid, row.combine_function_name) === undefined
        ? {}
        : {
            combineFunction: routineReference(row.combine_function_oid, row.combine_function_name)!,
          }),
      ...(routineReference(row.serialization_function_oid, row.serialization_function_name) ===
      undefined
        ? {}
        : {
            serializationFunction: routineReference(
              row.serialization_function_oid,
              row.serialization_function_name,
            )!,
          }),
      ...(routineReference(row.deserialization_function_oid, row.deserialization_function_name) ===
      undefined
        ? {}
        : {
            deserializationFunction: routineReference(
              row.deserialization_function_oid,
              row.deserialization_function_name,
            )!,
          }),
      ...(routineReference(
        row.moving_transition_function_oid,
        row.moving_transition_function_name,
      ) === undefined
        ? {}
        : {
            movingTransitionFunction: routineReference(
              row.moving_transition_function_oid,
              row.moving_transition_function_name,
            )!,
          }),
      ...(routineReference(row.moving_inverse_function_oid, row.moving_inverse_function_name) ===
      undefined
        ? {}
        : {
            movingInverseFunction: routineReference(
              row.moving_inverse_function_oid,
              row.moving_inverse_function_name,
            )!,
          }),
      ...(routineReference(row.moving_final_function_oid, row.moving_final_function_name) ===
      undefined
        ? {}
        : {
            movingFinalFunction: routineReference(
              row.moving_final_function_oid,
              row.moving_final_function_name,
            )!,
          }),
      ...(typeReference(row.moving_state_type_oid, row.moving_state_type_name) === undefined
        ? {}
        : {
            movingStateType: typeReference(row.moving_state_type_oid, row.moving_state_type_name)!,
          }),
      ...(row.initial_condition === null ? {} : { initialCondition: row.initial_condition }),
      ...(row.moving_initial_condition === null
        ? {}
        : { movingInitialCondition: row.moving_initial_condition }),
      ...(row.sort_operator === null ? {} : { sortOperator: row.sort_operator }),
      transitionSpace: row.transition_space,
      movingTransitionSpace: row.moving_transition_space,
      directArgumentCount: row.direct_argument_count,
      dependencies,
    };
  }

  private createRelationLookup(
    database: PostgresDatabase,
    views: readonly PostgresView[],
    materializedViews: readonly PostgresMaterializedView[],
  ): ReadonlyMap<number, PostgresObjectReference> {
    return new Map([
      ...database.schemas.flatMap((schema) =>
        schema.tables.map((table) => [table.oid, tableReference(table)] as const),
      ),
      ...views.map(
        (view) => [view.oid, reference('view', view.oid, view.name, view.schema)] as const,
      ),
      ...materializedViews.map(
        (view) =>
          [view.oid, reference('materialized-view', view.oid, view.name, view.schema)] as const,
      ),
    ]);
  }

  private mapTriggers(
    rows: readonly TriggerCatalogRow[],
    relations: ReadonlyMap<number, PostgresObjectReference>,
    routines: ReadonlyMap<number, PostgresObjectReference>,
    dependencyRows: ReadonlyMap<string, DependencyCatalogRow[]>,
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresTrigger[] {
    return rows.flatMap((row) => {
      if (row.internal) {
        return [];
      }
      const table =
        relations.get(row.table_oid) ??
        reference('table', row.table_oid, row.table_name, row.table_schema);
      const triggerFunction =
        routines.get(row.function_oid) ??
        (row.function_schema === null || row.function_name === null
          ? undefined
          : reference(
              'function',
              row.function_oid,
              row.function_name,
              row.function_schema,
              row.function_identity_arguments ?? undefined,
            ));
      if (triggerFunction === undefined) {
        diagnostics.add({
          code: 'missing-trigger-function',
          severity: 'warning',
          message: 'A trigger function could not be resolved.',
          objectOid: row.oid,
          objectIdentity: `${row.table_schema}.${row.table_name}.${row.trigger_name}`,
        });
        return [];
      }
      const referencedRelation =
        row.referenced_relation_oid === 0
          ? undefined
          : (relations.get(row.referenced_relation_oid) ??
            (row.referenced_relation_schema === null || row.referenced_relation_name === null
              ? undefined
              : reference(
                  'table',
                  row.referenced_relation_oid,
                  row.referenced_relation_name,
                  row.referenced_relation_schema,
                )));
      const whenExpression = row.when_expression ?? this.extractTriggerWhen(row.definition);
      return [
        {
          oid: row.oid,
          schema: row.table_schema,
          name: row.trigger_name,
          table,
          definition: row.definition,
          enabled: this.mapEnabled(row.enabled),
          timing: this.mapTriggerTiming(row.trigger_type),
          events: this.mapTriggerEvents(row.trigger_type),
          level: (row.trigger_type & 1) !== 0 ? 'row' : 'statement',
          function: triggerFunction,
          ...(whenExpression === undefined ? {} : { when: whenExpression }),
          constraint: row.constraint_oid !== 0,
          deferrable: row.deferrable,
          initiallyDeferred: row.initially_deferred,
          ...(referencedRelation === undefined ? {} : { referencedRelation }),
          ...(row.old_transition_table === null
            ? {}
            : { oldTransitionTable: row.old_transition_table }),
          ...(row.new_transition_table === null
            ? {}
            : { newTransitionTable: row.new_transition_table }),
          ...(row.parent_trigger_oid === 0 ? {} : { parentTriggerOid: row.parent_trigger_oid }),
          dependencies: [
            table,
            triggerFunction,
            ...(referencedRelation === undefined ? [] : [referencedRelation]),
            ...this.mapDependencies(
              dependencyRows.get(`trigger:${row.oid}`) ?? [],
              diagnostics,
              row.oid,
              `${row.table_schema}.${row.trigger_name}`,
              'unresolved-function-type',
            ),
          ],
        },
      ];
    });
  }

  private mapRules(
    rows: readonly RuleCatalogRow[],
    relations: ReadonlyMap<number, PostgresObjectReference>,
    dependencyRows: ReadonlyMap<string, DependencyCatalogRow[]>,
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresRule[] {
    return rows.flatMap((row) => {
      if (row.rule_name === '_RETURN') {
        return [];
      }
      const relation =
        relations.get(row.relation_oid) ??
        reference('table', row.relation_oid, row.relation_name, row.relation_schema);
      return [
        {
          oid: row.oid,
          schema: row.relation_schema,
          name: row.rule_name,
          relation,
          definition: row.definition,
          enabled: this.mapRuleEnabled(row.enabled),
          event: this.mapRuleEvent(row.event_type),
          instead: row.instead,
          dependencies: [
            relation,
            ...this.mapDependencies(
              dependencyRows.get(`rule:${row.oid}`) ?? [],
              diagnostics,
              row.oid,
              `${row.relation_schema}.${row.rule_name}`,
              'unresolved-view-dependency',
            ),
          ],
        },
      ];
    });
  }

  private mapPolicies(
    rows: readonly PolicyCatalogRow[],
    relations: ReadonlyMap<number, PostgresObjectReference>,
    dependencyRows: ReadonlyMap<string, DependencyCatalogRow[]>,
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresPolicy[] {
    return rows.flatMap((row) => {
      const table = relations.get(row.table_oid);
      if (table === undefined) return [];
      return [
        {
          oid: row.oid,
          schema: row.table_schema,
          name: row.policy_name,
          table,
          command: this.mapPolicyCommand(row.command),
          permissive: row.permissive,
          roles: row.roles,
          ...(row.using_expression === null ? {} : { usingExpression: row.using_expression }),
          ...(row.check_expression === null ? {} : { checkExpression: row.check_expression }),
          dependencies: [
            table,
            ...this.mapDependencies(
              dependencyRows.get(`policy:${row.oid}`) ?? [],
              diagnostics,
              row.oid,
              `${row.table_schema}.${row.policy_name}`,
              'unresolved-view-dependency',
            ),
          ],
        },
      ];
    });
  }

  private createObjectLookup(
    database: PostgresDatabase,
    views: readonly PostgresView[],
    materializedViews: readonly PostgresMaterializedView[],
    functions: readonly PostgresFunction[],
    procedures: readonly PostgresProcedure[],
    aggregates: readonly PostgresAggregate[],
    triggers: readonly PostgresTrigger[],
    rules: readonly PostgresRule[],
    policies: readonly PostgresPolicy[],
  ): ObjectLookup {
    const byKey = new Map<string, PostgresObjectReference>();
    const byCatalogKey = new Map<string, PostgresObjectReference>();
    const columns = new Map<string, PostgresObjectReference>();
    const register = (
      object: PostgresObjectReference,
      catalog: string,
      aliases: readonly string[] = [],
    ) => {
      byKey.set(objectKey(object.kind, object.oid), object);
      for (const alias of aliases) byKey.set(objectKey(alias, object.oid), object);
      byCatalogKey.set(objectKey(catalog, object.oid), object);
    };
    register(reference('database', database.oid, database.name), 'pg_database');
    for (const schema of database.schemas) {
      register(reference('schema', schema.oid, schema.name, schema.name), 'pg_namespace');
      for (const table of schema.tables) {
        register(tableReference(table), 'pg_class');
        for (const column of table.columns) {
          columns.set(
            columnKey(table.oid, column.attributeNumber),
            reference('column', table.oid, table.name, table.schema, column.name),
          );
        }
      }
      for (const sequence of schema.sequences) {
        register(reference('sequence', sequence.oid, sequence.name, sequence.schema), 'pg_class');
      }
      for (const type of [...schema.enumTypes, ...schema.domains]) {
        register(
          reference('baseTypeOid' in type ? 'domain' : 'enum', type.oid, type.name, type.schema),
          'pg_type',
          ['type'],
        );
      }
    }
    for (const constraint of database.constraints) {
      register(
        reference('constraint', constraint.oid, constraint.name, constraint.schema),
        'pg_constraint',
      );
    }
    for (const index of database.indexes) {
      register(reference('index', index.oid, index.name, index.schema), 'pg_class');
    }
    const routines = new Map<number, PostgresObjectReference>();
    for (const object of views) {
      register(reference('view', object.oid, object.name, object.schema), 'pg_class');
      for (const column of object.columns) {
        columns.set(
          columnKey(object.oid, column.attributeNumber),
          reference('column', object.oid, object.name, object.schema, column.name),
        );
      }
    }
    for (const object of materializedViews) {
      register(reference('materialized-view', object.oid, object.name, object.schema), 'pg_class');
      for (const column of object.columns) {
        columns.set(
          columnKey(object.oid, column.attributeNumber),
          reference('column', object.oid, object.name, object.schema, column.name),
        );
      }
      for (const index of object.indexes) register(index, 'pg_class');
    }
    for (const [kind, objects] of [
      ['function', functions],
      ['procedure', procedures],
      ['aggregate', aggregates],
    ] as const) {
      for (const object of objects) {
        const item = reference(
          kind,
          object.oid,
          object.name,
          object.schema,
          object.identityArguments,
        );
        register(item, 'pg_proc');
        routines.set(object.oid, item);
      }
    }
    for (const [kind, objects] of [
      ['trigger', triggers],
      ['rule', rules],
      ['policy', policies],
    ] as const) {
      for (const object of objects) {
        register(
          reference(kind, object.oid, object.name, object.schema),
          kind === 'trigger' ? 'pg_trigger' : kind === 'rule' ? 'pg_rewrite' : 'pg_policy',
        );
      }
    }
    return { byKey, byCatalogKey, columns, routines };
  }

  private mapComments(
    rows: readonly CommentCatalogRow[],
    databaseOid: number,
    lookup: ObjectLookup,
  ): readonly PostgresComment[] {
    return rows.flatMap((row) => {
      if (row.catalog_kind.endsWith('pg_database') && row.object_oid !== databaseOid) return [];
      const catalog = row.catalog_kind.includes('.')
        ? row.catalog_kind.slice(row.catalog_kind.lastIndexOf('.') + 1)
        : row.catalog_kind;
      const object =
        row.catalog_kind.endsWith('pg_class') && row.object_sub_id !== 0
          ? lookup.columns.get(columnKey(row.object_oid, row.object_sub_id))
          : lookup.byCatalogKey.get(objectKey(catalog, row.object_oid));
      return object === undefined ? [] : [{ object, text: row.description }];
    });
  }

  private mapAcls(
    rows: readonly AclCatalogRow[],
    lookup: ObjectLookup,
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresAccessControlEntry[] {
    return rows.flatMap((row) => {
      const object = lookup.byKey.get(objectKey(row.object_kind, row.object_oid));
      if (
        object === undefined ||
        row.grantor === null ||
        row.grantee === null ||
        row.privilege_type === null ||
        row.grantable === null ||
        row.raw_acl === null
      ) {
        if (object !== undefined) {
          diagnostics.add({
            code: 'malformed-acl',
            severity: 'warning',
            message: 'An ACL item could not be normalized.',
            objectOid: row.object_oid,
            objectIdentity: object.name,
          });
        }
        return [];
      }
      return [
        {
          object,
          grantor: row.grantor,
          grantee: row.grantee,
          privilege: row.privilege_type,
          grantOption: row.grantable,
          rawAcl: row.raw_acl,
        },
      ];
    });
  }

  private mapDefaultPrivileges(
    rows: readonly DefaultPrivilegeCatalogRow[],
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresDefaultPrivilege[] {
    return rows.flatMap((row) => {
      if (
        row.grantor === null ||
        row.grantee === null ||
        row.privilege_type === null ||
        row.grantable === null ||
        row.raw_acl === null
      ) {
        diagnostics.add({
          code: 'malformed-acl',
          severity: 'warning',
          message: 'An altered default privilege ACL item could not be normalized.',
          objectOid: row.oid,
          objectIdentity: row.owner,
        });
        return [];
      }
      return [
        {
          oid: row.oid,
          owner: row.owner,
          ownerOid: row.owner_oid,
          ...(row.schema_name === null ? {} : { schema: row.schema_name }),
          objectType: this.mapDefaultPrivilegeType(row.object_type),
          grantor: row.grantor,
          grantee: row.grantee,
          privilege: row.privilege_type,
          grantOption: row.grantable,
          rawAcl: row.raw_acl,
        },
      ];
    });
  }

  private createOwnerships(
    database: PostgresDatabase,
    lookup: ObjectLookup,
    roles: readonly RoleCatalogRow[],
    explicitOwners: readonly (readonly [number, string, number])[],
    diagnostics: IntrospectionDiagnostics,
  ): readonly PostgresOwnership[] {
    const roleNames = new Set(roles.map((role) => role.role_name));
    const ownerOids = new Map(explicitOwners.map(([oid, _owner, ownerOid]) => [oid, ownerOid]));
    const owners: Array<readonly [PostgresObjectReference, string, number | undefined]> = [
      [
        lookup.byKey.get(objectKey('database', database.oid))!,
        database.owner,
        ownerOids.get(database.oid),
      ],
    ];
    for (const schema of database.schemas) {
      owners.push([
        lookup.byKey.get(objectKey('schema', schema.oid))!,
        schema.owner,
        ownerOids.get(schema.oid),
      ]);
      for (const table of schema.tables) {
        owners.push([
          lookup.byKey.get(objectKey('table', table.oid))!,
          table.owner,
          ownerOids.get(table.oid),
        ]);
      }
      for (const sequence of schema.sequences) {
        owners.push([
          lookup.byKey.get(objectKey('sequence', sequence.oid))!,
          sequence.owner ?? '',
          ownerOids.get(sequence.oid),
        ]);
      }
      for (const type of [...schema.enumTypes, ...schema.domains]) {
        owners.push([
          lookup.byKey.get(objectKey('baseTypeOid' in type ? 'domain' : 'enum', type.oid))!,
          type.owner ?? '',
          ownerOids.get(type.oid),
        ]);
      }
    }
    for (const index of database.indexes) {
      owners.push([
        lookup.byKey.get(objectKey('index', index.oid))!,
        index.owner ?? '',
        ownerOids.get(index.oid),
      ]);
    }
    for (const [oid, owner, ownerOid] of explicitOwners) {
      const object = ['view', 'materialized-view', 'function', 'procedure', 'aggregate'].flatMap(
        (kind) => {
          const found = lookup.byKey.get(objectKey(kind, oid));
          return found === undefined ? [] : [found];
        },
      )[0];
      if (object !== undefined) owners.push([object, owner, ownerOid]);
    }

    const result: PostgresOwnership[] = [];
    for (const [object, owner, ownerOid] of owners) {
      if (owner === '') continue;
      if (!roleNames.has(owner)) {
        diagnostics.add({
          code: 'missing-owner-role',
          severity: 'warning',
          message: 'An object owner is missing or inaccessible in pg_roles.',
          objectOid: object.oid,
          objectIdentity: object.name,
        });
      }
      result.push({
        object,
        owner,
        ...(ownerOid === undefined ? {} : { ownerOid }),
      });
    }
    return result;
  }

  private mapPersistence(value: string): 'permanent' | 'unlogged' | 'temporary' {
    if (value === 'u') return 'unlogged';
    if (value === 't') return 'temporary';
    return 'permanent';
  }

  private mapViewCheckOption(options: ReadonlySet<string>): PostgresViewCheckOption {
    if (options.has('check_option=cascaded')) return 'cascaded';
    if (options.has('check_option=local')) return 'local';
    return 'none';
  }

  private mapVolatility(value: string): PostgresRoutineVolatility {
    if (value === 'i') return 'immutable';
    if (value === 's') return 'stable';
    return 'volatile';
  }

  private mapParallelSafety(value: string): PostgresParallelSafety {
    if (value === 's') return 'safe';
    if (value === 'r') return 'restricted';
    return 'unsafe';
  }

  private mapAggregateKind(value: string): PostgresAggregateKind {
    if (value === 'o') return 'ordered-set';
    if (value === 'h') return 'hypothetical-set';
    return 'normal';
  }

  private mapEnabled(value: string): PostgresTriggerEnabled {
    if (value === 'D') return 'disabled';
    if (value === 'R') return 'replica';
    if (value === 'A') return 'always';
    return 'origin';
  }

  private mapRuleEnabled(value: string): PostgresRuleEnabled {
    return this.mapEnabled(value);
  }

  private mapTriggerTiming(value: number): PostgresTriggerTiming {
    if ((value & 64) !== 0) return 'instead-of';
    if ((value & 2) !== 0) return 'before';
    return 'after';
  }

  private mapTriggerEvents(value: number): readonly PostgresTriggerEvent[] {
    const events: PostgresTriggerEvent[] = [];
    if ((value & 4) !== 0) events.push('insert');
    if ((value & 8) !== 0) events.push('delete');
    if ((value & 16) !== 0) events.push('update');
    if ((value & 32) !== 0) events.push('truncate');
    return events;
  }

  private extractTriggerWhen(definition: string): string | undefined {
    const match = /\sWHEN\s+\(([\s\S]+)\)\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s/i.exec(definition);
    return match?.[1]?.trim();
  }

  private mapRuleEvent(value: string): PostgresRuleEvent {
    if (value === '1') return 'select';
    if (value === '2') return 'update';
    if (value === '3') return 'insert';
    return 'delete';
  }

  private mapPolicyCommand(value: string): PostgresPolicyCommand {
    if (value === 'r') return 'select';
    if (value === 'a') return 'insert';
    if (value === 'w') return 'update';
    if (value === 'd') return 'delete';
    return 'all';
  }

  private mapDefaultPrivilegeType(value: string): PostgresDefaultPrivilegeObjectType {
    if (value === 'r') return 'table';
    if (value === 'S') return 'sequence';
    if (value === 'f') return 'function';
    if (value === 'T') return 'type';
    if (value === 'n') return 'schema';
    return 'unknown';
  }
}
