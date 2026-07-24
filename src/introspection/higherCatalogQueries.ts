/**
 * Batched and source-version-aware SQL for higher-level objects.
 *
 * Catalog differences are isolated here. Unsupported columns are replaced with
 * typed constants, so mapping code has one stable input shape on PostgreSQL
 * 9.6 through current releases.
 */

import type { PostgresQuery } from '../connection/PostgresConnection.js';
import type { SourceCapabilities } from '../version/SourceCapabilities.js';

export const ROLES_QUERY: PostgresQuery = {
  text: `
    SELECT r.oid::integer AS oid, r.rolname AS role_name
    FROM pg_catalog.pg_roles r
    ORDER BY r.rolname
  `,
};

export function createViewsQuery(capabilities: SourceCapabilities): PostgresQuery {
  const accessMethod = capabilities.materializedViewAccessMethods ? 'am.amname' : 'NULL::text';
  const accessMethodJoin = capabilities.materializedViewAccessMethods
    ? 'LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam'
    : '';
  return {
    text: `
      SELECT
        c.oid::integer AS oid,
        n.nspname AS schema_name,
        c.relname AS view_name,
        c.relkind::text AS relation_kind,
        c.relowner::integer AS owner_oid,
        pg_catalog.pg_get_userbyid(c.relowner) AS owner,
        pg_catalog.pg_get_viewdef(c.oid, true) AS definition,
        c.relpersistence::text AS persistence,
        ts.spcname AS tablespace,
        ${accessMethod} AS access_method,
        c.reloptions AS storage_parameters,
        CASE WHEN c.relkind = 'm' THEN c.relispopulated ELSE true END AS populated
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = c.reltablespace
      ${accessMethodJoin}
      WHERE c.relkind IN ('v', 'm')
      ORDER BY n.nspname, c.relname
    `,
  };
}

export function createViewColumnsQuery(relationOids: readonly number[]): PostgresQuery {
  return {
    text: `
      SELECT
        a.attrelid::integer AS relation_oid,
        a.attnum::integer AS attribute_number,
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
        a.atttypid::integer AS type_oid
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = ANY($1::oid[])
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum
    `,
    values: [relationOids],
  };
}

export function createMaterializedViewIndexesQuery(viewOids: readonly number[]): PostgresQuery {
  return {
    text: `
      SELECT
        i.indrelid::integer AS view_oid,
        index_class.oid::integer AS index_oid,
        index_ns.nspname AS schema_name,
        index_class.relname AS index_name,
        pg_catalog.pg_get_indexdef(index_class.oid) AS definition,
        i.indisvalid AS valid,
        i.indisready AS ready
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class index_class ON index_class.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace index_ns ON index_ns.oid = index_class.relnamespace
      WHERE i.indrelid = ANY($1::oid[])
      ORDER BY i.indrelid, index_class.relname
    `,
    values: [viewOids],
  };
}

export function createRoutinesQuery(capabilities: SourceCapabilities): PostgresQuery {
  const routineKind = capabilities.routineKinds
    ? 'p.prokind::text'
    : "CASE WHEN p.proisagg THEN 'a' WHEN p.proiswindow THEN 'w' ELSE 'f' END";
  const selectedKinds = capabilities.procedures ? "('f', 'p', 'w')" : "('f', 'w')";
  const kindFilter = capabilities.routineKinds ? `p.prokind IN ${selectedKinds}` : 'NOT p.proisagg';
  const supportOid = capabilities.supportFunctions ? 'p.prosupport::integer' : '0::integer';
  const supportJoins = capabilities.supportFunctions
    ? `
      LEFT JOIN pg_catalog.pg_proc support_proc ON support_proc.oid = p.prosupport
      LEFT JOIN pg_catalog.pg_namespace support_ns ON support_ns.oid = support_proc.pronamespace
    `
    : '';
  const supportSchema = capabilities.supportFunctions ? 'support_ns.nspname' : 'NULL::text';
  const supportName = capabilities.supportFunctions ? 'support_proc.proname' : 'NULL::text';
  const supportArguments = capabilities.supportFunctions
    ? 'pg_catalog.pg_get_function_identity_arguments(support_proc.oid)'
    : 'NULL::text';

  return {
    text: `
      SELECT
        p.oid::integer AS oid,
        n.nspname AS schema_name,
        p.proname AS routine_name,
        p.proowner::integer AS owner_oid,
        pg_catalog.pg_get_userbyid(p.proowner) AS owner,
        ${routineKind} AS routine_kind,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
        pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
        pg_catalog.pg_get_function_result(p.oid) AS result,
        language.lanname AS language,
        p.prosrc AS source,
        pg_catalog.pg_get_functiondef(p.oid) AS definition,
        p.provolatile::text AS volatility,
        p.proisstrict AS strict,
        p.prosecdef AS security_definer,
        p.proleakproof AS leakproof,
        p.proparallel::text AS parallel_safety,
        p.procost::double precision AS estimated_cost,
        p.prorows::double precision AS estimated_rows,
        p.proconfig AS configuration,
        p.proargtypes::oid[] AS argument_type_oids,
        p.prorettype::integer AS result_type_oid,
        ${supportOid} AS support_function_oid,
        ${supportSchema} AS support_function_schema,
        ${supportName} AS support_function_name,
        ${supportArguments} AS support_function_identity_arguments,
        p.protrftypes::oid[] AS transform_type_oids
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language language ON language.oid = p.prolang
      ${supportJoins}
      WHERE ${kindFilter}
      ORDER BY n.nspname, p.proname, p.oid
    `,
  };
}

export function createAggregatesQuery(capabilities: SourceCapabilities): PostgresQuery {
  const aggregateFilter = capabilities.routineKinds ? "p.prokind = 'a'" : 'p.proisagg';
  return {
    text: `
      SELECT
        p.oid::integer AS oid,
        n.nspname AS schema_name,
        p.proname AS aggregate_name,
        p.proowner::integer AS owner_oid,
        pg_catalog.pg_get_userbyid(p.proowner) AS owner,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
        pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
        a.aggkind::text AS aggregate_kind,
        p.proparallel::text AS parallel_safety,
        a.aggtransfn::integer AS transition_function_oid,
        CASE WHEN a.aggtransfn = 0 THEN NULL::text ELSE a.aggtransfn::pg_catalog.regprocedure::text END AS transition_function_name,
        a.aggtranstype::integer AS state_type_oid,
        pg_catalog.format_type(a.aggtranstype, NULL) AS state_type_name,
        a.aggfinalfn::integer AS final_function_oid,
        CASE WHEN a.aggfinalfn = 0 THEN NULL::text ELSE a.aggfinalfn::pg_catalog.regprocedure::text END AS final_function_name,
        a.aggcombinefn::integer AS combine_function_oid,
        CASE WHEN a.aggcombinefn = 0 THEN NULL::text ELSE a.aggcombinefn::pg_catalog.regprocedure::text END AS combine_function_name,
        a.aggserialfn::integer AS serialization_function_oid,
        CASE WHEN a.aggserialfn = 0 THEN NULL::text ELSE a.aggserialfn::pg_catalog.regprocedure::text END AS serialization_function_name,
        a.aggdeserialfn::integer AS deserialization_function_oid,
        CASE WHEN a.aggdeserialfn = 0 THEN NULL::text ELSE a.aggdeserialfn::pg_catalog.regprocedure::text END AS deserialization_function_name,
        a.aggmtransfn::integer AS moving_transition_function_oid,
        CASE WHEN a.aggmtransfn = 0 THEN NULL::text ELSE a.aggmtransfn::pg_catalog.regprocedure::text END AS moving_transition_function_name,
        a.aggminvtransfn::integer AS moving_inverse_function_oid,
        CASE WHEN a.aggminvtransfn = 0 THEN NULL::text ELSE a.aggminvtransfn::pg_catalog.regprocedure::text END AS moving_inverse_function_name,
        a.aggmfinalfn::integer AS moving_final_function_oid,
        CASE WHEN a.aggmfinalfn = 0 THEN NULL::text ELSE a.aggmfinalfn::pg_catalog.regprocedure::text END AS moving_final_function_name,
        a.aggmtranstype::integer AS moving_state_type_oid,
        CASE WHEN a.aggmtranstype = 0 THEN NULL::text ELSE pg_catalog.format_type(a.aggmtranstype, NULL) END AS moving_state_type_name,
        a.agginitval AS initial_condition,
        a.aggminitval AS moving_initial_condition,
        CASE WHEN a.aggsortop = 0 THEN NULL::text ELSE a.aggsortop::pg_catalog.regoperator::text END AS sort_operator,
        a.aggtransspace::integer AS transition_space,
        a.aggmtransspace::integer AS moving_transition_space,
        a.aggnumdirectargs::integer AS direct_argument_count
      FROM pg_catalog.pg_aggregate a
      JOIN pg_catalog.pg_proc p ON p.oid = a.aggfnoid
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE ${aggregateFilter}
      ORDER BY n.nspname, p.proname, p.oid
    `,
  };
}

export function createTriggersQuery(
  capabilities: SourceCapabilities,
  relationOids: readonly number[],
): PostgresQuery {
  const transitions = capabilities.transitionTables ? 't.tgoldtable' : 'NULL::pg_catalog.name';
  const newTransition = capabilities.transitionTables ? 't.tgnewtable' : 'NULL::pg_catalog.name';
  const parent = capabilities.parentTriggers ? 't.tgparentid::integer' : '0::integer';
  return {
    text: `
      SELECT
        t.oid::integer AS oid,
        t.tgname AS trigger_name,
        t.tgrelid::integer AS table_oid,
        table_ns.nspname AS table_schema,
        table_class.relname AS table_name,
        t.tgfoid::integer AS function_oid,
        function_ns.nspname AS function_schema,
        function_proc.proname AS function_name,
        pg_catalog.pg_get_function_identity_arguments(function_proc.oid) AS function_identity_arguments,
        pg_catalog.pg_get_triggerdef(t.oid, true) AS definition,
        t.tgenabled::text AS enabled,
        t.tgtype::integer AS trigger_type,
        NULL::text AS when_expression,
        t.tgconstraint::integer AS constraint_oid,
        t.tgdeferrable AS deferrable,
        t.tginitdeferred AS initially_deferred,
        t.tgconstrrelid::integer AS referenced_relation_oid,
        referenced_ns.nspname AS referenced_relation_schema,
        referenced_class.relname AS referenced_relation_name,
        ${transitions}::text AS old_transition_table,
        ${newTransition}::text AS new_transition_table,
        ${parent} AS parent_trigger_oid,
        t.tgisinternal AS internal
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class table_class ON table_class.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace table_ns ON table_ns.oid = table_class.relnamespace
      LEFT JOIN pg_catalog.pg_proc function_proc ON function_proc.oid = t.tgfoid
      LEFT JOIN pg_catalog.pg_namespace function_ns ON function_ns.oid = function_proc.pronamespace
      LEFT JOIN pg_catalog.pg_class referenced_class ON referenced_class.oid = t.tgconstrrelid
      LEFT JOIN pg_catalog.pg_namespace referenced_ns ON referenced_ns.oid = referenced_class.relnamespace
      WHERE t.tgrelid = ANY($1::oid[])
      ORDER BY table_ns.nspname, table_class.relname, t.tgname
    `,
    values: [relationOids],
  };
}

export function createRulesQuery(relationOids: readonly number[]): PostgresQuery {
  return {
    text: `
      SELECT
        r.oid::integer AS oid,
        r.rulename AS rule_name,
        r.ev_class::integer AS relation_oid,
        n.nspname AS relation_schema,
        c.relname AS relation_name,
        pg_catalog.pg_get_ruledef(r.oid, true) AS definition,
        r.ev_enabled::text AS enabled,
        r.ev_type::text AS event_type,
        r.is_instead AS instead
      FROM pg_catalog.pg_rewrite r
      JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE r.ev_class = ANY($1::oid[])
      ORDER BY n.nspname, c.relname, r.rulename
    `,
    values: [relationOids],
  };
}

export function createPoliciesQuery(
  capabilities: SourceCapabilities,
  tableOids: readonly number[],
): PostgresQuery {
  const permissive = capabilities.restrictivePolicies ? 'p.polpermissive' : 'true';
  return {
    text: `
      SELECT
        p.oid::integer AS oid,
        p.polname AS policy_name,
        p.polrelid::integer AS table_oid,
        n.nspname AS table_schema,
        c.relname AS table_name,
        p.polcmd::text AS command,
        ${permissive} AS permissive,
        ARRAY(
          SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END
          FROM pg_catalog.unnest(p.polroles) AS role_oid
        )::text[] AS roles,
        pg_catalog.pg_get_expr(p.polqual, p.polrelid, true) AS using_expression,
        pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, true) AS check_expression
      FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE p.polrelid = ANY($1::oid[])
      ORDER BY n.nspname, c.relname, p.polname
    `,
    values: [tableOids],
  };
}

export const COMMENTS_QUERY: PostgresQuery = {
  text: `
    SELECT d.classoid::pg_catalog.regclass::text AS catalog_kind,
      d.objoid::integer AS object_oid,
      d.objsubid::integer AS object_sub_id,
      d.description
    FROM pg_catalog.pg_description d
    WHERE d.classoid IN (
      'pg_catalog.pg_namespace'::pg_catalog.regclass,
      'pg_catalog.pg_class'::pg_catalog.regclass,
      'pg_catalog.pg_type'::pg_catalog.regclass,
      'pg_catalog.pg_constraint'::pg_catalog.regclass,
      'pg_catalog.pg_proc'::pg_catalog.regclass,
      'pg_catalog.pg_trigger'::pg_catalog.regclass,
      'pg_catalog.pg_rewrite'::pg_catalog.regclass,
      'pg_catalog.pg_policy'::pg_catalog.regclass
    )
    UNION ALL
    SELECT 'pg_database', s.objoid::integer, 0, s.description
    FROM pg_catalog.pg_shdescription s
    WHERE s.classoid = 'pg_catalog.pg_database'::pg_catalog.regclass
    ORDER BY catalog_kind, object_oid, object_sub_id
  `,
};

export const ACL_QUERY: PostgresQuery = {
  text: `
    SELECT secured.object_kind, secured.object_oid,
      CASE WHEN acl.grantor = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantor) END AS grantor,
      CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
      acl.privilege_type, acl.is_grantable AS grantable, secured.raw_acl
    FROM (
      SELECT 'database'::text AS object_kind, d.oid::integer AS object_oid,
        d.datacl AS acl, d.datacl::text[] AS raw_acl
      FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()
      UNION ALL
      SELECT 'schema', n.oid::integer, n.nspacl, n.nspacl::text[] FROM pg_catalog.pg_namespace n
      UNION ALL
      SELECT CASE WHEN c.relkind = 'S' THEN 'sequence'
                  WHEN c.relkind = 'v' THEN 'view'
                  WHEN c.relkind = 'm' THEN 'materialized-view'
                  ELSE 'table' END,
        c.oid::integer, c.relacl, c.relacl::text[]
      FROM pg_catalog.pg_class c WHERE c.relkind IN ('r', 'p', 'f', 'S', 'v', 'm')
      UNION ALL
      SELECT CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END,
        p.oid::integer, p.proacl, p.proacl::text[] FROM pg_catalog.pg_proc p
      UNION ALL
      SELECT 'type', t.oid::integer, t.typacl, t.typacl::text[]
      FROM pg_catalog.pg_type t WHERE t.typtype IN ('e', 'd')
    ) secured
    CROSS JOIN LATERAL pg_catalog.aclexplode(secured.acl) acl
    ORDER BY secured.object_kind, secured.object_oid, grantee, acl.privilege_type
  `,
};

export function createAclQuery(capabilities: SourceCapabilities): PostgresQuery {
  if (capabilities.routineKinds) return ACL_QUERY;
  return {
    text: ACL_QUERY.text.replace(
      "CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END",
      "'function'",
    ),
  };
}

export const DEFAULT_PRIVILEGES_QUERY: PostgresQuery = {
  text: `
    SELECT
      d.oid::integer AS oid,
      d.defaclrole::integer AS owner_oid,
      pg_catalog.pg_get_userbyid(d.defaclrole) AS owner,
      n.nspname AS schema_name,
      d.defaclobjtype::text AS object_type,
      CASE WHEN acl.grantor = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantor) END AS grantor,
      CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
      acl.privilege_type,
      acl.is_grantable AS grantable,
      d.defaclacl::text[] AS raw_acl
    FROM pg_catalog.pg_default_acl d
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) acl
    ORDER BY owner, n.nspname, d.defaclobjtype, grantee, acl.privilege_type
  `,
};

export function createDependenciesQuery(
  relationOids: readonly number[],
  routineOids: readonly number[],
  triggerOids: readonly number[],
  policyOids: readonly number[],
): PostgresQuery {
  return {
    text: `
      WITH sources AS (
        SELECT CASE WHEN rw.rulename = '_RETURN' THEN 'view' ELSE 'rule' END::text AS source_kind,
          CASE WHEN rw.rulename = '_RETURN' THEN rw.ev_class ELSE rw.oid END::oid AS source_oid,
          d.refclassid, d.refobjid, d.refobjsubid, d.deptype
        FROM pg_catalog.pg_rewrite rw
        JOIN pg_catalog.pg_depend d
          ON d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass AND d.objid = rw.oid
        WHERE rw.ev_class = ANY($1::oid[])
        UNION ALL
        SELECT 'function', d.objid, d.refclassid, d.refobjid, d.refobjsubid, d.deptype
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND d.objid = ANY($2::oid[])
        UNION ALL
        SELECT 'trigger', d.objid, d.refclassid, d.refobjid, d.refobjsubid, d.deptype
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_trigger'::pg_catalog.regclass
          AND d.objid = ANY($3::oid[])
        UNION ALL
        SELECT 'policy', d.objid, d.refclassid, d.refobjid, d.refobjsubid, d.deptype
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass
          AND d.objid = ANY($4::oid[])
      )
      SELECT
        s.source_kind,
        s.source_oid::integer,
        s.refclassid::pg_catalog.regclass::text AS referenced_class,
        s.refobjid::integer AS referenced_oid,
        s.refobjsubid::integer AS referenced_sub_id,
        COALESCE(class_ns.nspname, proc_ns.nspname, type_ns.nspname) AS referenced_schema,
        COALESCE(ref_class.relname, ref_proc.proname, ref_type.typname) AS referenced_name,
        CASE WHEN ref_proc.oid IS NULL THEN NULL::text
          ELSE pg_catalog.pg_get_function_identity_arguments(ref_proc.oid)
        END AS referenced_identity_arguments,
        ref_class.relkind::text AS referenced_relation_kind,
        s.deptype::text AS dependency_type
      FROM sources s
      LEFT JOIN pg_catalog.pg_class ref_class
        ON s.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND ref_class.oid = s.refobjid
      LEFT JOIN pg_catalog.pg_namespace class_ns ON class_ns.oid = ref_class.relnamespace
      LEFT JOIN pg_catalog.pg_proc ref_proc
        ON s.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND ref_proc.oid = s.refobjid
      LEFT JOIN pg_catalog.pg_namespace proc_ns ON proc_ns.oid = ref_proc.pronamespace
      LEFT JOIN pg_catalog.pg_type ref_type
        ON s.refclassid = 'pg_catalog.pg_type'::pg_catalog.regclass AND ref_type.oid = s.refobjid
      LEFT JOIN pg_catalog.pg_namespace type_ns ON type_ns.oid = ref_type.typnamespace
      WHERE s.deptype <> 'i'
      ORDER BY s.source_kind, s.source_oid, referenced_class, s.refobjid, s.refobjsubid
    `,
    values: [relationOids, routineOids, triggerOids, policyOids],
  };
}
