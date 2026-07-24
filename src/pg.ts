/**
 * Optional node-postgres adapter entry point.
 *
 * Import this subpath only when integrating with `pg`:
 * `import { fromPgPool } from 'dbgate-pg-dumper/pg'`.
 */
export {
  fromPgClient,
  fromPgPool,
  fromPgPoolClient,
  PgConnectionAdapter,
  PgPoolConnectionSource,
} from './connection/PgAdapter.js';
export type { PgConnectionAdapterOptions } from './connection/PgAdapter.js';
