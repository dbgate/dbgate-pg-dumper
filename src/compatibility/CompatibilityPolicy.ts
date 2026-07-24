/**
 * Target-version compatibility boundary.
 *
 * Rules in this layer will decide whether a source feature can be emitted
 * directly, requires a safe rewrite, or must produce a warning. Renderers should
 * consume these decisions instead of scattering version checks across SQL code.
 */

import type { DumpWarning } from '../api/types.js';
import type { DatabaseObject } from '../model/DatabaseObject.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';

/** Result of evaluating one database object for a target PostgreSQL version. */
export interface CompatibilityDecision {
  readonly supported: boolean;
  readonly object: DatabaseObject;
  readonly warnings: readonly DumpWarning[];
}

/** Evaluates normalized objects without querying the source database. */
export interface CompatibilityPolicy {
  evaluate(
    object: DatabaseObject,
    sourceVersion: PostgresVersion,
    targetVersion: PostgresVersion,
  ): CompatibilityDecision;
}

/** Default compatibility policy placeholder. */
export class DefaultCompatibilityPolicy implements CompatibilityPolicy {
  /** TODO: Apply explicit, testable rules for each supported object feature. */
  evaluate(
    _object: DatabaseObject,
    _sourceVersion: PostgresVersion,
    _targetVersion: PostgresVersion,
  ): CompatibilityDecision {
    throw new Error('TODO: implement target-version compatibility rules');
  }
}
