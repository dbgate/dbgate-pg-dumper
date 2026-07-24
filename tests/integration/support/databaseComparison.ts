import { createHash } from 'node:crypto';
import type { Client } from 'pg';

import type { PostgresDatabase, PostgresTable } from '../../../src/index.js';
import type { ComparisonDifference } from './modelComparison.js';

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableIdentity(table: PostgresTable): string {
  return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
}

function stableKey(database: PostgresDatabase, table: PostgresTable): readonly string[] {
  const primary = database.constraints.find(
    (item) =>
      item.kind === 'primary-key' &&
      item.table.schema === table.schema &&
      item.table.name === table.name,
  );
  if (primary?.kind === 'primary-key') {
    return primary.columns.map((column) => column.subName ?? column.name);
  }
  const unique = database.constraints.find(
    (item) =>
      item.kind === 'unique' &&
      item.table.schema === table.schema &&
      item.table.name === table.name &&
      item.columns.every((column) => {
        const name = column.subName ?? column.name;
        return table.columns.some(
          (tableColumn) => tableColumn.name === name && !tableColumn.nullable,
        );
      }),
  );
  return unique?.kind === 'unique'
    ? unique.columns.map((column) => column.subName ?? column.name)
    : [];
}

function columnExpression(name: string, formattedType: string): string {
  const column = quoteIdentifier(name);
  if (formattedType === 'json' || formattedType === 'jsonb') return `${column}::jsonb::text`;
  if (formattedType === 'bytea') return `pg_catalog.encode(${column}, 'hex')`;
  return `${column}::text`;
}

async function readRows(
  client: Client,
  database: PostgresDatabase,
  table: PostgresTable,
): Promise<readonly string[]> {
  const expressions = table.columns.map((column) =>
    column.generatedExpression === undefined
      ? columnExpression(column.name, column.formattedType)
      : columnExpression(column.name, column.formattedType),
  );
  const keys = stableKey(database, table);
  const orderBy =
    keys.length === 0 ? '' : ` ORDER BY ${keys.map((key) => quoteIdentifier(key)).join(', ')}`;
  const result = await client.query<{ row_value: unknown }>(
    `SELECT pg_catalog.json_build_array(${expressions.join(', ')}) AS row_value FROM ${tableIdentity(table)}${orderBy}`,
  );
  const rows = result.rows.map((row) => JSON.stringify(row.row_value));
  return keys.length === 0 ? rows.sort() : rows;
}

export async function compareTableData(
  sourceClient: Client,
  restoredClient: Client,
  source: PostgresDatabase,
  restored: PostgresDatabase,
): Promise<readonly ComparisonDifference[]> {
  const differences: ComparisonDifference[] = [];
  for (const sourceSchema of source.schemas) {
    for (const sourceTable of sourceSchema.tables.filter(
      (table) => table.kind !== 'partitioned' && table.kind !== 'foreign',
    )) {
      const restoredTable = restored.schemas
        .find((schema) => schema.name === sourceSchema.name)
        ?.tables.find((table) => table.name === sourceTable.name);
      if (restoredTable === undefined) continue;
      const [sourceRows, restoredRows] = await Promise.all([
        readRows(sourceClient, source, sourceTable),
        readRows(restoredClient, restored, restoredTable),
      ]);
      if (JSON.stringify(sourceRows) !== JSON.stringify(restoredRows)) {
        differences.push({
          objectIdentity: `${sourceSchema.name}.${sourceTable.name}`,
          propertyPath: 'data.rows',
          sourceValue: sourceRows,
          restoredValue: restoredRows,
          classification: 'semantic data difference',
        });
      }
    }
  }
  return differences;
}

interface LargeObjectFingerprint {
  readonly oid: number;
  readonly owner: string;
  readonly acl: string | null;
  readonly comment: string | null;
  readonly size: string;
  readonly sha256: string;
}

async function largeObjectFingerprints(client: Client): Promise<readonly LargeObjectFingerprint[]> {
  const metadata = await client.query<{
    oid: number;
    owner: string;
    acl: string | null;
    comment: string | null;
  }>(`
    SELECT lom.oid, pg_catalog.pg_get_userbyid(lom.lomowner) AS owner,
           lom.lomacl::text AS acl, d.description AS comment
    FROM pg_catalog.pg_largeobject_metadata lom
    LEFT JOIN pg_catalog.pg_description d
      ON d.objoid = lom.oid AND d.classoid = 'pg_catalog.pg_largeobject'::pg_catalog.regclass
    ORDER BY lom.oid
  `);
  const output: LargeObjectFingerprint[] = [];
  for (const object of metadata.rows) {
    const hash = createHash('sha256');
    let size = 0;
    let lastPage = -1;
    while (true) {
      const pages = await client.query<{ pageno: number; data: Buffer }>(
        `SELECT pageno, data
         FROM pg_catalog.pg_largeobject
         WHERE loid = $1 AND pageno > $2
         ORDER BY pageno
         LIMIT 128`,
        [object.oid, lastPage],
      );
      for (const page of pages.rows) {
        hash.update(page.data);
        size += page.data.length;
        lastPage = page.pageno;
      }
      if (pages.rows.length < 128) break;
    }
    output.push({ ...object, size: String(size), sha256: hash.digest('hex') });
  }
  return output;
}

export async function compareLargeObjects(
  source: Client,
  restored: Client,
): Promise<readonly ComparisonDifference[]> {
  const [sourceObjects, restoredObjects] = await Promise.all([
    largeObjectFingerprints(source),
    largeObjectFingerprints(restored),
  ]);
  return JSON.stringify(sourceObjects) === JSON.stringify(restoredObjects)
    ? []
    : [
        {
          objectIdentity: 'large objects',
          propertyPath: 'largeObjects',
          sourceValue: sourceObjects,
          restoredValue: restoredObjects,
          classification: 'semantic data difference',
        },
      ];
}
