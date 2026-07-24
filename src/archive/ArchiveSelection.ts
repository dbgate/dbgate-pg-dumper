/**
 * Archive-level selection and dependency closure.
 *
 * Explicit mode and section boundaries are hard filters. Schema/table filters
 * may be expanded through hard dependencies unless strict selection is enabled.
 */

import type {
  ArchiveDiagnostic,
  ArchiveEntry,
  ArchiveSelectionOptions,
  ArchiveSelectionReason,
  DumpSection,
} from './ArchiveTypes.js';

export interface ArchiveSelectionResult {
  readonly entries: readonly ArchiveEntry[];
  readonly diagnostics: readonly ArchiveDiagnostic[];
}

function normalize(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function tableName(
  entry: ArchiveEntry,
): { readonly schema?: string; readonly name: string } | undefined {
  if (entry.objectType === 'table' || entry.objectType === 'table-data') {
    return {
      name: entry.name,
      ...(entry.schema === undefined ? {} : { schema: entry.schema }),
    };
  }
  if (entry.parent?.kind === 'table' || entry.parent?.kind === 'column') {
    return {
      name: entry.parent.name,
      ...(entry.parent.schema === undefined ? {} : { schema: entry.parent.schema }),
    };
  }
  return undefined;
}

function matchesName(
  schema: string | undefined,
  name: string,
  candidates: readonly string[],
): boolean {
  return candidates.some((candidate) => {
    const separator = candidate.indexOf('.');
    return separator < 0
      ? candidate === name
      : candidate.slice(0, separator) === schema && candidate.slice(separator + 1) === name;
  });
}

function isDataSection(section: DumpSection): boolean {
  return section === 'data';
}

export class DumpArchiveSelector {
  select(
    sourceEntries: readonly ArchiveEntry[],
    options: ArchiveSelectionOptions = {},
  ): ArchiveSelectionResult {
    const diagnostics: ArchiveDiagnostic[] = [];
    const entries = new Map(sourceEntries.map((entry) => [entry.dumpId, entry]));
    const includeSchemas = normalize(options.includeSchemas);
    const excludeSchemas = normalize(options.excludeSchemas);
    const includeTables = normalize(options.includeTables);
    const excludeTables = normalize(options.excludeTables);
    const selectedSections = new Set(options.sections ?? []);
    const mode = options.mode ?? 'full';
    const includeDependencies = options.includeDependencies ?? true;
    const strictSelection = options.strictSelection ?? false;
    const selected = new Map<string, boolean>();
    const reasons = new Map<string, ArchiveSelectionReason>();
    const requiredBy = new Map<string, Set<string>>();

    const tableChildren = this.collectTableChildren(sourceEntries);
    const includedTableKeys = this.expandTableSelection(
      sourceEntries,
      includeTables,
      tableChildren,
      options.includeTableChildren ?? false,
    );
    const excludedTableKeys = this.expandTableSelection(
      sourceEntries,
      excludeTables,
      tableChildren,
      options.excludeTableChildren ?? false,
    );

    const hardExcluded = (entry: ArchiveEntry): ArchiveSelectionReason | undefined => {
      if (selectedSections.size > 0 && !selectedSections.has(entry.section)) {
        return 'section-excluded';
      }
      if (mode === 'schema-only' && isDataSection(entry.section)) return 'mode-excluded';
      if (mode === 'data-only' && !isDataSection(entry.section)) return 'mode-excluded';
      return undefined;
    };

    for (const entry of sourceEntries) {
      const hardReason = hardExcluded(entry);
      if (hardReason !== undefined) {
        selected.set(entry.dumpId, false);
        reasons.set(entry.dumpId, hardReason);
        continue;
      }
      if (
        (includeSchemas.length > 0 &&
          entry.schema !== undefined &&
          !includeSchemas.includes(entry.schema)) ||
        (entry.schema !== undefined && excludeSchemas.includes(entry.schema))
      ) {
        selected.set(entry.dumpId, false);
        reasons.set(entry.dumpId, 'filter-excluded');
        continue;
      }
      const table = tableName(entry);
      if (includeTables.length > 0) {
        if (table === undefined || !includedTableKeys.has(`${table.schema ?? ''}.${table.name}`)) {
          selected.set(entry.dumpId, false);
          reasons.set(entry.dumpId, 'filter-excluded');
          continue;
        }
      }
      if (table !== undefined && excludedTableKeys.has(`${table.schema ?? ''}.${table.name}`)) {
        selected.set(entry.dumpId, false);
        reasons.set(entry.dumpId, 'filter-excluded');
        continue;
      }
      selected.set(entry.dumpId, true);
      reasons.set(entry.dumpId, 'explicit');
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of sourceEntries) {
        if (!selected.get(entry.dumpId)) continue;
        for (const dependency of entry.dependencies) {
          if (dependency.strength !== 'hard' || selected.get(dependency.dumpId)) continue;
          const target = entries.get(dependency.dumpId);
          if (target === undefined) continue;
          const targetHardReason = hardExcluded(target);
          if (targetHardReason !== undefined) {
            this.addMissingDefinitionDiagnostic(entry, target, strictSelection, diagnostics);
            continue;
          }
          if (!includeDependencies || strictSelection) {
            if (strictSelection) {
              diagnostics.push({
                code: 'strict-selection-dependency',
                severity: 'error',
                message: 'Strict archive selection excluded a required dependency.',
                dumpId: entry.dumpId,
                relatedDumpIds: [dependency.dumpId],
                identity: entry.archiveIdentity,
              });
            }
            continue;
          }
          selected.set(dependency.dumpId, true);
          reasons.set(dependency.dumpId, 'dependency');
          const requesters = requiredBy.get(dependency.dumpId) ?? new Set<string>();
          requesters.add(entry.dumpId);
          requiredBy.set(dependency.dumpId, requesters);
          diagnostics.push({
            code: 'automatically-included-dependency',
            severity: 'warning',
            message:
              'A filtered archive entry was included because another selected entry requires it.',
            dumpId: dependency.dumpId,
            relatedDumpIds: [entry.dumpId],
            identity: target.archiveIdentity,
          });
          changed = true;
        }
      }
    }

    for (const entry of sourceEntries) {
      if (
        selected.get(entry.dumpId) &&
        entry.extensionMembership !== undefined &&
        selected.get(entry.extensionMembership.extensionDumpId) &&
        !entry.extensionMembership.emitIndependently
      ) {
        selected.set(entry.dumpId, false);
        reasons.set(entry.dumpId, 'extension-member-excluded');
        diagnostics.push({
          code: 'excluded-extension-member',
          severity: 'warning',
          message: 'An extension-owned object is represented by its selected extension entry.',
          dumpId: entry.dumpId,
          relatedDumpIds: [entry.extensionMembership.extensionDumpId],
          identity: entry.archiveIdentity,
        });
      }
    }

    return {
      entries: sourceEntries.map((entry) => ({
        ...entry,
        selection: {
          selected: selected.get(entry.dumpId) ?? false,
          reason: reasons.get(entry.dumpId) ?? 'filter-excluded',
          requiredByDumpIds: [...(requiredBy.get(entry.dumpId) ?? [])].sort(),
        },
      })),
      diagnostics,
    };
  }

  private collectTableChildren(
    entries: readonly ArchiveEntry[],
  ): ReadonlyMap<string, ReadonlySet<string>> {
    const result = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (entry.objectType !== 'table') continue;
      const table = entry.sourceObject as {
        readonly schema?: string;
        readonly name?: string;
        readonly parents?: readonly { readonly schema: string; readonly name: string }[];
      };
      const childKey = `${entry.schema ?? ''}.${entry.name}`;
      for (const parent of table.parents ?? []) {
        const parentKey = `${parent.schema}.${parent.name}`;
        const children = result.get(parentKey) ?? new Set<string>();
        children.add(childKey);
        result.set(parentKey, children);
      }
    }
    return result;
  }

  private expandTableSelection(
    entries: readonly ArchiveEntry[],
    values: readonly string[],
    children: ReadonlyMap<string, ReadonlySet<string>>,
    includeChildren: boolean,
  ): ReadonlySet<string> {
    const selected = new Set<string>();
    for (const entry of entries) {
      if (entry.objectType !== 'table') continue;
      if (matchesName(entry.schema, entry.name, values)) {
        selected.add(`${entry.schema ?? ''}.${entry.name}`);
      }
    }
    if (!includeChildren) return selected;
    const queue = [...selected];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const child of children.get(parent) ?? []) {
        if (selected.has(child)) continue;
        selected.add(child);
        queue.push(child);
      }
    }
    return selected;
  }

  private addMissingDefinitionDiagnostic(
    entry: ArchiveEntry,
    target: ArchiveEntry,
    strict: boolean,
    diagnostics: ArchiveDiagnostic[],
  ): void {
    const code =
      entry.objectType === 'materialized-view-data'
        ? 'materialized-view-data-without-definition'
        : entry.objectType === 'sequence-state'
          ? 'sequence-state-without-definition'
          : entry.objectType === 'table-data'
            ? 'selected-data-without-definition'
            : undefined;
    if (code === undefined) {
      if (strict) {
        diagnostics.push({
          code: 'strict-selection-dependency',
          severity: 'error',
          message: 'Strict section or mode selection excluded a required dependency.',
          dumpId: entry.dumpId,
          relatedDumpIds: [target.dumpId],
          identity: entry.archiveIdentity,
        });
      }
      return;
    }
    diagnostics.push({
      code,
      severity: strict ? 'error' : 'warning',
      message:
        'A selected data entry does not include its definition because of mode or section selection.',
      dumpId: entry.dumpId,
      relatedDumpIds: [target.dumpId],
      identity: entry.archiveIdentity,
    });
  }
}
