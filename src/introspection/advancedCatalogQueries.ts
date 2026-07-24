/**
 * Version-aware catalog SQL for advanced PostgreSQL object families.
 *
 * Secret-bearing option arrays are redacted in SQL before crossing the driver
 * boundary. Explicit secure-value injection is handled separately at render
 * time and never relies on diagnostics retaining source credentials.
 */

import type { PostgresQuery } from '../connection/PostgresConnection.js';
import type { SourceCapabilities } from '../version/SourceCapabilities.js';

const REDACTED_OPTIONS = (expression: string): string => `
  ARRAY(
    SELECT CASE
      WHEN split_part(option, '=', 1) ~* '(password|passwd|pass|pwd|secret|token|credential|conninfo|sslkey|sslcert|key)'
        THEN split_part(option, '=', 1) || '=[REDACTED]'
      ELSE option
    END
    FROM pg_catalog.unnest(${expression}) AS option
    ORDER BY split_part(option, '=', 1)
  )
`;

export const EXTENSIONS_QUERY: PostgresQuery = {
  text: `
    SELECT e.oid::integer AS oid, e.extname AS extension_name,
      n.nspname AS schema_name, pg_catalog.pg_get_userbyid(e.extowner) AS owner,
      e.extversion AS version, e.extrelocatable AS relocatable,
      e.extconfig::oid[] AS configuration_table_oids,
      e.extcondition::text[] AS configuration_conditions,
      d.description AS comment
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    LEFT JOIN pg_catalog.pg_description d
      ON d.classoid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      AND d.objoid = e.oid AND d.objsubid = 0
    ORDER BY e.extname
  `,
};

export const EXTENSION_MEMBERS_QUERY: PostgresQuery = {
  text: `
    SELECT e.extname AS extension_name,
      d.classid::pg_catalog.regclass::text AS referenced_class,
      d.objid::integer AS object_oid, d.objsubid::integer AS object_sub_id,
      COALESCE(class_ns.nspname, proc_ns.nspname, type_ns.nspname) AS schema_name,
      COALESCE(c.relname, p.proname, t.typname, con.conname, n.nspname) AS object_name,
      CASE WHEN p.oid IS NULL THEN NULL::text
        ELSE pg_catalog.pg_get_function_identity_arguments(p.oid) END AS identity_arguments,
      c.relkind::text AS relation_kind
    FROM pg_catalog.pg_depend d
    JOIN pg_catalog.pg_extension e ON
      d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      AND d.refobjid = e.oid
    LEFT JOIN pg_catalog.pg_class c
      ON d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND c.oid = d.objid
    LEFT JOIN pg_catalog.pg_namespace class_ns ON class_ns.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_proc p
      ON d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND p.oid = d.objid
    LEFT JOIN pg_catalog.pg_namespace proc_ns ON proc_ns.oid = p.pronamespace
    LEFT JOIN pg_catalog.pg_type t
      ON d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND t.oid = d.objid
    LEFT JOIN pg_catalog.pg_namespace type_ns ON type_ns.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_constraint con
      ON d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND con.oid = d.objid
    LEFT JOIN pg_catalog.pg_namespace n
      ON d.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass AND n.oid = d.objid
    WHERE d.deptype = 'e'
    ORDER BY e.extname, referenced_class, d.objid, d.objsubid
  `,
};

export const FOREIGN_DATA_WRAPPERS_QUERY: PostgresQuery = {
  text: `
    SELECT f.oid::integer AS oid, f.fdwname AS wrapper_name,
      pg_catalog.pg_get_userbyid(f.fdwowner) AS owner,
      CASE WHEN f.fdwhandler = 0 THEN NULL::text ELSE f.fdwhandler::pg_catalog.regprocedure::text END AS handler,
      CASE WHEN f.fdwvalidator = 0 THEN NULL::text ELSE f.fdwvalidator::pg_catalog.regprocedure::text END AS validator,
      ${REDACTED_OPTIONS('f.fdwoptions')} AS options
    FROM pg_catalog.pg_foreign_data_wrapper f
    ORDER BY f.fdwname
  `,
};

export const FOREIGN_SERVERS_QUERY: PostgresQuery = {
  text: `
    SELECT s.oid::integer AS oid, s.srvname AS server_name,
      pg_catalog.pg_get_userbyid(s.srvowner) AS owner,
      s.srvfdw::integer AS wrapper_oid, f.fdwname AS wrapper_name,
      s.srvtype AS server_type, s.srvversion AS server_version,
      ${REDACTED_OPTIONS('s.srvoptions')} AS options
    FROM pg_catalog.pg_foreign_server s
    JOIN pg_catalog.pg_foreign_data_wrapper f ON f.oid = s.srvfdw
    ORDER BY s.srvname
  `,
};

export const USER_MAPPINGS_QUERY: PostgresQuery = {
  text: `
    SELECT m.oid::integer AS oid, m.umserver::integer AS server_oid,
      s.srvname AS server_name,
      CASE WHEN m.umuser = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(m.umuser) END AS user_name,
      ${REDACTED_OPTIONS('m.umoptions')} AS options
    FROM pg_catalog.pg_user_mapping m
    JOIN pg_catalog.pg_foreign_server s ON s.oid = m.umserver
    ORDER BY s.srvname, user_name
  `,
};

export const FOREIGN_TABLES_QUERY: PostgresQuery = {
  text: `
    SELECT f.ftrelid::integer AS table_oid, f.ftserver::integer AS server_oid,
      s.srvname AS server_name, ${REDACTED_OPTIONS('f.ftoptions')} AS options,
      a.attname AS column_name, ${REDACTED_OPTIONS('a.attfdwoptions')} AS column_options
    FROM pg_catalog.pg_foreign_table f
    JOIN pg_catalog.pg_foreign_server s ON s.oid = f.ftserver
    LEFT JOIN pg_catalog.pg_attribute a
      ON a.attrelid = f.ftrelid AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY f.ftrelid, a.attnum
  `,
};

export const EVENT_TRIGGERS_QUERY: PostgresQuery = {
  text: `
    SELECT e.oid::integer AS oid, e.evtname AS trigger_name,
      pg_catalog.pg_get_userbyid(e.evtowner) AS owner, e.evtevent AS event,
      e.evttags::text[] AS tags, e.evtfoid::integer AS function_oid,
      e.evtfoid::pg_catalog.regprocedure::text AS function_name,
      e.evtenabled::text AS enabled
    FROM pg_catalog.pg_event_trigger e
    ORDER BY e.evtname
  `,
};

export const LANGUAGES_QUERY: PostgresQuery = {
  text: `
    SELECT l.oid::integer AS oid, l.lanname AS language_name,
      pg_catalog.pg_get_userbyid(l.lanowner) AS owner, l.lanpltrusted AS trusted,
      CASE WHEN l.lanplcallfoid = 0 THEN NULL::text ELSE l.lanplcallfoid::pg_catalog.regprocedure::text END AS handler,
      CASE WHEN l.laninline = 0 THEN NULL::text ELSE l.laninline::pg_catalog.regprocedure::text END AS inline_handler,
      CASE WHEN l.lanvalidator = 0 THEN NULL::text ELSE l.lanvalidator::pg_catalog.regprocedure::text END AS validator,
      (l.oid < 16384 OR dep.objid IS NOT NULL) AS system_provided
    FROM pg_catalog.pg_language l
    LEFT JOIN pg_catalog.pg_depend dep
      ON dep.classid = 'pg_catalog.pg_language'::pg_catalog.regclass
      AND dep.objid = l.oid AND dep.deptype = 'e'
    WHERE l.lanispl
    ORDER BY l.lanname
  `,
};

export function createPublicationsQuery(
  capabilities: SourceCapabilities,
): PostgresQuery | undefined {
  if (!capabilities.publications) return undefined;
  return {
    text: `
      SELECT p.oid::integer AS oid, p.pubname AS publication_name,
        pg_catalog.pg_get_userbyid(p.pubowner) AS owner, p.puballtables AS all_tables,
        p.pubinsert AS publish_insert, p.pubupdate AS publish_update,
        p.pubdelete AS publish_delete,
        ${capabilities.publicationTruncate ? 'p.pubtruncate' : 'true'} AS publish_truncate,
        ${capabilities.publicationPartitionRoot ? 'p.pubviaroot' : 'false'} AS publish_via_partition_root
      FROM pg_catalog.pg_publication p ORDER BY p.pubname
    `,
  };
}

export function createPublicationTablesQuery(
  capabilities: SourceCapabilities,
): PostgresQuery | undefined {
  if (!capabilities.publications) return undefined;
  return {
    text: `
      SELECT r.prpubid::integer AS publication_oid, r.prrelid::integer AS table_oid,
        n.nspname AS table_schema, c.relname AS table_name,
        ${
          capabilities.publicationRowFilters
            ? `ARRAY(
                SELECT a.attname FROM pg_catalog.unnest(r.prattrs::smallint[]) WITH ORDINALITY item(attnum, position)
                JOIN pg_catalog.pg_attribute a ON a.attrelid = r.prrelid AND a.attnum = item.attnum
                ORDER BY item.position
              )`
            : 'NULL::text[]'
        } AS columns,
        ${
          capabilities.publicationRowFilters
            ? 'pg_catalog.pg_get_expr(r.prqual, r.prrelid, true)'
            : 'NULL::text'
        } AS row_filter
      FROM pg_catalog.pg_publication_rel r
      JOIN pg_catalog.pg_class c ON c.oid = r.prrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      ORDER BY r.prpubid, n.nspname, c.relname
    `,
  };
}

export function createPublicationSchemasQuery(
  capabilities: SourceCapabilities,
): PostgresQuery | undefined {
  if (!capabilities.publicationSchemas) return undefined;
  return {
    text: `
      SELECT p.pnpubid::integer AS publication_oid, n.nspname AS schema_name
      FROM pg_catalog.pg_publication_namespace p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pnnspid
      ORDER BY p.pnpubid, n.nspname
    `,
  };
}

export function createSubscriptionsQuery(
  capabilities: SourceCapabilities,
): PostgresQuery | undefined {
  if (!capabilities.publications) return undefined;
  return {
    text: `
      SELECT s.oid::integer AS oid, s.subname AS subscription_name,
        pg_catalog.pg_get_userbyid(s.subowner) AS owner, s.subenabled AS enabled,
        s.subpublications::text[] AS publications, s.subslotname AS slot_name,
        s.subsynccommit AS synchronous_commit,
        ${capabilities.subscriptionBinary ? 's.subbinary' : 'false'} AS binary_mode,
        ${
          capabilities.subscriptionStreaming ? 's.substream::text' : "'off'::text"
        } AS streaming_mode,
        ${capabilities.subscriptionTwoPhase ? 's.subtwophasestate::text' : "'d'::text"} AS two_phase_mode,
        ${capabilities.subscriptionFailover ? 's.subfailover' : 'false'} AS failover,
        (s.subconninfo IS NOT NULL AND s.subconninfo <> '') AS connection_info_present
      FROM pg_catalog.pg_subscription s
      WHERE s.subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
      ORDER BY s.subname
    `,
  };
}

export const TABLESPACES_QUERY: PostgresQuery = {
  text: `
    SELECT t.oid::integer AS oid, t.spcname AS tablespace_name,
      pg_catalog.pg_get_userbyid(t.spcowner) AS owner,
      pg_catalog.pg_tablespace_location(t.oid) AS location,
      t.spcoptions::text[] AS options
    FROM pg_catalog.pg_tablespace t
    WHERE t.spcname NOT IN ('pg_default', 'pg_global')
    ORDER BY t.spcname
  `,
};

export function createAdvancedRolesQuery(capabilities: SourceCapabilities): PostgresQuery {
  return {
    text: `
      SELECT r.oid::integer AS oid, r.rolname AS role_name,
        r.rolsuper AS superuser, r.rolinherit AS inherit,
        r.rolcreaterole AS create_role, r.rolcreatedb AS create_database,
        r.rolcanlogin AS can_login, r.rolreplication AS replication,
        ${capabilities.roleBypassRls ? 'r.rolbypassrls' : 'false'} AS bypass_rls,
        r.rolconnlimit AS connection_limit, r.rolvaliduntil::text AS valid_until,
        r.rolconfig::text[] AS configuration
      FROM pg_catalog.pg_roles r ORDER BY r.rolname
    `,
  };
}

export const ROLE_MEMBERSHIPS_QUERY: PostgresQuery = {
  text: `
    SELECT role.rolname AS role_name, member.rolname AS member_name,
      grantor.rolname AS grantor_name, m.admin_option
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles role ON role.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor
    ORDER BY role.rolname, member.rolname
  `,
};

export function createStatisticsQuery(capabilities: SourceCapabilities): PostgresQuery | undefined {
  if (!capabilities.extendedStatistics) return undefined;
  return {
    text: `
      SELECT s.oid::integer AS oid, n.nspname AS schema_name,
        s.stxname AS statistics_name, pg_catalog.pg_get_userbyid(s.stxowner) AS owner,
        s.stxrelid::integer AS table_oid, tn.nspname AS table_schema,
        c.relname AS table_name, pg_catalog.pg_get_statisticsobjdef(s.oid) AS definition,
        s.stxkind::text[] AS kinds,
        ${capabilities.statisticsTarget ? 's.stxstattarget' : 'NULL::integer'} AS target
      FROM pg_catalog.pg_statistic_ext s
      JOIN pg_catalog.pg_namespace n ON n.oid = s.stxnamespace
      JOIN pg_catalog.pg_class c ON c.oid = s.stxrelid
      JOIN pg_catalog.pg_namespace tn ON tn.oid = c.relnamespace
      ORDER BY n.nspname, s.stxname
    `,
  };
}

export const LARGE_OBJECTS_QUERY: PostgresQuery = {
  text: `
    SELECT m.oid::integer AS oid, pg_catalog.pg_get_userbyid(m.lomowner) AS owner,
      m.lomacl::text[] AS acl, d.description AS comment,
      COALESCE(size.pages, 0)::bigint * 2048 AS estimated_bytes
    FROM pg_catalog.pg_largeobject_metadata m
    LEFT JOIN (
      SELECT loid, count(*) AS pages FROM pg_catalog.pg_largeobject GROUP BY loid
    ) size ON size.loid = m.oid
    LEFT JOIN pg_catalog.pg_description d
      ON d.classoid = 'pg_catalog.pg_largeobject'::pg_catalog.regclass
      AND d.objoid = m.oid AND d.objsubid = 0
    ORDER BY m.oid
  `,
};

export const REPLICATION_ORIGINS_QUERY: PostgresQuery = {
  text: `SELECT count(*)::integer AS count FROM pg_catalog.pg_replication_origin`,
};
