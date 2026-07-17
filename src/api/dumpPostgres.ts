/**
 * Public use-case entry point.
 *
 * This module owns validation and delegation only. It must never accumulate SQL
 * rendering or catalog-query logic; those concerns belong to dedicated layers.
 */

import type { Writable } from 'node:stream';

import type { PostgresConnectionInput } from '../connection/PostgresConnection.js';
import { DumpOrchestrator } from '../model/DumpOrchestrator.js';
import type { DumpOptions, DumpProgressCallback, DumpResult } from './types.js';

/**
 * Produces a PostgreSQL SQL dump in the supplied writable stream.
 *
 * The function is client-agnostic and does not own the connection or output
 * stream. Callers remain responsible for creating, configuring, and closing
 * both resources. Cancellation is cooperative through `AbortSignal`.
 */
export async function dumpPostgres(
  connection: PostgresConnectionInput,
  options: DumpOptions,
  output: Writable,
  onProgress?: DumpProgressCallback,
  signal?: AbortSignal,
): Promise<DumpResult> {
  const orchestrator = new DumpOrchestrator();
  return orchestrator.dump({ connection, options, output, onProgress, signal });
}
