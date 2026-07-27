/**
 * Batched, version-aware catalog queries for structural schema objects.
 *
 * Every query is parameterized by selected OID arrays where applicable.
 * Conditional fragments are selected solely from trusted source capabilities;
 * user names are never interpolated.
 */

import type { PostgresQuery } from '../connection/PostgresConnection.js';
import type { SourceCapabilities } from '../version/SourceCapabilities.js';

export const TYPES_QUERY: PostgresQuery = {
  text: `
    SELECT
      t.oid::integer AS oid,
      n.nspname AS schema_name,
      t.typname AS type_name,
      t.typtype::text AS type_kind,
      pg_catalog.pg_get_userbyid(t.typowner) AS owner,
      t.typbasetype::integer AS base_type_oid,
      CASE WHEN t.typtype = 'd'
        THEN pg_catalog.format_type(t.typbasetype, t.typtypmod)
        ELSE NULL::text
      END AS formatted_base_type,
      t.typnotnull AS not_null,
      t.typdefault AS default_expression,
      coll_ns.nspname AS collation_schema,
      coll.collname AS collation_name
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_collation coll
      ON coll.oid = t.typcollation AND t.typcollation <> 0
    LEFT JOIN pg_catalog.pg_namespace coll_ns ON coll_ns.oid = coll.collnamespace
    WHERE t.typtype IN ('e', 'd')
    ORDER BY n.nspname, t.typname
  `,
};

export function createEnumLabelsQuery(typeOids: readonly number[]): PostgresQuery {
  return {
    text: `
      SELECT
        e.enumtypid::integer AS type_oid,
        e.oid::integer AS label_oid,
        e.enumlabel AS label,
        e.enumsortorder::real AS sort_order
      FROM pg_catalog.pg_enum e
      WHERE e.enumtypid = ANY($1::oid[])
      ORDER BY e.enumtypid, e.enumsortorder
    `,
    values: [typeOids],
  };
}

export function createSequencesQuery(capabilities: SourceCapabilities): PostgresQuery {
  const dependencyTypes = capabilities.identityColumns ? "('a', 'i')" : "('a')";

  if (capabilities.identityColumns) {
    return {
      text: `
        SELECT
          c.oid::integer AS oid,
          n.nspname AS schema_name,
          c.relname AS sequence_name,
          pg_catalog.pg_get_userbyid(c.relowner) AS owner,
          pg_catalog.format_type(s.seqtypid, NULL) AS data_type,
          s.seqstart::text AS start_value,
          s.seqincrement::text AS increment,
          s.seqmin::text AS minimum_value,
          s.seqmax::text AS maximum_value,
          s.seqcache::text AS cache_size,
          s.seqcycle AS cycle,
          seq_view.last_value::text AS current_value,
          NULL::boolean AS is_called,
          dep.deptype::text AS dependency_type,
          owner_table.oid::integer AS owned_table_oid,
          owner_ns.nspname AS owned_table_schema,
          owner_table.relname AS owned_table_name,
          dep.refobjsubid::integer AS owned_attribute_number,
          owner_column.attname AS owned_column_name
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid
        LEFT JOIN pg_catalog.pg_sequences seq_view
          ON seq_view.schemaname = n.nspname AND seq_view.sequencename = c.relname
        LEFT JOIN pg_catalog.pg_depend dep
          ON dep.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND dep.objid = c.oid
          AND dep.objsubid = 0
          AND dep.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND dep.deptype IN ${dependencyTypes}
        LEFT JOIN pg_catalog.pg_class owner_table ON owner_table.oid = dep.refobjid
        LEFT JOIN pg_catalog.pg_namespace owner_ns ON owner_ns.oid = owner_table.relnamespace
        LEFT JOIN pg_catalog.pg_attribute owner_column
          ON owner_column.attrelid = dep.refobjid
          AND owner_column.attnum = dep.refobjsubid
        WHERE c.relkind = 'S'
        ORDER BY n.nspname, c.relname
      `,
    };
  }

  return {
    text: `
      SELECT
        c.oid::integer AS oid,
        n.nspname AS schema_name,
        c.relname AS sequence_name,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner,
        'bigint'::text AS data_type,
        seq_view.start_value::text AS start_value,
        seq_view.increment::text AS increment,
        seq_view.minimum_value::text AS minimum_value,
        seq_view.maximum_value::text AS maximum_value,
        '1'::text AS cache_size,
        (seq_view.cycle_option = 'YES') AS cycle,
        NULL::text AS current_value,
        NULL::boolean AS is_called,
        dep.deptype::text AS dependency_type,
        owner_table.oid::integer AS owned_table_oid,
        owner_ns.nspname AS owned_table_schema,
        owner_table.relname AS owned_table_name,
        dep.refobjsubid::integer AS owned_attribute_number,
        owner_column.attname AS owned_column_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.sequences seq_view
        ON seq_view.sequence_schema = n.nspname
        AND seq_view.sequence_name = c.relname
      LEFT JOIN pg_catalog.pg_depend dep
        ON dep.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND dep.objid = c.oid
        AND dep.objsubid = 0
        AND dep.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND dep.deptype IN ${dependencyTypes}
      LEFT JOIN pg_catalog.pg_class owner_table ON owner_table.oid = dep.refobjid
      LEFT JOIN pg_catalog.pg_namespace owner_ns ON owner_ns.oid = owner_table.relnamespace
      LEFT JOIN pg_catalog.pg_attribute owner_column
        ON owner_column.attrelid = dep.refobjid
        AND owner_column.attnum = dep.refobjsubid
      WHERE c.relkind = 'S'
      ORDER BY n.nspname, c.relname
    `,
  };
}

export function createConstraintsQuery(
  capabilities: SourceCapabilities,
  tableOids: readonly number[],
  domainOids: readonly number[],
): PostgresQuery {
  const parentConstraint = capabilities.partitionConstraintParents
    ? 'con.conparentid::integer'
    : '0::integer';
  const nullsNotDistinct = capabilities.nullsNotDistinct
    ? 'COALESCE(index_meta.indnullsnotdistinct, false)'
    : 'false';

  return {
    text: `
      SELECT
        con.oid::integer AS oid,
        con.conname AS constraint_name,
        con_ns.nspname AS schema_name,
        con.contype::text AS constraint_type,
        con.conrelid::integer AS table_oid,
        con.contypid::integer AS domain_oid,
        con.confrelid::integer AS referenced_table_oid,
        con.conkey::smallint[] AS column_numbers,
        con.confkey::smallint[] AS referenced_column_numbers,
        con.condeferrable AS deferrable,
        con.condeferred AS initially_deferred,
        con.convalidated AS validated,
        con.conindid::integer AS backing_index_oid,
        ${parentConstraint} AS parent_constraint_oid,
        con.confmatchtype::text AS match_type,
        con.confupdtype::text AS update_action,
        con.confdeltype::text AS delete_action,
        con.conislocal AS locally_defined,
        con.coninhcount::integer AS inheritance_count,
        con.connoinherit AS no_inherit,
        CASE WHEN con.contype = 'c'
          THEN pg_catalog.pg_get_expr(con.conbin, con.conrelid, true)
          ELSE NULL::text
        END AS expression,
        pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
        ${nullsNotDistinct} AS nulls_not_distinct
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_namespace con_ns ON con_ns.oid = con.connamespace
      LEFT JOIN pg_catalog.pg_index index_meta ON index_meta.indexrelid = con.conindid
      WHERE con.contype IN ('p', 'u', 'c', 'f')
        AND (
          con.conrelid = ANY($1::oid[])
          OR con.contypid = ANY($2::oid[])
        )
      ORDER BY con_ns.nspname, con.conname, con.oid
    `,
    values: [tableOids, domainOids],
  };
}

export function createIndexesQuery(
  capabilities: SourceCapabilities,
  tableOids: readonly number[],
): PostgresQuery {
  const keyAttributes = capabilities.includeIndexes ? 'i.indnkeyatts' : 'i.indnatts';
  const nullsNotDistinct = capabilities.nullsNotDistinct ? 'i.indnullsnotdistinct' : 'false';
  const parentIndex = capabilities.partitionedIndexes
    ? 'COALESCE(parent_link.inhparent, 0)::integer'
    : '0::integer';
  const parentJoin = capabilities.partitionedIndexes
    ? 'LEFT JOIN pg_catalog.pg_inherits parent_link ON parent_link.inhrelid = index_class.oid'
    : '';

  return {
    text: `
      SELECT
        index_class.oid::integer AS oid,
        index_ns.nspname AS schema_name,
        index_class.relname AS index_name,
        pg_catalog.pg_get_userbyid(index_class.relowner) AS owner,
        i.indrelid::integer AS table_oid,
        am.amname AS access_method,
        i.indisunique AS unique_index,
        i.indisprimary AS primary_index,
        i.indisexclusion AS exclusion_index,
        i.indimmediate AS immediate,
        ${nullsNotDistinct} AS nulls_not_distinct,
        i.indisvalid AS valid,
        i.indisready AS ready,
        i.indislive AS live,
        i.indisclustered AS clustered,
        i.indisreplident AS replica_identity,
        tablespace.spcname AS tablespace,
        index_class.reloptions AS storage_parameters,
        pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
        pg_catalog.pg_get_expr(i.indexprs, i.indrelid, true) AS expressions,
        pg_catalog.pg_get_indexdef(i.indexrelid, 0, true) AS definition,
        i.indnatts::integer AS total_attributes,
        ${keyAttributes}::integer AS key_attributes,
        i.indkey::smallint[] AS attribute_numbers,
        ARRAY(
          SELECT pg_catalog.pg_get_indexdef(i.indexrelid, position, true)
          FROM pg_catalog.generate_series(1, i.indnatts) AS position
          ORDER BY position
        ) AS element_definitions,
        ARRAY(
          SELECT CASE WHEN class_oid = 0 THEN NULL::text
            ELSE pg_catalog.quote_ident(op_ns.nspname) || '.' || pg_catalog.quote_ident(op.opcname)
          END
          FROM pg_catalog.unnest(i.indclass::oid[]) WITH ORDINALITY AS item(class_oid, position)
          LEFT JOIN pg_catalog.pg_opclass op ON op.oid = item.class_oid
          LEFT JOIN pg_catalog.pg_namespace op_ns ON op_ns.oid = op.opcnamespace
          ORDER BY position
        ) AS operator_classes,
        ARRAY(
          SELECT CASE WHEN class_oid = 0 THEN false
            ELSE COALESCE(op.opcdefault, false)
          END
          FROM pg_catalog.unnest(i.indclass::oid[]) WITH ORDINALITY AS item(class_oid, position)
          LEFT JOIN pg_catalog.pg_opclass op ON op.oid = item.class_oid
          ORDER BY position
        ) AS operator_class_is_default,
        ARRAY(
          SELECT CASE WHEN collation_oid = 0 THEN NULL::text
            ELSE pg_catalog.quote_ident(coll_ns.nspname) || '.' || pg_catalog.quote_ident(coll.collname)
          END
          FROM pg_catalog.unnest(i.indcollation::oid[]) WITH ORDINALITY AS item(collation_oid, position)
          LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = item.collation_oid
          LEFT JOIN pg_catalog.pg_namespace coll_ns ON coll_ns.oid = coll.collnamespace
          ORDER BY position
        ) AS collations,
        i.indoption::smallint[] AS options,
        ${parentIndex} AS parent_index_oid
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class index_class ON index_class.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace index_ns ON index_ns.oid = index_class.relnamespace
      JOIN pg_catalog.pg_am am ON am.oid = index_class.relam
      LEFT JOIN pg_catalog.pg_tablespace tablespace ON tablespace.oid = index_class.reltablespace
      ${parentJoin}
      WHERE i.indrelid = ANY($1::oid[])
      ORDER BY index_ns.nspname, index_class.relname
    `,
    values: [tableOids],
  };
}

export function createPartitionsQuery(
  capabilities: SourceCapabilities,
  tableOids: readonly number[],
): PostgresQuery | undefined {
  if (!capabilities.declarativePartitioning) return undefined;
  const defaultPartition = capabilities.defaultPartitions
    ? 'partitioned.partdefid::integer'
    : '0::integer';

  return {
    text: `
      SELECT
        partitioned.partrelid::integer AS table_oid,
        partitioned.partstrat::text AS strategy,
        pg_catalog.pg_get_partkeydef(partitioned.partrelid) AS key_definition,
        partitioned.partattrs::smallint[] AS key_attribute_numbers,
        ${defaultPartition} AS default_partition_oid
      FROM pg_catalog.pg_partitioned_table partitioned
      WHERE partitioned.partrelid = ANY($1::oid[])
      ORDER BY partitioned.partrelid
    `,
    values: [tableOids],
  };
}
