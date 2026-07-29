# Plain SQL rendering

The renderer produces deterministic, schema-level PostgreSQL SQL. It supports
schemas, enum types, domains, sequences and ownership, ordinary/unlogged/
partitioned/partition tables, columns, primary/unique/check/foreign-key
constraints, independent indexes, views, materialized views and indexes,
functions, procedures, aggregates, triggers, rules, row-security policies,
comments, ownership, ACLs, and altered default privileges.

Foreign tables are detected but rejected or skipped according to policy because
server/options metadata is not normalized yet. Table and materialized-view
data, sequence current values, large objects, `COPY`, `INSERT`, non-plain
archives, parallel dumping, and materialized-view population are not
implemented. Selected data entries produce structured warnings.

## Order and determinism

The renderer consumes an ordered archive and writes:

1. a deterministic header and version-compatible session setup;
2. clean-mode drops in reverse dependency order, when requested;
3. selected pre-data definitions;
4. diagnostics for selected data entries;
5. selected post-data definitions;
6. a deterministic footer and writer flush.

Output order, keyword case, indentation, line endings, quoting, and statement
comments are configurable. Timestamps are absent unless `includeTimestamp` is
true. PostgreSQL catalog definitions and expressions are preserved without
reparsing.

## Writers, identifiers, and literals

`StreamDumpWriter` writes incrementally, observes writable callbacks and
backpressure, tracks exact UTF-8 bytes, supports `AbortSignal`, and wraps output
failures. It never closes the caller-owned stream. `StringDumpWriter` is for
tests and bounded previews.

Identifiers use PostgreSQL reserved words for supported 9.6–18 targets.
Lowercase safe names remain unquoted; reserved words, mixed case, whitespace,
unsafe Unicode case forms, and embedded quotes are quoted. Qualified names
quote each component. `quoteAllIdentifiers` forces quoting.

Dedicated helpers render ordinary/escaped strings, NULL, booleans, finite
numbers, bigint values, role names including PUBLIC, operators, and
collision-free dollar-quoted bodies. Trusted catalog expressions never pass
through scalar literal interpolation.

## Clean mode

`includeDropStatements` enables reverse-order drops. `ifExists` defaults to
true. `cascade` defaults to false. Database metadata is omitted unless
`includeCreateDatabase` is enabled, avoiding changes to a source-named database
during schema-only restore.

## Target compatibility

Target capabilities are independent from source catalog capabilities:

| Feature                                                             | Minimum target |
| ------------------------------------------------------------------- | -------------- |
| Logical replication, extended statistics                            | PostgreSQL 10  |
| Identity columns, declarative partitioning                          | PostgreSQL 10  |
| Procedures, INCLUDE indexes                                         | PostgreSQL 11  |
| Generated columns, table access methods, function support functions | PostgreSQL 12  |
| Column compression                                                  | PostgreSQL 14  |
| NULLS NOT DISTINCT, security-invoker views                          | PostgreSQL 15  |
| Restrictive policies                                                | PostgreSQL 10  |

`unsupportedFeaturePolicy` is `error` (default), `warn-omit`,
`warn-downgrade`, or `warn-skip`. Safe omission and explicit downgrade modes
retain their conservative guarantees. `warn-skip` is selected automatically
when an explicit target is older than the source, or by `bestEffort: true`. It
uses a known downgrade when available and otherwise omits the incompatible
feature or object. Objects with hard dependencies on an omitted object,
including their table-data entries, are skipped as well. Every lossy change
includes its archive identity and dump ID and is exposed through
`DumpResult.warnings`.

## Diagnostics and tests

`PlainSqlRenderResult` reports bytes, rendered/skipped/failed dump IDs,
warnings, transformations, unsupported objects, and cancellation state.

Unit tests cover object renderers, quoting/literals, clean mode, compatibility,
determinism, and a complete-schema snapshot. Docker tests on PostgreSQL 9.6,
13, and 18 render into a clean database, stop on the first restore error,
re-introspect, and compare a normalized structural fingerprint. `npm test`
remains Docker-free.
