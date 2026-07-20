# Table data and sequence export

`dbgate-pg-dumper` streams table rows through three independent layers:

```text
ordered table-data archive entries
  -> bounded PostgreSQL cursor reads
  -> normalized canonical-text batches
  -> COPY or INSERT serializer
  -> backpressure-aware DumpWriter
```

The complete table and complete batch are never converted into one string.
Cursor and batch sizes bound row buffering. COPY values are escaped and written
incrementally. INSERT memory is bounded by `rowsPerInsert` (default 100) and
`maxInsertStatementBytes` (default 1 MiB), except that one indivisible source
row may itself be larger than that limit.

## Output modes

- `dataFormat: 'copy'` is the default and emits one `COPY ... FROM stdin` block
  for every non-empty selected table.
- `dataFormat: 'insert'` emits bounded multi-row INSERT statements. Column
  lists are added whenever generated, excluded, or identity columns make them
  necessary.
- `dataFormat: 'column-inserts'` always includes the exported column list. This
  tolerates a different target column order when names and types remain
  compatible; it does not repair an incompatible schema.

`tableDataFormats` can override the mode by `schema.table`. Empty tables emit no
COPY block and no INSERT; statistics record them as skipped with zero rows.
`excludedDataColumns` removes named columns while preserving physical order for
the remainder. Generated stored columns are always excluded.

## Exact value fidelity

Every exported column is selected as:

```sql
(column_name)::pg_catalog.text AS column_name
```

PostgreSQL's own type output function therefore formats bigint, numeric,
temporal, interval, array, composite, range/multirange, bytea, JSON, enum,
domain, money, bit-string, network, geometric, and extension values before they
cross the driver boundary. The serializers do not use JavaScript `Date`,
`Number`, JSON stringification, or reconstructed container syntax.

INSERT mode quotes this canonical text as a standard-conforming string and
casts it to the catalog-formatted column type. COPY mode passes it through
PostgreSQL COPY text escaping. Native custom-adapter values are accepted only
for lossless strings, booleans, bigint, safe integers, and byte arrays;
potentially lossy parsed objects and unsafe numbers fail with a structured
diagnostic.

`bytea` uses PostgreSQL hexadecimal text (`\x...`). Native `Buffer` and
`Uint8Array` fallback values are converted to the same representation.

## COPY escaping

COPY uses `\N` for SQL NULL. Empty strings are empty fields. The serializer
escapes backslash, tab, newline, carriage return, backspace, form feed, and
vertical tab with COPY's named escapes. Other C0 controls and DEL use
three-digit octal escapes. Unicode is unchanged.

A literal `\N` becomes `\\N`, and literal `\.` becomes `\\.`. Thus data cannot
be mistaken for NULL or terminate the COPY block. CRLF and mixed newline styles
are escaped character by character. Output line endings are deterministic.

## Identity and sequence state

COPY supplies identity values directly. INSERT modes use `OVERRIDING SYSTEM
VALUE` for exported `GENERATED ALWAYS` columns. If the target predates identity
support, or overriding is disabled, serialization fails before an unsafe
statement is emitted.

Sequence metadata is read from the sequence relation inside the same dump
snapshot, preserving both `last_value` and `is_called`, including never-called
sequences. Data-section `pg_catalog.setval` statements run after owned table
data. Source state is preserved exactly; it is not silently replaced by
`MAX(column)`.

## Partitions, foreign tables, and row security

Partitioned parents are not read. Leaf partitions are exported with `ONLY`, so
rows are neither routed through the parent nor duplicated. Ordinary inheritance
relations are likewise read independently with `ONLY`.

Foreign-table data is omitted by default and produces a diagnostic. Set
`includeForeignTableData: true` to attempt ordinary cursor reads. Success then
depends on the FDW and source permissions. Foreign-table definition rendering
still requires server/option metadata that is not currently introspected.

`rowSecurityMode` is explicit:

- `disable` (default) executes `SET LOCAL row_security = off` when selected
  tables use RLS. PostgreSQL fails instead of silently filtering if the role
  cannot bypass the policies.
- `honor` exports exactly the rows visible to the current role and warns that
  the dump can be partial.
- `require-complete` rejects selected RLS tables during planning.

## Restore behavior

`restoreTriggerMode: 'normal'` is the default. The opt-in `replica-role` mode
surrounds table data with `SET session_replication_role`, emits a visible
warning, may suppress user logic, and normally requires elevated privileges.

`restoreTransactionMode` supports `none`, `single`, and `sections`. Section mode
uses separate transactions for pre-data, data, and post-data. `CREATE DATABASE`
cannot be combined with a transaction wrapper. Statements with PostgreSQL
transaction restrictions must be selected accordingly.

Serialization and writer failures are fail-fast by default; no successful
footer is written after failure. With `bestEffort: true`, recoverable table
read/serialization failures close the current COPY fragment (or discard
unflushed INSERT rows), emit a visible `INCOMPLETE` SQL comment, continue at the
next table, and return structured errors with `incomplete: true`. Output writer
failures are never recoverable. Diagnostics contain table/archive identity, row
number, column, PostgreSQL type, stage, and cause. Values are secret-safe by
default; debug mode includes only a truncated description. Progress is
throttled and reports rows, bytes, INSERT statements, COPY completion, and
table completion.

## Current limits

Large objects in `pg_largeobject`, materialized-view contents, custom archive
formats, compression, encryption, parallel data export, incremental dumps,
COPY FREEZE, automatic sequence `MAX(column)` repair, and per-table trigger
disable/enable are not implemented. COPY FREEZE requests fail validation
instead of changing semantics silently.
