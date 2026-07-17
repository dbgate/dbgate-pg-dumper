/**
 * Immutable execution plan produced after introspection.
 *
 * Separating discovery from execution allows dependency ordering and target
 * compatibility decisions to finish before the writer emits irreversible
 * output. This will also make plans straightforward to test in isolation.
 */

import type { DumpMode } from '../api/types.js';
import type { ArchiveEntry, DumpArchiveInspection } from '../archive/ArchiveTypes.js';
import type { PostgresDatabase } from './PostgresDatabase.js';
import { inspectDumpArchive } from '../archive/inspectDumpArchive.js';

/** Ordered description of objects and tables included in one dump operation. */
export interface DumpPlan {
  readonly mode: DumpMode;
  readonly archive: DumpArchiveInspection;
  readonly objects: readonly ArchiveEntry[];
  readonly dataObjects: readonly ArchiveEntry[];
}

/** Builds dependency-safe plans from normalized introspection results. */
export class DumpPlanner {
  createPlan(database: PostgresDatabase, mode: DumpMode = 'full'): DumpPlan {
    const archive = inspectDumpArchive(database, { selection: { mode } });
    return {
      mode,
      archive,
      objects: archive.orderedEntries,
      dataObjects: archive.orderedEntries.filter((entry) => entry.section === 'data'),
    };
  }
}
