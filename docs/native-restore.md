# Native PostgreSQL restore

## Architecture

The native restore engine validates and plans a structured archive, inspects
the PostgreSQL target, and executes trusted SQL, native table data, and sequence
state on one acquired PostgreSQL session. It does not parse plain SQL or invoke
`psql`.

`RestoreArchiveEntry` remains the single data model. A table-data operation
contains a stable entry ID, target table, ordered target columns, lazy source
stream ID, format metadata, row/byte estimates, identity and partition policy,
transaction requirement, dependencies, and optional SHA-256.

```text
RestoreArchiveSource.openData()
        |
optional final psql terminator stripper
        |
byte, row, and SHA-256 monitor
        |
PostgreSQL COPY FROM STDIN writable
```

Node's `pipeline()` provides backpressure and propagates source, transform,
writable, server, and cancellation failures. The payload is never materialized
as one buffer or string. Archive data is opened only when its plan step starts;
single-use sources reject a second open and are destroyed during every cleanup
path.

## Driver capability

`PostgresRestoreConnection.openCopyFrom()` returns:

- a Node `Writable`;
- a completion promise that resolves only after PostgreSQL confirms COPY;
- an idempotent abort operation.

The optional `pg` entry point implements the contract with
`pg-copy-streams` 7. The dependency is optional because core archive,
introspection, and rendering users do not need node-postgres. Third-party COPY
types stay inside the adapter. COPY uses the same `Client` or `PoolClient` as
the surrounding restore transaction and never opens a hidden connection.
Destroying an active stream sends PostgreSQL `CopyFail`; listeners are removed
after success or failure.

## Canonical COPY text format

The first native loader intentionally supports one fixed format:

- UTF-8 bytes and a PostgreSQL client encoding of `UTF8`;
- PostgreSQL text COPY;
- tab delimiter;
- `\N` NULL marker;
- PostgreSQL backslash escapes;
- LF line endings;
- a required final LF for a non-empty payload;
- exactly one physical line per logical row.

Embedded tabs, newlines, carriage returns, backslashes, literal `\N`, and
literal `\.` are escaped by the dump serializer. It is therefore safe to count
physical LF bytes as rows. Arbitrary byte values use PostgreSQL text
representations such as escaped `bytea`; unknown encodings are not transcoded.
CSV and binary COPY fail preflight.

The preferred archive payload is raw COPY data without `psql`'s `\.` marker.
An entry may explicitly declare a rendered psql marker. A bounded tail
transform then removes only the final exact `\.\n`; it never removes arbitrary
lines from user data.

## Command generation and mappings

COPY SQL is generated only from structured metadata. Every schema, table, and
column identifier is quoted, target column order is preserved, and an empty
column list is rejected unless explicitly declared valid. Schema mappings are
applied to the structured target before command generation. Arbitrary COPY SQL
from an archive is not accepted.

Schema resolution is centralized and supports `preserve`, `explicit`, and
`single-target-schema`. Explicit mappings retain an independent source and
target identity; single-target mode rejects collisions before any target
modification. System, temporary, TOAST, and known extension-managed schemas are
protected from remapping. COPY targets, sequence state, ownership, comments,
ACLs, default privileges, and parent identities all use the same resolved
schema.

DDL can opt into `structuredFragments`. Literal SQL fragments remain literal,
while identifier and tablespace fragments are renderer-authored and quoted
after mapping. This is not SQL parsing or textual replacement. A remapped DDL
target without structured fragments fails preflight. Opaque expressions, view
definitions, procedural bodies, trigger predicates, policy expressions, and
stored search-path text remain unchanged and produce a warning, or an error
under the strict opaque-reference policy. The engine never relies on an ambient
`search_path`.

Tablespace resolution supports `preserve`, `explicit`, `omit`, and
`default-target`. Named mappings must resolve to a catalog tablespace; the
engine never reuses source filesystem locations and never creates tablespaces.
`tablespace-clause` fragments own the complete optional clause so omit/default
policies cannot leave invalid partial SQL. Table, partition, materialized-view,
standalone index, and constraint-backed index metadata remain distinct.

## Existing targets and clean planning

Target inspection loads schemas, relations, sequences, indexes, constraints,
views, materialized views, types, domains, exact routine signatures,
extensions, publications, statistics, columns, tablespaces, extension
membership, view dependencies, and foreign-key table dependencies. Conflicts
record the archive entry, source and mapped identities, both object kinds,
compatibility, classification, policy, and remediation.

Existing-object policies are:

- `fail`: any creation conflict blocks preflight;
- `skip`: a compatible existing definition step is skipped and can satisfy
  archive dependencies;
- `clean`: selected conflicts are dropped in reverse target dependency order;
- `replace-safe`: only an explicit allowlisted replacement strategy is used.

Clean uses dedicated `drop-object` plan steps before pre-data. Drop SQL contains
exact routine identities and parent identities and never adds implicit
`CASCADE`. The default `selected-only` scope blocks unselected views,
foreign-key dependants, or objects remaining inside a selected schema.
`selected-and-owned-dependents` may account for indexes, constraints, triggers,
and policies owned by a selected parent, but it still does not broaden into
arbitrary external objects. Extension members are not independently replaced;
an explicitly selected extension is handled as one unit.

Dropping a schema is allowed only when its schema entry itself conflicts and
the inspected scope contains no unselected objects that would be removed.
Section and entry transaction modes commit clean separately from later work,
so the destructive-impact report warns that a later failure may leave the
target modified. A single compatible transaction provides rollback across
clean, restore, and finalization.

The initial replace-safe allowlist is views, functions, procedures, triggers,
policies, and statistics. Every replacement must declare its strategy.
`CREATE OR REPLACE` views additionally provide expected ordered names and
formatted types, while routines provide the expected return type; these are
compared with the inspected target. Tables, enums, domains, partition
hierarchies, aggregates, and extensions are not treated as safely replaceable.

## Existing table data and sequence state

The default existing-table data policy is `fail-if-not-empty`. A typed
assertion executes immediately before COPY, so stale row estimates cannot make
the check unsafe. Other explicit policies are `skip-data`, `truncate`, and
`append`. Truncation uses an exact table identity without `CASCADE` and is
blocked by inspected external foreign keys. Append emits a semantic warning,
because duplicates, unique violations, and round-trip equality are not
guaranteed. Existing columns are checked in COPY order and generated columns
remain excluded.

Existing sequence state is independently controlled by `preserve-archive`,
`preserve-target`, or `error`. `advance-to-safe-value` is reserved but currently
fails preflight: arbitrary use of `MAX(column)` is not safe for descending,
shared, manually managed, cycling, or non-unit sequences.

Preflight and dry-run return a machine-readable destructive-impact report with
conflicts, drops, replacements, truncations, appends, ownership/ACL effects,
external dependency blocks, schema/tablespace mappings, and rollback scope.
The core library never prompts; a CLI or UI owns confirmation.

## Identity, partitions, foreign tables, RLS, and triggers

Generated stored columns cannot appear in COPY input. Identity values are
either preserved by including all declared identity columns or generated by
omitting them; inconsistent metadata fails preflight.

Physical leaf-partition COPY is the default archive policy. Copying through a
partitioned root must be explicit. A shared partition data-set ID prevents an
archive from mixing root-routed and leaf rows and duplicating data.

Foreign-table data is skipped by default. An archive that requires it fails
unless the caller explicitly enables required foreign-table loading.

Normal RLS and trigger behavior is the default. The existing explicit
`replica-role` option uses transaction-local
`session_replication_role = replica`, warns about required privilege, and is
rejected in transaction mode `none`. Commit or rollback restores the setting.
The engine never silently bypasses RLS.

## Transactions, cancellation, and errors

COPY participates in all existing transaction modes:

- `single`: the same COPY session stays inside the global transaction;
- `section`: data loads use the data-section transaction;
- `entry`: each compatible table load gets its own transaction;
- `none`: no automatic transaction command is issued.

A failed COPY rolls back the active scope before the session is reused.
Continue-on-error records the failed table, skips invalid dependants, and
returns `partial`. Committed table/row/byte totals are kept separate from
attempted/completed/failed COPY statistics.

Cancellation stops the archive source, destroys COPY, invokes adapter abort,
rolls back an active transaction, releases resources, and returns `cancelled`
instead of a generic COPY error.

COPY errors include step/archive/table identity, safe SQLSTATE and PostgreSQL
fields, approximate bytes/rows, and a truncated generated command. Raw input
rows are not copied into the top-level error. Progress order is stable:
`step-started`, `copy-started`, zero or more `step-progress`,
`copy-completed`, `step-completed`.

## Sequence definition and runtime state

A sequence definition is a pre-data structural operation. It contains its data
type, increment, minimum, maximum, start value, cache, cycle behavior, and
eventual ownership. Runtime state is a separate structured operation containing
only the lossless decimal `lastValue` and `isCalled`.

Runtime state is never derived from table data or `MAX(column)`. This preserves
empty and never-used sequences, manual advancement/reset, non-unit and negative
increments, cycling sequences, and states deliberately unrelated to table
values. Values stay as decimal strings and are validated against the declared
smallint, integer, or full signed bigint range without conversion through a
JavaScript number.

The executor uses parameterized three-argument `pg_catalog.setval`:

```sql
SELECT pg_catalog.setval(
  $1::pg_catalog.regclass,
  $2::pg_catalog.int8,
  $3::pg_catalog.bool
)
```

The regclass parameter contains a fully quoted schema and sequence identity.
When `isCalled` is false, the next `nextval` returns the archived value; when it
is true, PostgreSQL applies the sequence's own increment and cycle rules.

Traditional serial sequences remain explicit sequence definitions with column
defaults and later `OWNED BY` finalization. Identity sequence state records the
owned column and `always`/`by-default` relationship, while the table identity
definition creates its internal sequence. Both restore copied identity values
first and exact sequence state afterward.

Sequence failures have a dedicated structured error with step, archive and
sequence identity, attempted state, phase, SQLSTATE, server fields, and a safe
query preview. Continue mode rolls back the active scope, skips only dependent
steps, and reports failed sequence validation.

## Restore phase ordering

Explicit phases are used after dependency-aware topological sorting:

```text
pre-data
-> table-data
-> sequence-state
-> post-data
-> ownership
-> comments
-> privileges
-> validation
```

Explicit archive dependencies always take precedence over type priority. Within
post-data, the default priority is key constraints, secondary indexes, foreign
keys, triggers, rules, policies, and remaining finalization. Primary/unique and
secondary indexes are therefore built after bulk data by default; foreign keys
are added after all required data and referenced keys, allowing cyclic FK data
sets to load without artificial table dependencies.

Triggers, rules, and RLS policies are also restored after data. Application
triggers cannot mutate archived COPY rows, and archived RLS does not block the
load. The final RLS state is then recreated rather than silently bypassed.
Ownership is delayed so the active restore role retains control through
structural and data work. Comments follow their targets, while ACL and default
privilege operations run last so they cannot remove privileges needed by later
steps.

## Ownership, comments, and privileges

Finalization metadata has dedicated structured archive operations and plan
steps; it is not recovered by parsing rendered SQL. Ownership supports
databases, schemas, relations, sequences, routines, types, and the other
PostgreSQL forms represented by `RestoreObjectTarget`. Comments preserve quoted
identifiers, Unicode, newlines, empty strings, and explicit `NULL` removal.

ACL operations distinguish grants, revokes, and grant-option revokes. Column
privileges retain the parent table identity, routine privileges retain exact
identity arguments, and `PUBLIC` is a principal rather than a quoted role.
Broad `REVOKE ALL ... FROM PUBLIC` initialization is emitted only when an
archive explicitly marks a newly created target with the `exact-new-object`
baseline. Default privileges retain owner, optional schema, object category,
grantee, grant option, and action. `MAINTAIN` is rejected during preflight
before PostgreSQL 17.

Role resolution is centralized and deterministic. A role can be preserved,
mapped, mapped to the current user, or omitted. Missing roles use the explicit
`error`, `warn-and-omit`, or `map-to-current-user` policy. The engine never
creates roles. Grantor preservation uses a narrowly scoped `SET ROLE` around
one privilege step only when target inspection confirms that the session may
assume the role (or is superuser); `RESET ROLE` runs in `finally` before a
transaction can commit. Best-effort privilege mode falls back to the current
user when grantor identity cannot be retained. Preflight reports role
resolution counts and blocks unresolved ownership or privilege references.

Section mode creates controlled transactions for these logical phases. Entry
and single transaction modes preserve the same ordering. Before execution, plan
validation rejects missing/forward dependencies, early sequence/FK steps, and
generated COPY columns.

## Checksums and statistics

SHA-256 is computed while bytes flow to PostgreSQL. It covers the exact raw
native COPY payload after an optional psql marker is removed. Because
pre-verification would require buffering, a mismatch is detected after COPY
acceptance and causes transaction rollback.

Results report tables attempted/completed/failed, committed tables, known rows,
committed bytes, COPY duration, and archive-read duration. Progress reports
archive bytes read, COPY bytes written, current table, estimates, rows under
the one-line-per-row invariant, and elapsed time.

## Post-restore validation and confidence

Validation runs after the restore transaction has committed and session
finalization has reset role and replication settings. This means validation
observes externally visible state and cancelling validation never rolls back a
completed restore. `PostgreSqlRestoreEngine.validate()` exposes the same
subsystem independently for delayed or repeated verification.

The levels are:

- `none`: no checks and `unverified` confidence;
- `basic` (default): connection, transaction/session health, and structured
  target existence;
- `structure`: basic checks plus the structural metadata that the archive
  carries explicitly;
- `structure-and-data`: structure plus configured exact row counts, canonical
  target checksums, and non-mutating sequence-state reads;
- `full`: all currently supported checks. Comparisons whose expected metadata
  is absent are reported as `unavailable`, never silently passed.

Validation options independently control failure handling
(`fail-restore`, `report-partial`, or `warn-only`), row counts, checksums,
sequence state, ownership/comments/privileges/tablespaces/statistics, unordered
tables, deterministic sampling metadata, and bounded concurrency. The current
single-session implementation deliberately executes checks serially even when
a higher concurrency is requested; it never fans queries out unsafely on one
connection.

Confidence is derived from evidence. Basic validation is `low`; successful
structure validation is `medium`; complete structure-and-data checks with no
unavailable checks are `high`. Any failed/warning check, skipped restore step,
partial execution, unresolved mapping, cancelled validation, warn-only
failure, or destructive partial-state risk lowers confidence. Execution status
and validation status remain separate in `RestoreResult`.

Exact row-count mode executes `count(*)` with mapped, quoted identities and
uses decimal strings for bigint results. Appended and intentionally skipped
table data are classified as policy skips rather than false mismatches.
Partition counts follow the archive table-data targets, preventing an implicit
root-plus-leaf double count.

Sequence validation reads `last_value` and `is_called` directly and never calls
`nextval()`. `preserve-target` sequence policy skips archive-state comparison.
Values remain lossless decimal strings.

Canonical target checksum validation is available only when the structured
table-data operation contains both an expected canonical SHA-256 and stable
order columns. Rows are read in that explicit order and hashed incrementally
from type-tagged canonical values. Archive-payload SHA-256 proves the bytes
accepted by COPY but is explicitly not treated as proof of current target
data. Tables without a stable key currently produce an unavailable/warning
result unless a compatible ordering is supplied; sampled and external-sort
multiset validation remain future work.

The machine-readable result contains stable check IDs, expected and actual safe
values, per-check durations, diagnostic codes, counts performed/passed/failed/
skipped/unavailable, objects verified, tables counted/checksummed, rows and
bytes scanned, sequence states verified, status, and confidence.

## Limitations and next task

The engine does not support binary/CSV COPY, arbitrary pg_dump/plain-SQL
parsing, automatic retry, parallel data restore, large objects, or implicit
trigger/RLS disabling. Post-data SQL is trusted structured archive content;
fully typed renderers for every constraint/index/trigger/rule variant remain
future work.

The recommended next task is a persistent custom archive format with manifests,
external data streams, compression-ready storage, random access, and integrity
verification.
