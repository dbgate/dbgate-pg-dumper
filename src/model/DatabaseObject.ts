/**
 * Canonical database-object model shared by planning and rendering layers.
 *
 * PostgreSQL catalog rows must be normalized into this representation instead
 * of being passed around directly. The discriminated union can grow as support
 * is added for functions, types, extensions, policies, publications, and every
 * other PostgreSQL object category.
 */

/** Initially recognized object categories; future releases will extend this. */
export type DatabaseObjectKind = 'schema' | 'table' | 'sequence' | 'view' | 'unknown';

/** Stable identity used for ordering, filtering, warnings, and progress events. */
export interface DatabaseObjectIdentity {
  readonly kind: DatabaseObjectKind;
  readonly schema?: string;
  readonly name: string;
  readonly oid?: number;
}

/** Base metadata common to every introspected PostgreSQL object. */
export interface DatabaseObject {
  readonly identity: DatabaseObjectIdentity;
  readonly owner?: string;
  readonly dependencies: readonly DatabaseObjectIdentity[];
}
