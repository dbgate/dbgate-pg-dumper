/**
 * Public, read-only archive inspection use case.
 *
 * The result is suitable for tests and debugging. Invalid plans retain all
 * diagnostics but return no executable order.
 */

import type { PostgresDatabase } from '../model/PostgresDatabase.js';
import { DumpArchiveBuilder } from './ArchiveBuilder.js';
import { DumpArchiveDependencyGraph } from './DependencyGraph.js';
import { DumpArchiveSelector } from './ArchiveSelection.js';
import type { DumpArchiveInspection, InspectDumpArchiveOptions } from './ArchiveTypes.js';

export function inspectDumpArchive(
  database: PostgresDatabase,
  options: InspectDumpArchiveOptions = {},
): DumpArchiveInspection {
  const built = new DumpArchiveBuilder().build(database, options);
  const selected = new DumpArchiveSelector().select(built.entries, options.selection);
  const ordered = new DumpArchiveDependencyGraph().order(selected.entries);
  const diagnostics = [...built.diagnostics, ...selected.diagnostics, ...ordered.diagnostics];
  const valid = !diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  const entries = [...ordered.entries].sort((left, right) =>
    left.archiveIdentity.localeCompare(right.archiveIdentity),
  );
  return {
    valid,
    entries,
    orderedEntries: valid ? ordered.orderedEntries : [],
    orderedDumpIds: valid ? ordered.orderedEntries.map((entry) => entry.dumpId) : [],
    diagnostics,
  };
}
