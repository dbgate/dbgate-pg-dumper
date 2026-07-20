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

For each server, restore tests create a clean database, render complete COPY
and INSERT dumps, restore them with `psql --set ON_ERROR_STOP=1`, re-introspect,
and compare a normalized structural fingerprint, canonical table values, and
sequence `last_value`/`is_called`. Set `PG_PSQL` when `psql` is not on PATH.

`data-export.test.ts` generates one million rows by default on each server and
streams them through normalized batches. It also covers bytea, JSONB, arrays,
enums, UUIDs, ranges, multiranges where supported, partitions, NULL-heavy
rows, Unicode, emoji, long strings, and a TOAST value larger than 1 MB. Set
`DATA_EXPORT_ROWS` to a smaller value for local smoke runs. The test samples
heap usage and verifies that batches and memory remain bounded.
