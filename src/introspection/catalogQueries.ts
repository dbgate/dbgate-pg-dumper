/**
 * Version-aware `pg_catalog` queries for the initial model.
 *
 * Optional catalog columns are selected only when source capabilities confirm
 * they exist. All user-provided selection values are supplied separately as
 * query parameters by the orchestration layer.
 */

import type { PostgresQuery } from '../connection/PostgresConnection.js';
import type { SourceCapabilities } from '../version/SourceCapabilities.js';

export const DATABASE_QUERY: PostgresQuery = {
  text: `
    SELECT
      d.oid::integer AS oid,
      d.datname AS name,
      pg_catalog.pg_get_userbyid(d.datdba) AS owner,
      pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
      d.datcollate AS collation,
      d.datctype AS character_type,
      ts.spcname AS tablespace,
      d.datconnlimit AS connection_limit,
      d.datallowconn AS allow_connections,
      d.datistemplate AS is_template,
      ARRAY(
        SELECT pg_catalog.unnest(setting.setconfig)
        FROM pg_catalog.pg_db_role_setting setting
        WHERE setting.setdatabase = d.oid AND setting.setrole = 0
      )::text[] AS configuration
    FROM pg_catalog.pg_database d
    JOIN pg_catalog.pg_tablespace ts ON ts.oid = d.dattablespace
    WHERE d.datname = pg_catalog.current_database()
  `,
};

export const SCHEMAS_QUERY: PostgresQuery = {
  text: `
    SELECT
      n.oid::integer AS oid,
      n.nspname AS name,
      pg_catalog.pg_get_userbyid(n.nspowner) AS owner
    FROM pg_catalog.pg_namespace n
    ORDER BY n.nspname
  `,
};

export function createTablesQuery(capabilities: SourceCapabilities): PostgresQuery {
  const accessMethod = capabilities.tableAccessMethods ? 'am.amname' : 'NULL::text';
  const accessMethodIsDefault = capabilities.tableAccessMethods
    ? `am.amname = pg_catalog.current_setting('default_table_access_method')`
    : 'false';
  const accessMethodJoin = capabilities.tableAccessMethods
    ? 'LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam'
    : '';
  const isPartition = capabilities.declarativePartitioning ? 'c.relispartition' : 'false';
  const partitionBound = capabilities.declarativePartitioning
    ? 'CASE WHEN c.relispartition THEN pg_catalog.pg_get_expr(c.relpartbound, c.oid, true) ELSE NULL::text END'
    : 'NULL::text';
  const relKinds = capabilities.declarativePartitioning ? ['r', 'p', 'f'] : ['r', 'f'];

  return {
    text: `
      SELECT
        c.oid::integer AS oid,
        n.nspname AS schema_name,
        c.relname AS table_name,
        c.relkind::text AS relkind,
        c.relpersistence::text AS relpersistence,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner,
        ts.spcname AS tablespace,
        ${accessMethod} AS access_method,
        ${accessMethodIsDefault} AS access_method_is_default,
        c.relrowsecurity AS row_security,
        c.relforcerowsecurity AS force_row_security,
        GREATEST(c.reltuples, 0)::double precision AS estimated_row_count,
        c.relreplident::text AS replica_identity,
        ${isPartition} AS is_partition,
        ${partitionBound} AS partition_bound,
        parent.oid::integer AS parent_oid,
        parent_ns.nspname AS parent_schema,
        parent.relname AS parent_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = c.reltablespace
      ${accessMethodJoin}
      LEFT JOIN pg_catalog.pg_inherits inh ON inh.inhrelid = c.oid
      LEFT JOIN pg_catalog.pg_class parent ON parent.oid = inh.inhparent
      LEFT JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      WHERE c.relkind = ANY($1::char[])
      ORDER BY n.nspname, c.relname, inh.inhseqno
    `,
    values: [relKinds],
  };
}

export function createColumnsQuery(
  capabilities: SourceCapabilities,
  tableOids: readonly number[],
): PostgresQuery {
  const identity = capabilities.identityColumns ? 'a.attidentity::text' : "''::text";
  const generated = capabilities.generatedColumns ? 'a.attgenerated::text' : "''::text";
  const compression = capabilities.columnCompression ? 'a.attcompression::text' : 'NULL::text';

  return {
    text: `
      SELECT
        a.attrelid::integer AS table_oid,
        a.attnum::integer AS attribute_number,
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
        a.atttypid::integer AS type_oid,
        a.atttypmod::integer AS type_modifier,
        column_type.typtype::text AS type_kind,
        a.attnotnull AS not_null,
        pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true) AS default_expression,
        ${identity} AS identity_mode,
        ${generated} AS generated_mode,
        coll_ns.nspname AS collation_schema,
        coll.collname AS collation_name,
        a.attcollation = column_type.typcollation AS collation_is_default,
        ${compression} AS compression,
        a.attstorage::text AS storage_mode,
        column_type.typstorage::text AS default_storage_mode,
        a.attisdropped AS is_dropped
      FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef ad
        ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      JOIN pg_catalog.pg_type column_type ON column_type.oid = a.atttypid
      LEFT JOIN pg_catalog.pg_collation coll
        ON coll.oid = a.attcollation AND a.attcollation <> 0
      LEFT JOIN pg_catalog.pg_namespace coll_ns ON coll_ns.oid = coll.collnamespace
      WHERE a.attrelid = ANY($1::oid[])
        AND a.attnum > 0
      ORDER BY a.attrelid, a.attnum
    `,
    values: [tableOids],
  };
}
