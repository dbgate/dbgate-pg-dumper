/**
 * Bounded table-row cursors.
 *
 * Adapter cursors delegate lifecycle to `PostgresConnection.stream`. The SQL
 * fallback declares a NO SCROLL cursor and guarantees CLOSE in `finally`.
 */

import type { PostgresConnection, PostgresRow } from '../connection/PostgresConnection.js';
import { quoteIdentifier, quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import type { PlannedTableExport } from './DataExportTypes.js';

let cursorSequence = 0;

function selectSql(table: PlannedTableExport): string {
  /*
   * PostgreSQL's type output functions are the fidelity boundary. Casting each
   * value to pg_catalog.text preserves exact bigint/numeric values and the
   * canonical syntax of temporal, bytea, array, composite, range, JSON, domain,
   * enum, network, bit-string, money, and geometric values. NULL remains NULL.
   * Aliasing restores the adapter row key expected by the normalized batch.
   */
  const columns = table.descriptor.columns
    .map((column) => `(${column.quotedName})::pg_catalog.text AS ${column.quotedName}`)
    .join(', ');
  const relation = quoteQualifiedIdentifier([table.descriptor.schema, table.descriptor.name]);
  return `SELECT ${columns} FROM ONLY ${relation}`;
}

export async function* streamTableRows(
  connection: PostgresConnection,
  table: PlannedTableExport,
  signal?: AbortSignal,
): AsyncGenerator<PostgresRow> {
  if (table.strategy === 'adapter-cursor' && connection.stream !== undefined) {
    const rows = connection.stream<PostgresRow>(
      { text: selectSql(table) },
      { batchSize: table.fetchSize, ...(signal === undefined ? {} : { signal }) },
    );
    for await (const row of rows) yield row;
    return;
  }

  cursorSequence += 1;
  const cursorName = `dbgate_data_${cursorSequence}`;
  const quotedCursor = quoteIdentifier(cursorName, { quoteAllIdentifiers: true });
  let declared = false;
  let cleanupFailure: unknown;
  try {
    await connection.query(
      {
        text: `DECLARE ${quotedCursor} NO SCROLL CURSOR FOR ${selectSql(table)}`,
      },
      signal,
    );
    declared = true;
    while (true) {
      signal?.throwIfAborted();
      const result = await connection.query<PostgresRow>(
        { text: `FETCH FORWARD ${table.fetchSize} FROM ${quotedCursor}` },
        signal,
      );
      for (const row of result.rows) yield row;
      if (result.rows.length < table.fetchSize) break;
    }
  } finally {
    if (declared) {
      try {
        await connection.query({ text: `CLOSE ${quotedCursor}` });
      } catch (cause) {
        // A rollback closes every cursor. Otherwise cleanup failure is material
        // and must reach the engine's cursor diagnostic.
        const status = await connection.getTransactionStatus();
        if (status === 'in-transaction') cleanupFailure = cause;
      }
    }
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure instanceof Error
      ? cleanupFailure
      : new Error('Failed to close the PostgreSQL data cursor.', { cause: cleanupFailure });
  }
}
