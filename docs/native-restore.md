# Native PostgreSQL restore architecture

## Status and scope

The native restore subsystem is a foundational standalone TypeScript boundary.
It validates and plans a structured archive, inspects a PostgreSQL target, and
can execute small trusted SQL and sequence-state operations through the existing
driver abstraction.

This milestone deliberately does not implement COPY loading, plain-SQL parsing,
cleanup, remapping, create-database mode, role creation, subscriptions, large
objects, parallelism, compression, or encryption. Unsupported operations fail
preflight instead of being reported as restored.

## Existing architecture reused

The implementation is incremental and does not move the dump pipeline.

| Existing concept                               | Restore use                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `PostgresConnectionInput`                      | Physical target session, queries, abort, acquisition and release |
| `PostgresVersion` and its detector             | Target detection and version constraints                         |
| `ArchiveObjectType`, `DumpSection`, stable IDs | Entry identity, ordering and diagnostics                         |
| `dumpSectionPriority()`                        | Deterministic cross-section planning                             |
| SQL identifier quoting                         | Safe generated operations                                        |
| sensitive-value redaction                      | Errors, previews, diagnostics and logs                           |
| `AbortSignal`                                  | Query cancellation, rollback and cleanup                         |

Dump entries remain connection-free object records. `RestoreArchiveEntry` adds
an explicit executable operation to stable identity and dependency information,
without changing working dump renderers.

## Relationship between dump and restore

```text
PostgreSQL source
        |
   introspection
        |
normalized dump archive
        |
  +-----+------------------+
  |                        |
plain SQL renderer    structured restore adapter (future)
  |                        |
SQL document          RestoreArchiveSource
                           |
                    native restore engine
                           |
                    PostgreSQL target
```

The engine does not parse this package's plain SQL. Object semantics already
exist before rendering; parsing SQL back would be lossy and require a general
PostgreSQL parser. Future plain-dump support belongs behind a separate source
adapter and may support only a documented subset.

## Structured archive and source

`RestoreArchiveMetadata` contains a format version, archive ID, source version,
target constraints, requirements, estimates, transaction compatibility, and
safe diagnostics. It never contains credentials.

Each `RestoreArchiveEntry` contains a stable entry ID, archive/object identity,
object type, section, dependencies, description, diagnostics, and one
discriminated operation. Initial operations are trusted parameterized SQL,
table-data metadata, and dedicated sequence state. SQL declares transaction and
privilege requirements. Table data reserves COPY text/CSV/binary and INSERT
formats, but currently fails preflight. Sequence state executes parameterized
`setval`.

`RestoreArchiveSource` exposes asynchronous metadata, entry iteration, lazy
data opening, and close. `InMemoryRestoreArchiveSource` is fully supported now;
future directory, manifest, custom-archive, and constrained plain-SQL adapters
can stream metadata and external data through the same boundary.

## Pipeline

```text
Structured archive
        |
archive validator
        |
target preflight
        |
restore planner
        |
restore plan
        |
executor
  +-----+------+
  |            |
SQL steps   data loaders (future)
        |
PostgreSQL target
```

The typed lifecycle is initialization, archive validation, target inspection,
preflight, planning, pre-data, data, sequence restoration, post-data,
ownership/privilege finalization, validation, and completion. Only phases
required by trusted SQL and sequence state execute today.

## Driver and target inspection

Execution reuses `PostgresConnectionInput`. Direct connections are borrowed;
sources are acquired and released. `PostgresRestoreConnection` reserves
optional `openCopyFrom()` and explicit `cancel()` capabilities.
`inspectRestoreDriverCapabilities()` reports actual support; there are no fake
implementations.

`QueryRestoreTargetInspector` reads the version, syntax capabilities, schemas,
extensions, roles, tablespaces, current user, and selected role capabilities.
Complete existing-object and privilege introspection remains future work.

## Preflight

`engine.preflight()` and `preflightRestore()` are read-only APIs. They validate:

- archive format, IDs, identities, dependencies, section direction, and cycles;
- archive/entry version constraints;
- required extensions, roles, tablespaces, and declared privileges;
- transaction compatibility;
- secret-bearing SQL;
- typed mapping resolution;
- unsupported data and destructive policies.

The report contains diagnostics, target inspection, mapping decisions, counts,
and estimates. `preflightOnly` never mutates the target.

## Planner, steps, and transactions

The planner performs a stable topological sort by dependency, section, archive
identity, and entry ID. Every discriminated plan step contains a stable
SHA-256-derived ID, archive entry ID, optional object identity, phase,
dependencies, transaction/privilege requirements, and description.

Step variants reserve SQL, transaction control, data loading, sequence state,
validation, skip, and diagnostic operations. Only SQL, transaction, sequence,
and skip steps execute in this milestone.

Native transaction modes are exported as `NativeRestoreTransactionMode` to
preserve the existing plain-SQL `RestoreTransactionMode` API:

- `single`: one transaction; forbidden operations fail preflight;
- `section`: transaction segments inside logical sections, with forbidden
  operations outside them;
- `entry`: a transaction around each suitable entry;
- `none`: no automatic transaction; required operations fail preflight.

The planner never puts forbidden SQL inside a transaction. Failure or
cancellation rolls back an active transaction before release and archive close.

## Errors, diagnostics, progress, and results

`PostgresRestoreError` has stable specialized codes for archive, target,
planning, SQL, COPY, transaction, cancellation, unsupported objects,
privileges, mappings, and validation. SQL errors reserve SQLSTATE, server
detail/hint/position, object fields, step/archive IDs, and a redacted truncated
SQL preview. Secrets, full connection strings, and raw table data are excluded.

Diagnostics have stable codes and info/warning/error/fatal severities.
Serializable progress covers lifecycle, phases, steps, diagnostics, failure,
and cancellation; data events reserve row, byte, total, and table fields.
Optional structured logging is disabled unless supplied and accepts safe
metadata only.

Results distinguish success, partial, failed, cancelled, and preflight-failed.
A partial restore is never success, and `partialStateMayRemain` reports whether
committed work may exist. Error mode defaults to stop; continue records failures
and skips dependent work.

## Mappings, secrets, validation, and cleanup

Roles, schemas, and tablespaces use distinct typed rules and results:
unchanged, mapped, omitted, or unresolved. Mappings belong in planning, never
unsafe SQL search-and-replace. Non-trivial mapped results currently fail
preflight until renderer-aware rewriting exists.

Restore options reuse the asynchronous sensitive-value policy. Resolved secrets
must eventually be supplied at execution time and never persisted in plans.
Trusted SQL marked sensitive currently fails preflight.

Validation levels reserve none, basic, structure, and structure-and-data. The
skeleton reports basic execution completion; object, row-count, sequence, and
checksum validators remain plan placeholders.

Cancellation is distinct from SQL failure. Cleanup order is query cancellation,
active transaction rollback, target release, archive close, and a cancelled
result.

## Public API

```ts
const engine = createRestoreEngine();

const report = await engine.preflight(request);
const plan = await engine.createPlan(request);
const result = await engine.restore(request);
```

Public archive, option, plan, diagnostic, progress, result, target-capability,
and error contracts are exported deliberately. Executor internals are not.

## Recommended next task

Implement native `COPY FROM STDIN` for COPY text:

1. add an explicit node-postgres adapter capability;
2. stream `RestoreArchiveSource.openData()` with backpressure;
3. integrate abort, rollback, rows/bytes, and checksums;
4. add bounded-memory and cross-version integration tests.
