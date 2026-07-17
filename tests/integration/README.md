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

For each server, a restore test also creates a clean database, renders the
ordered archive as plain schema SQL, restores with stop-on-first-error
semantics, re-introspects, and compares a normalized structural fingerprint.
Data and sequence-state restoration are intentionally outside the current
scope.
