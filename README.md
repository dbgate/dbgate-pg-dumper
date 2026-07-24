# dbgate-pg-dumper

`dbgate-pg-dumper` is a standalone, framework-independent PostgreSQL SQL dump
generator for Node.js applications.

The package implements connection/session management, normalized catalog
introspection, deterministic archive planning, streaming plain-SQL schema
rendering, COPY/INSERT table data, and exact sequence-state restoration.

## Design goals

- No dependency on DbGate internals or on a specific PostgreSQL client.
- Streaming-friendly APIs for exporting tables that do not fit in memory.
- Separate introspection, compatibility, rendering, data, warning, and writer
  responsibilities.
- Support for schema-only, data-only, `COPY`, and `INSERT` dumps.
- Explicit source and target PostgreSQL version handling.
- Abort signals and structured progress reporting.

## Installation

```sh
npm install dbgate-pg-dumper
```

Node.js 20 or newer is required.

## Public API

```ts
import { createWriteStream } from 'node:fs';
import { dumpPostgres, type PostgresConnection } from 'dbgate-pg-dumper';

const connection: PostgresConnection = {
  async query(request) {
    // Adapt request to the PostgreSQL client used by your application.
    throw new Error('Example only');
  },
  stream(request) {
    // Return rows lazily from your PostgreSQL client.
    throw new Error('Example only');
  },
  async getTransactionStatus() {
    return 'idle';
  },
};

await dumpPostgres(
  connection,
  {
    mode: 'full',
    dataFormat: 'copy',
    unsupportedFeaturePolicy: 'error',
  },
  createWriteStream('database.sql'),
  (progress) => console.log(progress.message),
);
```

`dumpPostgres()` introspects on one consistent source session, orders the dump
archive, and streams SQL to the supplied writable. The library neither closes
the caller's connection nor ends the output stream.

## Initial introspection

The implemented `introspectPostgres()` API can already inspect the normalized
database model:

```ts
import { Pool } from 'pg';
import { introspectPostgres } from 'dbgate-pg-dumper';
import { fromPgPool } from 'dbgate-pg-dumper/pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const result = await introspectPostgres(fromPgPool(pool), {
  transactionMode: 'managed',
  selection: {
    includeSchemas: ['public', 'application'],
    excludeTables: ['application.audit_log'],
  },
});

console.log(result.metadata.source.version.complete);
console.log(result.database.schemas);
console.log(result.database.constraints);
console.log(result.database.functions);
console.log(result.database.accessControls);
console.log(result.diagnostics);
await pool.end();
```

The normalized model can be converted into a deterministic, read-only dump
archive without rendering SQL:

```ts
import { inspectDumpArchive } from 'dbgate-pg-dumper';

const archive = inspectDumpArchive(result.database, {
  selection: {
    mode: 'schema-only',
    includeSchemas: ['application'],
    includeDependencies: true,
  },
});

console.log(archive.valid);
console.log(archive.orderedEntries);
console.log(archive.diagnostics);
```

Archive entries expose stable dump IDs, pre-data/data/post-data sections,
dependency strengths, selection reasons, data-export descriptors, and detailed
cycle diagnostics. `renderPlainSql()` can also render an inspected archive
directly.

The `pg` adapter supports connected `pg.Client` instances, acquired
`pg.PoolClient` instances, and `pg.Pool`. Pool usage acquires one physical
client for the complete operation.

See [Architecture](docs/architecture.md) for lifecycle and consistency details,
and [Plain SQL rendering](docs/plain-sql.md) for object and compatibility
coverage. The format-neutral row pipeline is documented in
[Data Export Engine](docs/data-export.md), including data modes and fidelity.
Advanced object behavior, security defaults, preflight, and current limitations
are documented in [Advanced PostgreSQL objects](docs/advanced-objects.md).
The dump → restore → dump strategy, exact and semantic comparison policies,
fixed-point checks, version matrix, and CI failure artifacts are documented in
[Round-trip testing](docs/round-trip-testing.md).

## Development

```sh
npm install
npm run lint
npm run build
npm test
```

The repository also contains a separate Docker-backed PostgreSQL 9.6, 13, and
18 integration suite; ordinary `npm test` runs remain Docker-free.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
