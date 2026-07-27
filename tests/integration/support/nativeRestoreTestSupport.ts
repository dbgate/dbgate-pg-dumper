import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import {
  quoteIdentifier,
  quoteQualifiedIdentifier,
  RESTORE_ARCHIVE_FORMAT,
  RESTORE_ARCHIVE_FORMAT_VERSION,
  type PostgresVersion,
  type RestoreArchiveMetadata,
  type RestoreResult,
} from '../../../src/index.js';
import { fromPgClient } from '../../../src/pg.js';

export const nativeRestoreUrl =
  process.env.PG_TEST_URL ??
  process.env.PG18_URL ??
  'postgresql://dumper:dumper@127.0.0.1:55118/dumper_test';

function parseVersion(number: number): PostgresVersion {
  const major = Math.trunc(number / 10000);
  return {
    complete: `PostgreSQL ${String(major)}`,
    number,
    normalizedMajor: String(major),
    major,
    minor: 0,
    patch: 0,
  };
}

export function restoreFailureContext(result: RestoreResult): string {
  return JSON.stringify(
    {
      status: result.status,
      failedStepCount: result.failedStepCount,
      skippedStepCount: result.skippedStepCount,
      diagnostics: result.diagnostics,
    },
    null,
    2,
  );
}

export class NativeRestoreFixture {
  readonly schema: string;
  readonly client: Client;
  readonly target;
  readonly version: PostgresVersion;

  private constructor(client: Client, schema: string, version: PostgresVersion) {
    this.client = client;
    this.schema = schema;
    this.version = version;
    this.target = fromPgClient(client);
  }

  static async create(prefix: string): Promise<NativeRestoreFixture> {
    const client = new Client({ connectionString: nativeRestoreUrl });
    await client.connect();
    const version = await client.query<{ version_number: string }>(
      `SELECT pg_catalog.current_setting('server_version_num') AS version_number`,
    );
    const number = Number(version.rows[0]?.version_number ?? '0');
    return new NativeRestoreFixture(
      client,
      `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      parseVersion(number),
    );
  }

  metadata(suffix: string): RestoreArchiveMetadata {
    return {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: `${suffix}-${this.schema}`,
      sourceVersion: this.version,
      requiredExtensions: [],
      requiredRoles: [],
      requiredPrivileges: [],
      requiredTablespaces: [],
      transactionCompatibility: 'compatible',
      diagnostics: [],
    };
  }

  qualified(name: string): string {
    return quoteQualifiedIdentifier([this.schema, name]);
  }

  async relationExists(name: string): Promise<boolean> {
    const result = await this.client.query<{ exists: boolean }>(
      `SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists`,
      [`${quoteIdentifier(this.schema)}.${quoteIdentifier(name)}`],
    );
    return result.rows[0]?.exists === true;
  }

  async sequenceState(
    name: string,
  ): Promise<{ readonly last_value: string; readonly is_called: boolean } | undefined> {
    const result = await this.client.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text AS last_value, is_called FROM ${this.qualified(name)}`,
    );
    return result.rows[0];
  }

  async indexDefinitions(table: string): Promise<readonly string[]> {
    const result = await this.client.query<{ definition: string }>(
      `
        SELECT pg_catalog.pg_get_indexdef(index_class.oid) AS definition
        FROM pg_catalog.pg_index AS index_metadata
        JOIN pg_catalog.pg_class AS table_class ON table_class.oid = index_metadata.indrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
        JOIN pg_catalog.pg_class AS index_class ON index_class.oid = index_metadata.indexrelid
        WHERE namespace.nspname = $1 AND table_class.relname = $2
        ORDER BY index_class.relname
      `,
      [this.schema, table],
    );
    return result.rows.map((row) => row.definition);
  }

  async close(): Promise<void> {
    try {
      await this.client.query(`ROLLBACK`).catch(() => undefined);
      await this.client.query(`RESET ROLE`).catch(() => undefined);
      await this.client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(this.schema)} CASCADE`);
    } finally {
      await this.client.end();
    }
  }
}
