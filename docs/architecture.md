# Architecture

## Connection lifecycle

The core package depends on `PostgresConnection`, not on a particular Node.js
driver. A connection represents exactly one physical PostgreSQL backend session
and supports parameterized queries, typed rows, optional streaming,
`AbortSignal`, and transaction-state reporting.

`PostgresConnectionSource` represents resources that must be acquired, notably a
connection pool. Its result contains one connection and an idempotent release
callback. Direct connections are borrowed and never closed by the library.
Pool-backed adapters acquire one client and release it after the operation.

The optional `dbgate-pg-dumper/pg` entry point adapts:

- a connected `pg.Client`;
- an already acquired `pg.PoolClient`;
- a `pg.Pool`, from which one client is retained for the full operation.

No DbGate model or connection type is imported anywhere in the package.

## Why one physical session is required

PostgreSQL transaction snapshots, temporary objects, settings, and catalog
visibility belong to a backend session. Sending introspection queries through a
pool's generic `query()` method could route each query to a different backend
and make the resulting model internally inconsistent. Acquisition therefore
happens before version detection and the same connection is used until commit
or rollback.

## Source version and capabilities

The source detector reads both `server_version` and `server_version_num`.
`PostgresVersionService` handles PostgreSQL's numbering change:

- before 10, `90624` means 9.6.24 and the normalized major is `9.6`;
- from 10 onward, `180004` means 18.4 and the normalized major is `18`.

PostgreSQL 9.6 is currently the minimum supported source.

Source capability flags are derived once from the numeric version. Initial flags
cover identity columns, declarative partitioning, procedures, INCLUDE indexes,
generated columns, column compression, `NULLS NOT DISTINCT`, multiranges, and
table access methods. Introspection also distinguishes partition constraint
parents, default partitions, partitioned indexes, routine-kind catalogs,
support functions, SQL routine bodies, trigger transition tables and parents,
restrictive policies, security-invoker views, and materialized-view access
methods. These describe source catalog shape only. Target compatibility remains
a separate renderer layer.

## Transaction modes

`DumpSessionManager` supports:

- `managed` (default): requires a known-idle connection, starts
  `REPEATABLE READ READ ONLY`, commits on success, and rolls back on failure or
  cancellation;
- `existing`: requires an active transaction and leaves commit/rollback to the
  caller;
- `none`: performs no transaction work and provides no cross-query snapshot
  guarantee.

Managed mode refuses `in-transaction`, `failed`, and `unknown` states rather
than silently issuing a nested `BEGIN`.

The `pg` package has no supported public transaction-status API. Its adapter
therefore tracks transaction commands sent through itself and accepts an
`initialTransactionStatus` option. A client whose transaction was started
before wrapping must be created with
`{ initialTransactionStatus: 'in-transaction' }` and used with
`transactionMode: 'existing'`.

The session metadata reserves a synchronized snapshot identifier for future
parallel dumping. Supplying one currently fails explicitly because coordinated
snapshot export/import is not implemented.

## Schema filtering

Selection values are exact PostgreSQL identifier names. They are not lowercased
and are not treated as SQL patterns, preserving mixed-case and Unicode
identifiers. The normalized selection supports schema and table include/exclude
lists plus explicit system-schema and temporary-schema switches.

By default the following are excluded:

- `pg_catalog`;
- `information_schema`;
- `pg_toast` and toast schemas;
- `pg_temp_*` and `pg_toast_temp_*`.

Catalog SQL never interpolates selection names. Current introspection reads
catalog candidates and applies exact normalized filtering in memory; table OIDs
are passed to the column query as a bound array parameter.

## Current introspection scope

`introspectPostgres()` performs:

1. physical connection acquisition;
2. source version detection;
3. source capability derivation;
4. consistent session setup;
5. database metadata loading;
6. schema loading and filtering;
7. enum and domain type loading;
8. ordinary, partitioned, partition, and foreign table loading;
9. column loading;
10. sequence loading;
11. primary, unique, check, foreign-key, and domain constraint loading;
12. independent index loading;
13. partition definition loading and structural dependency assembly;
14. role, view, and materialized-view loading;
15. function, procedure, and aggregate loading;
16. trigger, rewrite-rule, and row-policy loading;
17. comment, ACL, altered-default-privilege, and higher dependency loading;
18. normalized metadata assembly and diagnostics;
19. commit/rollback and resource release.

The independent model contains database, schema, table, column, sequence, enum,
domain, constraint, index, and partition types. Tables include ownership,
persistence, tablespace, access method where available, row-level security
flags, formatted partition keys and bounds, default partitions, and
parent/child relationships. Columns include formatted type, type OID/modifier,
nullability, default or generated expression, identity, collation, compression,
storage, physical attribute number, and enum/domain dependency references.

Sequences preserve type and numeric options, cycle state, current value when the
source exposes it in a batch-safe catalog view, ownership, and serial-versus-
identity dependency type. Standalone sequences remain valid model objects.

Constraints preserve ordered attribute arrays, deferrability, validation,
partition-parent OIDs where available, backing indexes, foreign-key actions and
match modes, and PostgreSQL-formatted check expressions. Domain check
constraints remain attached to their domain and also appear in the database
constraint collection.

Indexes are loaded independently even when they back constraints. The model
preserves access method, uniqueness, primary/exclusion state, expressions,
partial predicates, INCLUDE elements, operator classes, collations, ordering,
null placement, tablespace, storage parameters, readiness/validity, clustering,
replica identity, and partitioned-index parent relationships. Invalid or
unfinished indexes remain detectable but have `exportable: false`.

Dropped attributes are retained in the internal catalog mapping until assembly
so later phases can reason about physical attribute numbering. They are omitted
from the returned table column list.

## Higher-level objects

Views preserve canonical `pg_get_viewdef` text, output columns, persistence,
check option, security barrier, and security-invoker state where supported.
Materialized views additionally retain tablespace, access method, storage
parameters, population state, and canonical attached-index definitions. Their
rows are not exported yet.

Functions and procedures preserve PostgreSQL identity arguments, full argument
definitions, return/result metadata, language, source text, and canonical
`pg_get_functiondef` output. Function metadata includes kind, volatility,
strictness, security-definer and leakproof states, parallel safety, planner
estimates, per-function settings, transform types, and support functions where
available. Identity arguments are part of references so overloads remain
unambiguous.

Aggregates retain transition/state/final/combine/serialization and moving-
aggregate metadata, initial conditions, sort operator, direct-argument count,
aggregate kind, and parallel safety. PostgreSQL has no general canonical
aggregate-definition helper, so later rendering will be model-driven.

Non-internal triggers preserve `pg_get_triggerdef`, enabled state,
timing/event/level metadata, trigger function, WHEN expression, constraint
properties, transition-table names, and parent trigger OID where supported.
WHEN expressions are recovered from the canonical definition because
`pg_get_expr(tgqual, ...)` cannot safely deparse trigger OLD/NEW variables.

User rewrite rules preserve `pg_get_ruledef`, enabled/event state, and INSTEAD
behavior. View-generated `_RETURN` rules and internal triggers are intentionally
excluded and reported through diagnostics.

## Comments, ownership, and privileges

Comments are separate metadata entries keyed by normalized object references.
This keeps missing comments distinct from present values and supports database,
schema, relation, column, type, constraint, routine, trigger, rule, and policy
catalog classes.

Ownership is separate from future `ALTER ... OWNER` rendering. Entries retain
the object, source owner, and owner OID where available. Owners are checked
against `pg_roles`; inaccessible roles produce diagnostics. Future `--no-owner`
and owner remapping belong to planning and compatibility policy.

Object ACLs are expanded with `aclexplode`, which correctly handles quoted and
escaped role identifiers. Each entry contains the object, grantee, grantor,
privilege, grant-option state, and raw ACL array. PUBLIC is represented by the
literal `PUBLIC`. Database, schema, relation, sequence, routine, enum, and
domain ACLs are covered.

Altered default privileges are normalized by owner, optional schema, object
category, grantee, privilege, and grant option. Row-level security policies
retain command, permissive/restrictive mode, roles, USING, and WITH CHECK
expressions. The plain renderer emits this metadata unless its corresponding
`no-*` option is selected.

## Structural catalog sources

| Object                | Primary catalog sources                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Enum and domain types | `pg_type`, `pg_enum`, `pg_collation`, `pg_constraint`                                     |
| Sequences             | `pg_class`, `pg_sequence` from PostgreSQL 10, `pg_sequences`, `pg_depend`, `pg_attribute` |
| Keys and foreign keys | `pg_constraint`, `pg_index`, `pg_attribute`                                               |
| Check constraints     | `pg_constraint`, `pg_get_expr`, `pg_get_constraintdef`                                    |
| Indexes               | `pg_index`, `pg_class`, `pg_am`, `pg_opclass`, `pg_collation`, `pg_inherits`              |
| Partitions            | `pg_partitioned_table`, `pg_inherits`, `pg_get_partkeydef`, `pg_get_expr`                 |
| Views                 | `pg_class`, `pg_attribute`, `pg_rewrite`, `pg_get_viewdef`                                |
| Functions/procedures  | `pg_proc`, `pg_language`, `pg_get_functiondef`, routine helper functions                  |
| Aggregates            | `pg_aggregate`, `pg_proc`, `pg_type`                                                      |
| Triggers              | `pg_trigger`, `pg_proc`, `pg_get_triggerdef`                                              |
| Rules                 | `pg_rewrite`, `pg_get_ruledef`                                                            |
| Policies              | `pg_policy`, `pg_get_expr`                                                                |
| Comments/security     | `pg_description`, `pg_shdescription`, ACL catalogs, `pg_default_acl`                      |
| Dependencies          | `pg_depend` plus direct catalog relationships                                             |

Each object category is loaded in a bounded number of batch queries. OID and
attribute-number relationships are resolved in memory; no per-table or
per-object catalog query loop is used.

## Version-specific handling

- PostgreSQL 9.6 has no `pg_sequence`; sequence definition values are obtained
  through the catalog-backed `information_schema.sequences` view. Cache size,
  current value, and `is_called` are unavailable through a safe batch catalog
  API and produce an `unsupported-catalog-metadata` diagnostic.
- Identity dependencies and declarative partition catalogs are enabled from
  PostgreSQL 10.
- Partition constraint parents, default partitions, partitioned indexes, and
  INCLUDE index metadata are enabled from PostgreSQL 11.
- Table access methods are selected from PostgreSQL 12.
- Column compression and multiranges are recognized from PostgreSQL 14.
- `NULLS NOT DISTINCT` is read from constraints and indexes from PostgreSQL 15.
- Procedures, routine `prokind`, parent triggers, and partitioned-index details
  are read only where the source exposes them.
- Trigger transition tables and restrictive policies are enabled from
  PostgreSQL 10.
- Function support functions and materialized-view access methods are enabled
  from PostgreSQL 12.
- Security-invoker view state is represented from PostgreSQL 15. Older sources
  omit the field and report unavailable metadata when views exist.

## Dependencies and diagnostics

Objects contain preliminary `PostgresObjectReference` edges. Current links
cover structural dependencies plus view/materialized-view references found
through rewrite dependencies, routine argument/return types, trigger tables and
functions, rule owners and referenced objects, policy tables and resolvable
expression dependencies, comment/ACL targets, and aggregate support functions
and state types.

These references are intentionally not topologically sorted. The dump archive
builder converts them into a complete planning graph.

`introspectPostgres()` returns structured diagnostics for missing references,
malformed constraint arrays or ACLs, unavailable old-version metadata, invalid
indexes or materialized views, unvalidated constraints, orphaned sequence
ownership, unresolved dependencies and trigger functions, deliberately
excluded internal objects, unsupported object kinds, and missing owner roles.
Inconsistent metadata is not silently discarded.

## Dump archive

`inspectDumpArchive()` converts a normalized `PostgresDatabase` into immutable
archive entries. The archive is independent of SQL text, output streams, and
archive-file formats. Entries separately represent definitions, table and
materialized-view data descriptors, sequence state, constraints, indexes,
routines, triggers, rules, policies, comments, ownership, ACLs, and altered
default privileges.

Every entry has a canonical identity built from length-prefixed object type,
schema, name, parent identity, and object-specific identity. Routine identity
arguments, column ordinal positions, parent relations, metadata targets, and
privilege identities disambiguate otherwise overloaded names. A truncated
SHA-256 digest of that canonical identity forms the stable dump ID. Duplicate
canonical identities and digest collisions are separate structured errors.

The archive defines three sections:

- `pre-data`: database, extensions, schemas, enum/domain types, sequences,
  routines, tables/columns, views, and materialized-view definitions;
- `data`: table data descriptors, materialized-view data descriptors, and
  sequence state;
- `post-data`: sequence ownership, constraints, indexes, foreign keys, triggers,
  rules, policies, ownership, comments, ACLs, and default privileges.

Section and object-priority rules are centralized in `SectionRules`. The current
priority is designed for safe deterministic planning and future PostgreSQL
restore alignment; it does not claim byte-for-byte `pg_dump` ordering.

## Archive dependencies and ordering

Archive edges have two strengths:

- hard dependencies are required for a valid restore and are never removed;
- ordering preferences express restore-safety preferences, such as creating
  indexes, foreign keys, and triggers after table data.

Catalog references are supplemented with schema membership, type references,
sequence ownership, partition parents, table-object relationships, routine
references, metadata targets, data owners, and extension membership. Duplicate
edges are consolidated deterministically, with hard edges taking precedence.

Cross-section validation rejects any earlier section that depends on a later
section. Tarjan's strongly connected component algorithm identifies cycles.
Preference edges inside a cycle may be removed with diagnostics. If a hard
cycle remains, the archive is invalid and exposes every cycle member and edge,
including dump IDs, object identities, object types, edge strengths, and edge
sources. No executable order is returned for an invalid archive.

Sequence definition and `OWNED BY` are separate entries. Serial and identity
columns depend on the pre-data sequence definition; the post-data ownership
entry then depends on both the sequence and owning column. This models both
ordering directions without creating an artificial hard cycle.

Valid graphs use Kahn's topological algorithm. Simultaneously available entries
are ordered by section, centralized object-type priority, schema, object name,
object-specific identity, and stable dump ID. Input array and JavaScript object
iteration order therefore do not affect output.

Mutually referencing and self-referential foreign keys are naturally safe
because foreign-key entries live in post-data and depend on table definitions,
not on each other. View-generated `_RETURN` rules are already removed by
introspection. Metadata dependencies target their base objects, while ownership
and ACL-only preferences remain breakable. More advanced default-expression
and table-row-type cycle transformations remain future work.

## Archive selection and extensions

Archive selection supports full, schema-only, and data-only modes; explicit
section selection; exact schema and table include/exclude filters; recursive
table-child inclusion/exclusion; dependency inclusion; and strict selection.
Hard dependencies excluded only by schema/table filters are included by default
and marked with `reason: "dependency"` plus the requesting dump IDs. Strict
selection reports an error instead.

Mode and explicit section boundaries are hard. Data-only entries therefore do
not silently select schema definitions; diagnostics identify selected table
data, materialized-view data, or sequence state whose definitions are outside
the requested archive.

Extension entries and membership can be supplied to archive inspection while
extension catalog introspection is developed. When an extension is selected,
member objects marked as non-independent are excluded and dependent entries
are redirected to the extension entry, preventing duplicate emission.

## Plain SQL rendering

`dumpPostgres()` now coordinates introspection, archive planning, and streaming
plain-SQL schema rendering. Object renderers receive immutable source/target
capabilities and never access the database. Clean drops use reverse archive
order; creation follows pre-data and post-data order, while selected data
entries are diagnosed and skipped. See [Plain SQL rendering](plain-sql.md).

## Planned phases

The following are intentionally outside the current implementation:

- composite/range types, extensions, event triggers, operators, casts, and
  additional PostgreSQL object families;
- exclusion constraints and advanced PostgreSQL 18 temporal constraint fields;
- publications, subscriptions, and other replication/security object types;
- `COPY` and `INSERT` table and materialized-view data streaming;
- synchronized snapshots and parallel dumping;
- broader psql-driven cross-major restore tests.

Archive limitations currently include:

- extension membership must be supplied by the caller because extension
  introspection is not implemented yet;
- defaults are not separate archive entries, so function/table-row-type default
  cycles are diagnosed only when represented by model dependencies;
- custom archive files, parallel dumping, and data streaming are not performed
  by the archive layer.
