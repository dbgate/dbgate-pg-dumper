/**
 * Central warning aggregation for a dump execution.
 *
 * Services report structured, non-fatal conditions here. Central collection
 * enables de-duplication, progress notifications, and a complete result summary
 * without coupling low-level services to the public API callback.
 */

import type { DumpWarning } from '../api/types.js';

/** Collects warnings while exposing only immutable snapshots to callers. */
export class WarningCollector {
  readonly #warnings: DumpWarning[] = [];

  /** Records a warning in encounter order. TODO: add stable de-duplication rules. */
  add(warning: DumpWarning): void {
    this.#warnings.push(warning);
  }

  /** Returns an immutable snapshot that cannot mutate collector state. */
  getAll(): readonly DumpWarning[] {
    return [...this.#warnings];
  }
}
