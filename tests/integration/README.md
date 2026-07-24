# PostgreSQL integration tests

The integration suite is separate from `npm test` and requires Docker.

```sh
docker compose -f docker-compose.integration.yml up -d --wait
npm run test:integration
docker compose -f docker-compose.integration.yml down -v
```

The configured matrix covers PostgreSQL 9.6 (oldest supported catalog), 13
(middle feature set), and 18 (latest stable major when this matrix was created).
Connection URLs can be overridden with `PG96_URL`, `PG13_URL`, and `PG18_URL`.

Fixtures cover standalone, SERIAL, and identity sequences; enum and domain
types; primary, unique, check, and composite deferrable foreign-key constraints;
expression, partial, INCLUDE, and partitioned indexes; range partitions and
default partitions; views and security options; materialized views and indexes;
SQL and PL/pgSQL functions; overloads; procedures; aggregates; triggers,
transition tables, and rules; comments; quoted-role and PUBLIC grants; altered
default privileges; permissive and restrictive row policies; mixed-case
identifiers; and Unicode identifiers and data.

For each server, compatibility tests create a clean database, render complete
COPY and INSERT dumps, restore them with `psql --set ON_ERROR_STOP=1`,
re-introspect, and compare a normalized structural fingerprint, canonical
table values, and sequence `last_value`/`is_called`. Set `PG_PSQL` when `psql`
is not on PATH. The independent `native-restore.test.ts` path restores canonical
COPY text directly through node-postgres without invoking `psql`. It also
verifies exact `setval`/`is_called` behavior for standalone, serial, identity,
descending, large, and cycling sequences; post-data trigger/RLS ordering; and
cyclic foreign keys added after data. Native restore coverage additionally
exercises mapped schemas, comments and default privileges, preflight mapping
collisions, existing-target fail/skip/clean behavior, external-dependency
protection, and fail/skip/truncate/append policies for non-empty target tables.
The clean test repeats a restore into the same mapped target and verifies that
objects and rows are recreated without duplication.
Native validation coverage verifies committed session health, mapped structural
identities, exact row counts, and lossless sequence state. It then corrupts a
row and sequence after a successful restore and confirms that independent
validation reports both mismatches without invoking `nextval()`.

`round-trip.test.ts` adds the reusable dump A → restore → dump B harness,
byte-exact and narrowly canonical comparison, semantic keyed-row and multiset
comparison, optional dump C fixed-point checks, and detailed artifacts under
`test-output/round-trip`. See
[the round-trip strategy](../../docs/round-trip-testing.md).

The npm scripts split CI-sized groups:

```sh
npm run test:integration:schema
npm run test:integration:data
npm run test:integration:advanced
npm run test:integration:cross-version
npm run test:integration:restore
npm run test:integration:slow
```

`data-export.test.ts` generates one million rows by default on each server and
streams them through normalized batches. It also covers bytea, JSONB, arrays,
enums, UUIDs, ranges, multiranges where supported, partitions, NULL-heavy
rows, Unicode, emoji, long strings, and a TOAST value larger than 1 MB. Set
`DATA_EXPORT_ROWS` to a smaller value for local smoke runs. The test samples
heap usage and verifies that batches and memory remain bounded.
