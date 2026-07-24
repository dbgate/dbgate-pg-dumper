# Dump round-trip testing

The integration suite treats a dump as a restoreable representation, not
merely as plausible SQL. Its primary flow is:

1. create and populate a unique source database;
2. produce dump A;
3. restore A into a unique empty database with `psql` and `ON_ERROR_STOP=1`;
4. produce dump B from the restored database;
5. compare the dumps according to the selected policy;
6. independently compare normalized catalogs, table values, sequence state,
   and, when enabled, large objects.

The reusable implementation is in
`tests/integration/support/roundTripHarness.ts`. A test supplies source and
restore servers, dump options, a fixture callback, a comparison policy, and
the exact warning codes it expects. Database names contain a random per-run
suffix, and cleanup affects only those databases.

## Exact and semantic comparison

Exact mode compares the UTF-8 bytes of dump A and dump B. Tests using it
disable timestamps, select LF endings, and use stable object and row ordering.
A failure records the first byte, first line, nearest `-- Entry` archive
marker, and a focused unified diff.

Canonical mode is deliberately narrow. It may:

- convert CRLF or CR to LF;
- remove trailing whitespace;
- remove explicitly configured metadata-comment prefixes (by default,
  `-- Generated at:`);
- collapse repeated blank lines;
- when a test explicitly opts in, sort independent ACL or comment statements.

It does not parse, reformat, reorder, or rewrite arbitrary SQL. Changes to
expressions, literals, identifiers, statement order, or syntax remain visible.
Semantic-only mode does not require textual dump equality and is the normal
choice for physical data export and cross-version restores.

## Row-order policy

PostgreSQL tables have no inherent row order. Test policies make that explicit:

- `deterministic` is used only for controlled fixtures with stable keys;
- `physical` does not assert textual equality of data sections;
- `schema-only` compares schema text and does not compare unexported rows.

The production dumper does not silently add `ORDER BY`, which could require a
large sort and materially increase dump cost. Independent data comparison
orders keyed tables by primary key. Keyless tables are compared as sorted row
multisets, preserving duplicate counts.

Values are requested from PostgreSQL in canonical text form. `bytea` is hex
encoded and `json`/`jsonb` passes through `jsonb`, so object-key order and
whitespace do not cause false differences. NULL remains distinct from an empty
string. Fixtures cover numeric limits, temporal values, UUID, JSON, arrays,
ranges and multiranges, network and geometric types, enums,
domains, COPY controls, Unicode, generated and identity columns, partitions,
cyclic foreign keys, expression and partial indexes, comments, sequences, and
large objects.

## Structural, sequence, and large-object comparison

Both databases are introspected. Normalization removes database and catalog
OIDs, internal OID links, and estimated row counts. Names, definitions, owners,
ACLs, comments, object properties, and sequence configuration remain. Sequence
runtime state is compared for data dumps and ignored for schema-only dumps,
which do not export it.
Every difference contains an object identity, property path, source and
restored values, and a classification. No semantic classification is accepted
unless the individual test explicitly approves it.

Large-object tests preserve OIDs and compare owner, ACL, comment, size, and a
page-by-page SHA-256 digest of the binary content.

## Fixed-point tests

With `fixedPoint` enabled, the harness restores dump B into a third database
and produces dump C. It applies the same exact or canonical policy to B and C.
This tests the stronger invariant:

```text
dump(restore(dump(database)))
```

must remain stable even when an arbitrary source first undergoes a documented
version normalization.

## Failure artifacts

Failures are retained under `test-output/round-trip/<test-name>/`, ignored by
Git. Depending on progress, artifacts include dumps A/B/C, raw and canonical
diffs, first-difference metadata, normalized models, structural/data/sequence
reports, redacted restore stdout and stderr, warnings, preflight results, and
dump statistics. CI uploads the directory only on failure.

## Matrix and CI groups

The same-version matrix covers PostgreSQL 9.6, 13, and 18. It exercises exact
schema, COPY, INSERT, column INSERT, clean, no-owner, no-privileges, and
no-comments modes. COPY additionally runs B-to-C fixed-point and large-object
checks. Physical-order mode performs semantic data comparison.

CI separates Docker-free unit tests, schema round trips, data round trips,
advanced objects, optional cross-version tests, and the slow million-row
bounded-memory suite. PostgreSQL versions run in parallel.

Cross-version tests use semantic comparison by default. Compatible fixtures
restrict themselves to features shared by both versions. Unsupported-feature
tests must set the intended target version and expect preflight failure before
restoration.

## Legitimate A/B differences

Dump A may legitimately differ from dump B when row order is physical,
PostgreSQL canonicalizes a definition during restore, a newer server supplies a
version-specific default, owners or extension details are intentionally
mapped, or configured metadata changes. Such tests use semantic or narrowly
canonical comparison; dump B must still equal dump C when fixed-point testing
is enabled.

In summary, the harness owns lifecycle, strict restore, diagnostics,
model/data/state comparison, fixed-point execution, and artifacts. Exact mode
is byte-oriented, semantic mode is PostgreSQL-value-oriented, and only an
explicit policy can approve a mismatch.
