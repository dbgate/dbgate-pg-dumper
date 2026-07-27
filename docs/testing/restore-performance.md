# Native restore performance and stress testing

This suite measures the real native path:

```text
deterministic streaming archive source
-> PostgreSQLRestoreEngine
-> native COPY FROM STDIN
-> PostgreSQL
```

It does not invoke `psql`, `pg_restore`, or `pg_dump`. Correctness stress tests
and non-gating benchmarks are deliberately separate.

## Current implementation audit

The COPY payload path is streaming. `CopyTextLoader` connects the archive
`Readable`, an optional bounded three-byte psql-marker tail transform, a
streaming SHA-256/row/byte monitor, and the PostgreSQL COPY writable with
Node's `pipeline()`. Backpressure propagates through that chain. The checksum
hash is updated incrementally and payload bytes are not concatenated.

Buffering found during the audit:

- `PsqlEndMarkerStripper` uses `Buffer.concat`, but retains only the three-byte
  terminator tail plus the current chunk.
- Passing a string or `Uint8Array` to `InMemoryRestoreArchiveSource` necessarily
  retains that whole value. Stress workloads use its lazy `() => Readable`
  form instead.
- Restore preflight and planning collect all archive entry metadata into
  arrays and maps. Memory therefore scales with object count, but not table
  payload size.
- Canonical post-restore validation streams query rows serially and hashes each
  canonical row. It does not retain the complete result.
- The older psql-based round-trip harness uses `Buffer.concat`; it is not part
  of native restore and is excluded from these measurements.
- A fast local source can finish writing into Node/kernel/PostgreSQL socket
  buffers before a server-side COPY conversion error arrives. The controlled
  slow-source error test proves cancellation of unread input, but the amount
  already handed to the network is transport-dependent.

The audit found that progress was emitted once per source chunk. That could
make tiny-chunk sources callback-bound. COPY progress is now aggregated at
one-megabyte or 250-millisecond intervals, with exact first and final events.

## Workload profiles

| Profile          | Default rows | Intended use                                      |
| ---------------- | ------------ | ------------------------------------------------- |
| `smoke`          | 10,000       | Local development and pull-request correctness    |
| `ci`             | 250,000      | Constrained-heap and stable CI resource checks    |
| `large`          | 1,000,000    | Dedicated performance jobs                        |
| `stress`         | 5,000,000    | Opt-in resource and soak investigation            |
| `manual-extreme` | 10,000,000   | Explicit multi-gigabyte-capable manual generation |

`RESTORE_TEST_ROWS` overrides the row count. For `manual-extreme`,
`RESTORE_TEST_SIZE_GB` estimates a row count using a conservative 1 KiB per
row. The JSON result always reports the actual logical byte count.

Shapes are `narrow`, `wide`, `mixed`, `highly-nullable`, and `large-values`.
The deterministic generator includes bigint, integer, numeric, boolean, short
and long text, nullable text, UUID, timestamp, timestamptz, JSONB, bytea, and a
text array. Edge rows include NULL, empty strings, Unicode, emoji, tabs,
newlines, backslashes, variable widths, and configurable multi-megabyte
values. It aggregates rows only up to a configurable chunk boundary.

## Commands

Start PostgreSQL first:

```cmd
docker compose -f docker-compose.integration.yml up -d --wait
```

For PostgreSQL 18 in Windows CMD:

```cmd
set "PG_TEST_URL=postgresql://dumper:dumper@127.0.0.1:55118/dumper_test"
npm run test:restore-stress:smoke
npm run test:restore-stress:heap
npm run benchmark:restore
```

PostgreSQL 9.6 uses port `55496`; PostgreSQL 13 uses `55113`.

Larger benchmarks:

```cmd
npm run benchmark:restore:large
```

Manual extreme run:

```cmd
set "RUN_EXTREME_RESTORE_TESTS=1"
set "RESTORE_TEST_SIZE_GB=5"
set "RESTORE_BENCHMARK_WARMUPS=0"
set "RESTORE_BENCHMARK_RUNS=1"
npm run benchmark:restore:extreme
```

No fixed large fixture is committed. Keep the target's free disk space in
mind: PostgreSQL table and index storage can exceed logical COPY bytes.

## Configuration

- `RESTORE_STRESS_PROFILE`
- `RESTORE_STRESS_SHAPE`
- `RESTORE_TEST_ROWS`
- `RESTORE_TEST_SEED`
- `RESTORE_TEST_CHUNK_BYTES`
- `RESTORE_TEST_SOURCE_DELAY_MS`
- `RESTORE_TEST_LARGE_VALUE_BYTES`
- `RESTORE_TEST_MAX_RSS_BYTES` (default 256 MiB correctness bound)
- `RESTORE_TEST_MAX_CANCEL_MS` (default 5 seconds)
- `RESTORE_TEST_HEAP_MB` (default 256 MiB)
- `RESTORE_BENCHMARK_WARMUPS` (default 1)
- `RESTORE_BENCHMARK_RUNS` (default 3, extreme default 1)
- `RESTORE_BENCHMARK_VALIDATION_LEVELS` (default `none,basic`)
- `RESTORE_BENCHMARK_OUTPUT_DIR`
- `RESTORE_BENCHMARK_BASELINE_DIR`
- `RESTORE_BENCHMARK_SAVE_BASELINE=1`
- `RESTORE_BENCHMARK_WARN_PERCENT` (default 20)
- `RESTORE_BENCHMARK_MEMORY_PERCENT` (default 50)
- `RESTORE_BENCHMARK_ENFORCE=1` only on a stable dedicated runner

Memory sampling is periodic and records RSS, heap, external, and array-buffer
memory with phase labels. It does not force GC during restore. The JSON result
records whether explicit GC was available.

## Correctness and resource thresholds

The stress suite verifies exact total/distinct counts, deterministic sample
values, post-data keys/indexes, bounded source buffers, archive/stream cleanup,
idle reusable sessions, rollback after cancellation and invalid COPY data,
many-small-table planning, and all four transaction modes.

The RSS bound is intentionally generous across Node and operating-system
versions. The stronger accidental-full-buffering guard runs 100,000 rows
(about 46 MiB for the mixed workload) in a separate Node process with a 256 MiB
old-space limit. Source readable buffering is bounded relative to configured
chunk size.

Cancellation is triggered by a deterministic byte-progress offset, not a
sleep. Cleanup must complete within five seconds unless explicitly configured
otherwise.

Throughput changes warn by default. They fail only when
`RESTORE_BENCHMARK_ENFORCE=1`. Memory regression failures remain separate from
timing noise. Baseline keys contain Node major, PostgreSQL major, OS family,
profile, row shape, archive source, and row count. Do not compare laptop and CI
runner baselines.

## JSON artifacts and interpretation

Results are written below `test-output/restore-performance`. Each artifact
contains every measured run and a median, including environment identity,
logical bytes, phase durations, rows/s, MiB/s, memory peaks, validation and
transaction modes, source type, progress event count, and status.

COPY and archive-read durations currently cover the same streaming interval;
the in-memory source has no independent I/O timing boundary. Validation
duration is derived as non-COPY restore time and includes planning/finalization,
so it is not a pure validator-only CPU measurement.

The suite supports warm-ups and repeated runs. PostgreSQL cache effects are
therefore present and are part of the recorded environment.

## Measurements from the implementation run

These numbers were produced on 2026-07-27 on the local Windows/Docker
environment with Node 20 and PostgreSQL 18.4. They are evidence for this
environment only.

| Workload                      | Rows    | Logical payload | COPY time | Throughput    | Peak RSS increase |
| ----------------------------- | ------- | --------------- | --------- | ------------- | ----------------- |
| mixed smoke, validation none  | 10,000  | 4.53 MiB        | 0.12 s    | 86,957 rows/s | 1.54 MiB          |
| mixed smoke, validation basic | 10,000  | 4.53 MiB        | 0.18 s    | 55,866 rows/s | 1.04 MiB          |
| mixed, validation none        | 100,000 | 45.95 MiB       | 1.69 s    | 59,207 rows/s | 32.93 MiB         |

The 100,000-row workload also completed under a 256 MiB Node old-space limit.
This verifies bounded behavior for the tested 45.95 MiB payload; it is not a
claim of constant memory or multi-gigabyte validation.

Deterministic cancellation after at least 2 MiB of COPY progress completed
rollback and cleanup in 15.1 ms on PostgreSQL 18 and 15.6 ms on PostgreSQL 9.6
in the same local environment. The CI safety bound remains five seconds.

## CI organization

- Pull requests and pushes run smoke correctness on PostgreSQL 9.6 and 18.
- PostgreSQL 18 additionally runs the isolated constrained-heap CI profile.
- Pushes run the non-gating PostgreSQL 18 benchmark and upload JSON artifacts.
- Large and extreme profiles remain explicit manual commands.

No timing threshold gates pull requests. Correctness, memory safety, and
cancellation latency do.

## Unsupported or blocked measurements

- Persistent directory archives, archive file handles, selective payload
  opening, corruption-at-offset tests, stored bytes, slow disk, and direct
  stream versus persistent archive overhead are blocked because persistent
  archive support does not exist.
- Internal restore parallelism is not implemented; concurrency comparisons are
  not applicable.
- The engine always calculates streaming payload SHA-256, so a genuine
  checksum-disabled COPY comparison is unavailable without changing product
  integrity semantics.
- Automatic retry, resume, compression, encryption, and cloud storage are
  outside scope.
- Docker CPU/memory controls may be applied externally, but this repository
  does not claim results are comparable unless those settings are recorded by
  the caller.

## Remaining risks and next task

The suite does not yet prove multi-gigabyte behavior, backend restart handling,
pool saturation, multi-process concurrent restores, file-descriptor bounds, or
long-duration soak stability. Fast producers may hand substantial data to
transport buffers before a server error is observed.

After persistent archives exist, the next task should implement resumable
restore checkpoints and retry-safe execution without weakening transaction
semantics or allowing duplicate data.
