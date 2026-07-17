/**
 * Streams table contents into a selected SQL data representation.
 *
 * This layer will construct ordered row queries, consume the connection's
 * `AsyncIterable`, and encode rows as `COPY` or batched `INSERT` input without
 * retaining an entire table in memory.
 */

import type { DataExportFormat } from '../api/types.js';
import type { PostgresConnection } from '../connection/PostgresConnection.js';
import type { DatabaseObject } from '../model/DatabaseObject.js';
import type { DumpWriter } from '../writer/DumpWriter.js';

/** Data-export settings resolved from the public options and table metadata. */
export interface TableDataExportOptions {
  readonly format: DataExportFormat;
  readonly rowsPerInsert: number;
}

/** Boundary for exporting one table through bounded-memory streaming. */
export interface TableDataExporter {
  exportTable(
    connection: PostgresConnection,
    table: DatabaseObject,
    writer: DumpWriter,
    options: TableDataExportOptions,
    signal?: AbortSignal,
  ): Promise<number>;
}

/** Default table data exporter placeholder. */
export class StreamingTableDataExporter implements TableDataExporter {
  /** TODO: Implement COPY and INSERT encoders over connection.stream(). */
  async exportTable(
    _connection: PostgresConnection,
    _table: DatabaseObject,
    _writer: DumpWriter,
    _options: TableDataExportOptions,
    _signal?: AbortSignal,
  ): Promise<number> {
    return Promise.reject(new Error('TODO: implement streaming table data export'));
  }
}
