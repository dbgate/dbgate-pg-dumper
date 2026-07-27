# Native restore integration coverage

This report describes the repository after the restore integration audit. Only
tests that execute `PostgreSqlRestoreEngine` through the real node-postgres
adapter and inspect PostgreSQL state count as native restore integration tests.
Unit tests, renderer tests, mocked connections, `psql` restores, and dump-only
tests are excluded.

## Environment and CI

- Docker Compose provides PostgreSQL 9.6, 13, and 18 locally.
- CI runs the dedicated `restore` suite against all three versions with a real
  PostgreSQL service. Failures are not ignored and Vitest reports skipped
  counts.
- Integration tests use one worker, unique schema and role names, ordered
  queries, and `finally` cleanup.
- `PG_TEST_URL` is required by CI and points at the matrix service. There is no
  broad "Docker unavailable" skip.
- Restore input is a structured in-memory archive. Native restore never invokes
  `psql` or `pg_dump`.

The test target is isolated by a unique schema rather than a separate database.
This is sufficient for the tested schema-scoped behavior and permits role tests,
but database-global features need separate-database fixtures in future work.

## Inventory

All entries below are full integration tests, inspect the target database, clean
up in `finally`, and run in the PostgreSQL 9.6/13/18 CI matrix.

| File                                | Test                                                                              | Main coverage and database assertions                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-restore.test.ts`            | restores a structured schema and COPY text payload directly through the driver    | Schema/table/PK, exact escaped rows, NULL/empty/literal markers, Unicode/emoji, unique constraint, ordinary/unique/expression/partial indexes through catalogs, trigger behavior, RLS catalog state |
| `native-restore.test.ts`            | restores exact standalone, serial, and identity sequence state semantics          | Standalone/serial/identity, positive/negative/cycling increments, values above JS safe integer, exact `last_value` and `is_called`; `nextval` only after state assertions                           |
| `native-restore.test.ts`            | loads cyclic foreign-key data before keys and foreign constraints                 | Two tables and data, PK/check/cyclic FK post-data ordering, joined rows and constraint kinds                                                                                                        |
| `native-restore.test.ts`            | restores mapped ownership, comments, ACLs, and default privileges natively        | Catalog owner/comment, behavioral table privilege with grant option, mapped roles, behavioral default privilege on a newly created table                                                            |
| `native-restore.test.ts`            | remaps structured schemas and repeats restore with dependency-aware clean         | Mapped COPY/comment/default privileges, external-view clean protection, repeat clean restore, exact non-duplicated rows and comments                                                                |
| `native-restore.test.ts`            | fails mapped collisions and existing-object conflicts before target modification  | Mapping collision and fail policy; verifies target absence/no modification                                                                                                                          |
| `native-restore.test.ts`            | enforces explicit non-empty target table data policies                            | Fail-if-not-empty, skip-data, truncate, append; exact rows after every policy                                                                                                                       |
| `native-restore.test.ts`            | validates committed structure, row counts, and sequence state independently       | Integrated and independent validation, canonical checksum, intentional row and sequence corruption                                                                                                  |
| `native-restore-data.test.ts`       | restores bytea, UUID, JSONB, arrays, temporal, numeric, and bigint values exactly | Semantic catalog/query verification of bytea, UUID, JSON, JSONB, arrays, date, timestamp, numeric and max bigint                                                                                    |
| `native-restore-resilience.test.ts` | rolls back all earlier work when a later single-transaction step fails            | Intentional DDL failure, absence of earlier objects, idle transaction, reusable session                                                                                                             |
| `native-restore-resilience.test.ts` | continues independent entries and skips dependants after an entry failure         | Partial result, failed entry, dependent skip, independent table/data present, idle session                                                                                                          |
| `native-restore-resilience.test.ts` | reports invalid COPY rows and rolls back the target                               | Real PostgreSQL type rejection, failed data counter, full rollback, archive cleanup, idle and reusable session                                                                                      |
| `native-restore-resilience.test.ts` | cancels an active COPY, rolls back, and leaves no misleading partial target       | Abort on COPY start, no COPY completion, stream/archive cleanup, no target table, idle session                                                                                                      |

Every inventory entry uses the structured `InMemoryRestoreArchiveSource`; none
uses generated SQL, `psql`, or an external dump. The following records the
remaining per-test audit fields. "Default" means the engine's section
transaction mode. Every row is classified as full integration, inspects the
target database, runs on 9.6/13/18 in CI, and has `finally` cleanup.

| Test (short name)            | Restore mode/policy                               | Data checked | Sequence checked |
| ---------------------------- | ------------------------------------------------- | ------------ | ---------------- |
| Basic schema and COPY        | default                                           | exact rows   | no               |
| Exact sequences              | default                                           | no           | exact state      |
| Cyclic foreign keys          | default                                           | joined rows  | no               |
| Ownership/ACL/default grants | default + mapped ownership/roles                  | behavior     | no               |
| Schema remap/repeat clean    | default + remap, preflight and clean              | exact rows   | no               |
| Mapping/conflict preflight   | preflight + fail                                  | n/a          | no               |
| Non-empty table policies     | skip-data, truncate, append and fail-if-not-empty | exact rows   | preserve policy  |
| Independent validation       | default + structure/data validation               | rows/hash    | exact state      |
| Typed COPY values            | default                                           | semantic     | no               |
| Single-transaction rollback  | single + stop                                     | absence      | no               |
| Continue independent entries | entry + continue                                  | exact rows   | no               |
| Invalid COPY row             | single + stop                                     | absence      | no               |
| Active COPY cancellation     | single + abort signal                             | absence      | no               |

### Excluded or potentially misleading tests

- `round-trip.test.ts` is a real dump/restore integration suite but restores
  rendered SQL with `psql`; it is not native restore coverage.
- The restore path inside `introspection.test.ts` also uses `psql`; it validates
  rendered dumps, not `PostgreSqlRestoreEngine`.
- Restore unit tests use mocked connections and are not counted.

No existing test named as a native restore integration test was found to be a
mock-only or success-result-only test. Before this audit there were eight
qualifying native tests; five were added.

## Capability matrix

Legend: **covered** means a real native restore test verifies PostgreSQL state;
**partial** means only a subset is verified; **missing** means implemented or
plausible but lacks native integration coverage; **not implemented** means the
product has no corresponding restore feature; **blocked** means the CI
environment or archive model cannot currently supply a real test.

| Capability                                                                     | Status          | Evidence or gap                                                                                                              |
| ------------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Schema/table/data/primary key                                                  | covered         | Basic native restore                                                                                                         |
| COPY escaping, NULL, empty, literal `\\N`, tabs/newlines/CR/backslashes/quotes | covered         | Exact ordered row comparison                                                                                                 |
| Unicode and emoji                                                              | covered         | Exact target text                                                                                                            |
| bytea, UUID, JSON, JSONB, arrays                                               | covered         | Typed-data test                                                                                                              |
| dates, timestamps, numeric, bigint                                             | covered         | Typed-data test, including max bigint                                                                                        |
| Sequence definitions/state, standalone, serial, identity                       | covered         | Exact non-mutating state assertions                                                                                          |
| Primary/unique/check/foreign/cyclic constraints                                | covered         | Catalog kinds and data join                                                                                                  |
| Exclusion constraints                                                          | missing         | No native archive fixture                                                                                                    |
| Ordinary/unique/expression/partial indexes                                     | covered         | `pg_get_indexdef` and predicate assertions                                                                                   |
| Views                                                                          | missing         | No native restore database assertion                                                                                         |
| Materialized views                                                             | missing         | No native restore database assertion                                                                                         |
| Functions                                                                      | partial         | Trigger function exists behaviorally; routine metadata not compared                                                          |
| Procedures                                                                     | missing         | PG11+ native restore fixture absent                                                                                          |
| Triggers                                                                       | covered         | Catalog/result count and actual insert behavior                                                                              |
| Rules                                                                          | missing         | Native fixture absent                                                                                                        |
| RLS                                                                            | partial         | Enabled state and SELECT policy restored; FORCE, WITH CHECK and behavior by restricted role absent                           |
| Ownership                                                                      | partial         | Mapped ownership covered; preserve/current-user modes absent                                                                 |
| Comments                                                                       | partial         | Column and mapped table comment paths; schema/table/function variants incomplete                                             |
| ACLs/PUBLIC/default privileges                                                 | partial         | Mapped table grant + grant option and default privileges; column/sequence/routine/revoke/PUBLIC behavioral matrix incomplete |
| Missing-role policies                                                          | missing         | Unit coverage only                                                                                                           |
| Role remapping                                                                 | covered         | Ownership, ACL and default privilege mapping                                                                                 |
| Schema remapping/collision                                                     | covered         | Mapped restore and no-modification collision                                                                                 |
| Tablespace remapping                                                           | blocked         | Mapping is implemented; CI cannot provision filesystem tablespace directories through SQL alone                              |
| Clean restore/external protection                                              | covered         | Repeat clean and external dependent view block                                                                               |
| Skip conflicts/non-empty/truncate/append                                       | covered         | Exact target rows                                                                                                            |
| Replace-safe                                                                   | missing         | No real view/routine replacement integration test                                                                            |
| Cancellation                                                                   | covered         | Active COPY cancellation and rollback                                                                                        |
| Invalid COPY data/server rejection                                             | covered         | Real integer conversion failure, rollback, cleanup and idle session                                                          |
| Continue-on-error                                                              | covered         | Independent success and dependent skip                                                                                       |
| Transaction modes                                                              | partial         | Single rollback and entry continue covered; section/none failure semantics remain unit-only                                  |
| Post-restore validation                                                        | covered         | Pass, corruption, row-count/checksum/sequence mismatch                                                                       |
| Persistent archive restore                                                     | not implemented | Only `InMemoryRestoreArchiveSource` exists                                                                                   |
| Native dump → restore → dump round trip                                        | blocked         | Dump archive entries are not yet adapted into the structured restore archive; existing round trip uses `psql`                |
| Fixed-point restore                                                            | partial         | Mapped clean repeat restore is stable; native second-dump comparison is blocked                                              |
| Cross-version native restore                                                   | covered         | Full restore suite runs on 9.6, 13 and 18                                                                                    |

## Risk findings and priorities

### P0 addressed in this audit

- Single-transaction rollback previously had mocked-driver coverage only.
- Continue-on-error and dependency skip previously had mocked-driver coverage
  only.
- COPY cancellation previously had streaming unit coverage only.
- Invalid COPY input now verifies real server rejection, rollback and cleanup.
- Typed bytea/UUID/JSON/JSONB/array/temporal/numeric restore was absent.
- Index tests trusted result counters and now inspect semantic catalog
  definitions.
- Check constraints are now included with cyclic FK ordering.

### Remaining P0

- A true library structured dump → native restore → structured dump round trip
  is blocked by the missing dump-archive-to-restore-archive adapter.

### Highest-risk remaining P1

- Missing-role policy outcomes.
- Column, sequence, routine, PUBLIC and revoke ACL behavior.
- RLS FORCE/WITH CHECK behavior under a non-owner role.
- `replace-safe` view/routine behavior.
- Preserve and current-user ownership policies.

### P2 and blocked work

- Tablespace mapping needs a container helper capable of creating a target
  filesystem directory.
- Persistent archive tests are blocked because persistent archive support is
  not implemented.
- Materialized views, procedures, rules, exclusion constraints, and richer
  routine metadata need dedicated native fixtures.

## False-confidence controls

- Tests assert catalogs, rows, sequence state, privilege functions, definitions,
  transaction state, and cleanup rather than only restore status.
- Sequence state is inspected before any mutating `nextval`.
- Row queries use explicit ordering.
- Existing-target tests deliberately populate the target; other tests use
  unique empty schemas.
- Errors are not swallowed. Expected failures assert status, failed/skipped
  counts, and database state.
- Identity syntax is gated only for the genuine PostgreSQL 9.6 difference.
- The CI matrix passes the real target version and runs every native restore
  test on each declared version.

## Recommended next testing task

Build a restore performance and stress-test suite covering large COPY payloads,
bounded memory, cancellation latency, controlled validation concurrency, and
multi-gigabyte persistent archives once that format exists.
