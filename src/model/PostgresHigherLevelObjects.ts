/**
 * Normalized higher-level PostgreSQL objects and security metadata.
 *
 * These contracts preserve PostgreSQL-generated definitions and catalog
 * identity without exposing raw catalog row shapes. They intentionally contain
 * enough source metadata for a later renderer, but perform no SQL generation
 * or dependency ordering.
 */

import type { PostgresPersistence } from './PostgresDatabase.js';
import type {
  PostgresObjectReference,
  PostgresStructuralObject,
} from './PostgresStructuralObjects.js';

export interface PostgresRelationColumn {
  readonly attributeNumber: number;
  readonly name: string;
  readonly formattedType: string;
  readonly typeOid: number;
}

export type PostgresViewCheckOption = 'none' | 'local' | 'cascaded';

export interface PostgresView extends PostgresStructuralObject {
  readonly definition: string;
  readonly columns: readonly PostgresRelationColumn[];
  readonly persistence: PostgresPersistence;
  readonly securityBarrier: boolean;
  readonly securityInvoker?: boolean;
  readonly checkOption: PostgresViewCheckOption;
}

export interface PostgresMaterializedView extends PostgresStructuralObject {
  readonly definition: string;
  readonly columns: readonly PostgresRelationColumn[];
  readonly persistence: PostgresPersistence;
  readonly tablespace?: string;
  readonly accessMethod?: string;
  readonly storageParameters: readonly string[];
  readonly populated: boolean;
  readonly indexes: readonly PostgresMaterializedViewIndex[];
}

/**
 * Canonical index metadata for materialized views.
 *
 * Materialized views are discovered after ordinary table indexes, so this
 * compact model retains the server-generated definition needed by the same
 * post-data index renderer without coupling the two catalog query phases.
 */
export interface PostgresMaterializedViewIndex extends PostgresObjectReference {
  readonly kind: 'index';
  readonly definition: string;
  readonly valid: boolean;
  readonly ready: boolean;
}

export type PostgresRoutineKind = 'function' | 'window';
export type PostgresRoutineVolatility = 'immutable' | 'stable' | 'volatile';
export type PostgresParallelSafety = 'safe' | 'restricted' | 'unsafe';

export interface PostgresRoutineBase extends PostgresStructuralObject {
  readonly identityArguments: string;
  readonly arguments: string;
  readonly language: string;
  readonly source: string;
  readonly definition: string;
  readonly securityDefiner: boolean;
  readonly configuration: readonly string[];
  readonly argumentTypeOids: readonly number[];
  readonly resultTypeOid: number;
}

export interface PostgresFunction extends PostgresRoutineBase {
  readonly routineKind: PostgresRoutineKind;
  readonly resultType: string;
  readonly volatility: PostgresRoutineVolatility;
  readonly strict: boolean;
  readonly leakproof: boolean;
  readonly parallelSafety: PostgresParallelSafety;
  readonly estimatedCost: number;
  readonly estimatedRows: number;
  readonly supportFunction?: PostgresObjectReference;
  readonly transformTypeOids: readonly number[];
}

export interface PostgresProcedure extends PostgresRoutineBase {
  readonly result: string;
}

export type PostgresAggregateKind = 'normal' | 'ordered-set' | 'hypothetical-set';

export interface PostgresAggregate extends PostgresStructuralObject {
  readonly identityArguments: string;
  readonly arguments: string;
  readonly aggregateKind: PostgresAggregateKind;
  readonly parallelSafety: PostgresParallelSafety;
  readonly transitionFunction?: PostgresObjectReference;
  readonly stateType?: PostgresObjectReference;
  readonly stateTypeName: string;
  readonly finalFunction?: PostgresObjectReference;
  readonly combineFunction?: PostgresObjectReference;
  readonly serializationFunction?: PostgresObjectReference;
  readonly deserializationFunction?: PostgresObjectReference;
  readonly movingTransitionFunction?: PostgresObjectReference;
  readonly movingInverseFunction?: PostgresObjectReference;
  readonly movingFinalFunction?: PostgresObjectReference;
  readonly movingStateType?: PostgresObjectReference;
  readonly initialCondition?: string;
  readonly movingInitialCondition?: string;
  readonly sortOperator?: string;
  readonly transitionSpace: number;
  readonly movingTransitionSpace: number;
  readonly directArgumentCount: number;
  /** PostgreSQL has no general pg_get_aggregatedef helper; reserved when available. */
  readonly definition?: string;
}

export type PostgresTriggerEnabled = 'origin' | 'disabled' | 'replica' | 'always';
export type PostgresTriggerTiming = 'before' | 'after' | 'instead-of';
export type PostgresTriggerEvent = 'insert' | 'delete' | 'update' | 'truncate';

export interface PostgresTrigger extends PostgresStructuralObject {
  readonly table: PostgresObjectReference;
  readonly definition: string;
  readonly enabled: PostgresTriggerEnabled;
  readonly timing: PostgresTriggerTiming;
  readonly events: readonly PostgresTriggerEvent[];
  readonly level: 'row' | 'statement';
  readonly function: PostgresObjectReference;
  readonly when?: string;
  readonly constraint: boolean;
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
  readonly referencedRelation?: PostgresObjectReference;
  readonly oldTransitionTable?: string;
  readonly newTransitionTable?: string;
  readonly parentTriggerOid?: number;
}

export type PostgresRuleEnabled = 'origin' | 'disabled' | 'replica' | 'always';
export type PostgresRuleEvent = 'select' | 'update' | 'insert' | 'delete';

export interface PostgresRule extends PostgresStructuralObject {
  readonly relation: PostgresObjectReference;
  readonly definition: string;
  readonly enabled: PostgresRuleEnabled;
  readonly event: PostgresRuleEvent;
  readonly instead: boolean;
}

export interface PostgresComment {
  readonly object: PostgresObjectReference;
  /** Empty strings are meaningful and remain distinct from an absent entry. */
  readonly text: string;
}

export interface PostgresOwnership {
  readonly object: PostgresObjectReference;
  readonly owner: string;
  readonly ownerOid?: number;
}

export interface PostgresAccessControlEntry {
  readonly object: PostgresObjectReference;
  readonly grantor: string;
  readonly grantee: string;
  readonly privilege: string;
  readonly grantOption: boolean;
  readonly rawAcl: readonly string[];
}

export type PostgresDefaultPrivilegeObjectType =
  'table' | 'sequence' | 'function' | 'type' | 'schema' | 'unknown';

export interface PostgresDefaultPrivilege {
  readonly oid: number;
  readonly owner: string;
  readonly ownerOid: number;
  readonly schema?: string;
  readonly objectType: PostgresDefaultPrivilegeObjectType;
  readonly grantor: string;
  readonly grantee: string;
  readonly privilege: string;
  readonly grantOption: boolean;
  readonly rawAcl: readonly string[];
}

export type PostgresPolicyCommand = 'all' | 'select' | 'insert' | 'update' | 'delete';

export interface PostgresPolicy extends PostgresStructuralObject {
  readonly table: PostgresObjectReference;
  readonly command: PostgresPolicyCommand;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly usingExpression?: string;
  readonly checkExpression?: string;
}
