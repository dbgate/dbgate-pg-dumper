/**
 * Compatibility-facing table export boundary.
 *
 * Serialization is intentionally absent. Consumers receive normalized batches
 * and can implement COPY, INSERT, CSV, JSON, or another sink independently.
 */

export { DataExportEngine as StreamingTableDataExporter } from './DataExportEngine.js';
export type {
  DataExportBatchConsumer,
  DataExportRequest as TableDataExportRequest,
} from './DataExportEngine.js';
