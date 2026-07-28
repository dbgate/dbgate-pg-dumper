# Advanced PostgreSQL objects

This document describes the current production-safety boundary. The dumper
prefers an explicit diagnostic or error to emitting plausible but incomplete
SQL.

## Large objects

Large objects are included by default and can be disabled with
`includeLargeObjects: false`. Metadata is read from
`pg_largeobject_metadata`; contents are streamed from `pg_largeobject` in
2 KiB pages. A complete large object is never retained in memory.

Plain SQL creates each original OID with `lo_create`, writes pages with
`lo_put`, and applies owner/comment metadata after data. Large-object data sorts
before table data so OID references in rows remain valid. Sparse page offsets
are retained. Cancellation, malformed page metadata, permission failures,
connection loss, and writer failures abort the dump.

Large-object ACL discovery is retained in the normalized model. Object-specific
ACL rendering is not yet complete and is reported as a remaining limitation.

## Extensions

Extensions include name, schema, source version, relocatability, configuration
tables, comments, dependencies, and resolved members. Extension members are not
emitted independently by default; ordinary user objects merely located in an
extension schema are unaffected. `expandExtensionMembers: true` opts into
individual member emission and reduces portability.

`extensionIfNotExists`, `extensionVersion`, and `extensionUpdate` control SQL.
`extensionIfNotExists` defaults to `true`, so standard extensions such as
`plpgsql` can already exist in the restore target. Updates are emitted only for
names explicitly present in `extensionUpdate`.
Unresolved membership produces a diagnostic. Configuration-table data entries
remain separate from member-owned table definitions.

## Foreign data and secrets

Foreign-data wrappers, servers, user mappings, and foreign tables are ordered
wrapper → server → mapping/table. User mappings are disabled by default.
Foreign-table row export is separately disabled by default.

Potentially sensitive option values are redacted in the catalog query before
they cross the connection interface. The central `sensitiveValuePolicy`
supports:

- `omit` (default): leave sensitive options out;
- `redact`: emit a caller-selected placeholder;
- `provide`: reserve values for a caller-supplied secure callback;
- `fail`: reject selected sensitive objects.

The synchronous object renderer never receives source passwords, subscription
connection strings, or role password hashes. It therefore cannot accidentally
place those values in errors, progress events, diagnostics, or snapshots.
Secure callback substitution is modeled but not yet wired into asynchronous
archive rendering; selecting `provide` currently fails safely.

## Replication objects

Publications include publish actions, tables, schemas, column lists, row
filters, and partition-root behavior when supported by the source version.
They are restored after referenced tables.

Subscriptions are omitted by default. Catalog introspection records only
connection-info presence, never the connection string. Explicitly selected
subscriptions restore disabled with `connect = false` and
`create_slot = false`, using a placeholder connection value. No replication
slot is created or reused automatically.

Replication origins are detected but not exported. They are runtime replication
state rather than portable schema.

## Database, tablespaces, and roles

Database creation is opt-in with `includeCreateDatabase`. It emits
`CREATE DATABASE`, a `psql` `\connect`, owner, encoding, libc locale fields,
tablespace, connection limit, allow-connections/template flags, and database
configuration. Database creation cannot run inside a transaction.

User tablespaces and cluster roles are opt-in. Tablespace policies are
`preserve`, `omit`, `remap`, and `fail-unmapped`. Source paths are
environment-specific and are never claimed to be portable. Role passwords and
hashes are never queried. Role remapping applies to ownership and grants.

Tablespace, subscription, and database-creation statements are rejected before
output when a restore transaction wrapper is requested.

## Other advanced definitions

The normalized architecture and archive identities cover text-search objects,
composite/range/base types, casts, transforms, operators, operator
families/classes, conversions, collations, event triggers, procedural
languages, security labels, and extended statistics.

Currently rendered and catalog-backed:

- event triggers, late in post-data;
- user-created procedural languages;
- extended statistics definitions;
- publications and explicitly selected subscriptions;
- extension, foreign-data, tablespace, role, and large-object objects.

The remaining advanced type, text-search, operator, conversion, collation,
transform, and security-label families have typed models and archive slots but
do not yet have complete catalog assembly and exact SQL rendering. In
particular, incomplete base types must never be guessed. Future detection must
create an unsupported-object diagnostic and obey `error`, `warn`, or `skip`.

## Preflight and dry run

Preflight runs after introspection/archive selection and before construction of
the output writer. It reports selected/skipped/unsupported objects, required
extensions, roles and privileges, tablespace mappings, transaction conflicts,
portability issues, and estimated rows. `dryRun: true` returns the report and
writes zero bytes.

Potential elevated-privilege requirements are reported for event triggers,
untrusted languages, FDWs, subscriptions, tablespaces, roles, and large
objects. Unlogged and explicitly selected temporary tables receive portability
warnings.

## Intentionally excluded runtime state

Logical dumps do not include planner-statistics contents, autovacuum state,
visibility/free-space maps, WAL state, prepared transactions, sessions,
replication slots, statistics collector data, or replication origins.
Extended-statistics definitions are included; collected samples are not.

Custom archives, compression, encryption, parallel export, incremental dumps,
and point-in-time recovery are outside the current plain-SQL scope.

## Restore verification

Integration tests exercise reusable source/target introspection and restore
comparison for schema, row data, and sequence state. Large-object comparison
helpers and full advanced-object Docker fixtures remain to be added. Tests that
need superuser, filesystem tablespaces, extensions, event triggers, or logical
replication should remain isolated and explicitly labeled.
