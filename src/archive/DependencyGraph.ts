/**
 * Dependency validation, preference-cycle resolution, and stable sorting.
 *
 * Hard edges are never removed. Preference edges inside strongly connected
 * components may be dropped, after which Kahn's algorithm performs a stable
 * topological sort using centralized section and object priorities.
 */

import type { ArchiveCycleEdge, ArchiveDiagnostic, ArchiveEntry } from './ArchiveTypes.js';
import { archiveObjectPriority, dumpSectionPriority } from './SectionRules.js';

export interface ArchiveGraphResult {
  readonly entries: readonly ArchiveEntry[];
  readonly orderedEntries: readonly ArchiveEntry[];
  readonly diagnostics: readonly ArchiveDiagnostic[];
}

export class DumpArchiveDependencyGraph {
  order(sourceEntries: readonly ArchiveEntry[]): ArchiveGraphResult {
    const diagnostics: ArchiveDiagnostic[] = [];
    const selectedEntries = sourceEntries.filter((entry) => entry.selection.selected);
    const selectedIds = new Set(selectedEntries.map((entry) => entry.dumpId));
    const entries = new Map(selectedEntries.map((entry) => [entry.dumpId, entry]));
    const dependencies = new Map(
      selectedEntries.map((entry) => [
        entry.dumpId,
        entry.dependencies.filter((dependency) => selectedIds.has(dependency.dumpId)),
      ]),
    );

    for (const entry of selectedEntries) {
      for (const dependency of dependencies.get(entry.dumpId) ?? []) {
        const target = entries.get(dependency.dumpId);
        if (
          target !== undefined &&
          dumpSectionPriority(entry.section) < dumpSectionPriority(target.section)
        ) {
          diagnostics.push({
            code: 'invalid-section-dependency',
            severity: 'error',
            message: 'An earlier dump section depends on an entry from a later section.',
            dumpId: entry.dumpId,
            relatedDumpIds: [target.dumpId],
            identity: entry.archiveIdentity,
          });
        }
      }
    }

    let components = this.stronglyConnectedComponents(entries, dependencies);
    for (const component of components.filter((item) =>
      this.isCyclicComponent(item, dependencies),
    )) {
      const componentIds = new Set(component);
      for (const from of component) {
        const remaining = (dependencies.get(from) ?? []).filter((dependency) => {
          if (dependency.strength !== 'preference' || !componentIds.has(dependency.dumpId)) {
            return true;
          }
          diagnostics.push({
            code: 'dropped-ordering-preference',
            severity: 'warning',
            message: 'An ordering preference was dropped to resolve a dependency cycle.',
            dumpId: from,
            relatedDumpIds: [dependency.dumpId],
            ...(entries.get(from) === undefined
              ? {}
              : { identity: entries.get(from)!.archiveIdentity }),
          });
          return false;
        });
        dependencies.set(from, remaining);
      }
    }

    components = this.stronglyConnectedComponents(entries, dependencies);
    for (const component of components.filter((item) =>
      this.isCyclicComponent(item, dependencies),
    )) {
      const componentIds = new Set(component);
      const cycleEdges: ArchiveCycleEdge[] = [];
      for (const from of component) {
        for (const dependency of dependencies.get(from) ?? []) {
          if (componentIds.has(dependency.dumpId)) {
            cycleEdges.push({
              fromDumpId: from,
              toDumpId: dependency.dumpId,
              strength: dependency.strength,
              source: dependency.source,
            });
          }
        }
      }
      diagnostics.push({
        code: 'dependency-cycle',
        severity: 'error',
        message: 'A hard archive dependency cycle cannot be resolved safely.',
        relatedDumpIds: [...component].sort(),
        cycleMembers: component
          .map((dumpId) => entries.get(dumpId)!)
          .sort(this.compareEntries)
          .map((entry) => ({
            dumpId: entry.dumpId,
            identity: entry.archiveIdentity,
            objectType: entry.objectType,
          })),
        cycleEdges: cycleEdges.sort((left, right) => {
          const from = left.fromDumpId.localeCompare(right.fromDumpId);
          return from !== 0 ? from : left.toDumpId.localeCompare(right.toDumpId);
        }),
      });
    }

    const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
    const orderedEntries = hasErrors ? [] : this.topologicalSort(entries, dependencies);
    const updatedEntries = sourceEntries.map((entry) => {
      const retained = dependencies.get(entry.dumpId);
      if (retained === undefined) return entry;
      return {
        ...entry,
        dependencies: retained,
        dependencyDumpIds: [...new Set(retained.map((dependency) => dependency.dumpId))].sort(),
      };
    });
    const updatedLookup = new Map(updatedEntries.map((entry) => [entry.dumpId, entry]));

    return {
      entries: updatedEntries,
      orderedEntries: orderedEntries.map((entry) => updatedLookup.get(entry.dumpId)!),
      diagnostics,
    };
  }

  private topologicalSort(
    entries: ReadonlyMap<string, ArchiveEntry>,
    dependencies: ReadonlyMap<string, readonly ArchiveEntry['dependencies'][number][]>,
  ): readonly ArchiveEntry[] {
    const remainingDependencies = new Map<string, number>();
    const dependents = new Map<string, Set<string>>();
    for (const entry of entries.values()) {
      const values = dependencies.get(entry.dumpId) ?? [];
      remainingDependencies.set(entry.dumpId, values.length);
      for (const dependency of values) {
        const valuesForDependency = dependents.get(dependency.dumpId) ?? new Set<string>();
        valuesForDependency.add(entry.dumpId);
        dependents.set(dependency.dumpId, valuesForDependency);
      }
    }
    const available = [...entries.values()]
      .filter((entry) => remainingDependencies.get(entry.dumpId) === 0)
      .sort(this.compareEntries);
    const result: ArchiveEntry[] = [];
    while (available.length > 0) {
      const entry = available.shift()!;
      result.push(entry);
      for (const dependentId of dependents.get(entry.dumpId) ?? []) {
        const count = (remainingDependencies.get(dependentId) ?? 0) - 1;
        remainingDependencies.set(dependentId, count);
        if (count === 0) {
          available.push(entries.get(dependentId)!);
          available.sort(this.compareEntries);
        }
      }
    }
    return result;
  }

  private stronglyConnectedComponents(
    entries: ReadonlyMap<string, ArchiveEntry>,
    dependencies: ReadonlyMap<string, readonly ArchiveEntry['dependencies'][number][]>,
  ): readonly (readonly string[])[] {
    let nextIndex = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    const indexes = new Map<string, number>();
    const lowLinks = new Map<string, number>();
    const components: string[][] = [];

    const visit = (dumpId: string): void => {
      indexes.set(dumpId, nextIndex);
      lowLinks.set(dumpId, nextIndex);
      nextIndex += 1;
      stack.push(dumpId);
      onStack.add(dumpId);
      for (const dependency of dependencies.get(dumpId) ?? []) {
        if (!entries.has(dependency.dumpId)) continue;
        if (!indexes.has(dependency.dumpId)) {
          visit(dependency.dumpId);
          lowLinks.set(dumpId, Math.min(lowLinks.get(dumpId)!, lowLinks.get(dependency.dumpId)!));
        } else if (onStack.has(dependency.dumpId)) {
          lowLinks.set(dumpId, Math.min(lowLinks.get(dumpId)!, indexes.get(dependency.dumpId)!));
        }
      }
      if (lowLinks.get(dumpId) !== indexes.get(dumpId)) return;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== dumpId);
      components.push(component);
    };

    for (const dumpId of [...entries.keys()].sort()) {
      if (!indexes.has(dumpId)) visit(dumpId);
    }
    return components;
  }

  private isCyclicComponent(
    component: readonly string[],
    dependencies: ReadonlyMap<string, readonly ArchiveEntry['dependencies'][number][]>,
  ): boolean {
    if (component.length > 1) return true;
    const only = component[0];
    return (
      only !== undefined &&
      (dependencies.get(only) ?? []).some((dependency) => dependency.dumpId === only)
    );
  }

  private readonly compareEntries = (left: ArchiveEntry, right: ArchiveEntry): number => {
    const section = dumpSectionPriority(left.section) - dumpSectionPriority(right.section);
    if (section !== 0) return section;
    const type = archiveObjectPriority(left.objectType) - archiveObjectPriority(right.objectType);
    if (type !== 0) return type;
    const schema = (left.schema ?? '').localeCompare(right.schema ?? '');
    if (schema !== 0) return schema;
    const name = left.name.localeCompare(right.name);
    if (name !== 0) return name;
    const specific = left.specificIdentity.localeCompare(right.specificIdentity);
    return specific !== 0 ? specific : left.dumpId.localeCompare(right.dumpId);
  };
}
