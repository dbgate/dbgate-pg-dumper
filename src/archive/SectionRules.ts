/**
 * Centralized dump-section and stable object-priority rules.
 *
 * The priorities are planning rules, not a claim of byte-for-byte pg_dump
 * ordering. Lower values sort first within a section.
 */

import type { ArchiveObjectType, DumpSection } from './ArchiveTypes.js';

const SECTIONS: Readonly<Record<DumpSection, number>> = {
  'pre-data': 0,
  data: 1,
  'post-data': 2,
};

const SECTION_BY_TYPE: Readonly<Record<ArchiveObjectType, DumpSection>> = {
  database: 'pre-data',
  extension: 'pre-data',
  schema: 'pre-data',
  enum: 'pre-data',
  domain: 'pre-data',
  sequence: 'pre-data',
  table: 'pre-data',
  column: 'pre-data',
  function: 'pre-data',
  procedure: 'pre-data',
  aggregate: 'pre-data',
  view: 'pre-data',
  'materialized-view': 'pre-data',
  'table-data': 'data',
  'materialized-view-data': 'data',
  'sequence-state': 'data',
  'sequence-ownership': 'post-data',
  constraint: 'post-data',
  'foreign-key': 'post-data',
  index: 'post-data',
  trigger: 'post-data',
  rule: 'post-data',
  policy: 'post-data',
  comment: 'post-data',
  ownership: 'post-data',
  acl: 'post-data',
  'default-privilege': 'post-data',
  'large-object': 'pre-data',
  'large-object-data': 'data',
  'large-object-metadata': 'post-data',
  'foreign-data-wrapper': 'pre-data',
  'foreign-server': 'pre-data',
  'user-mapping': 'pre-data',
  'text-search-parser': 'pre-data',
  'text-search-template': 'pre-data',
  'text-search-dictionary': 'pre-data',
  'text-search-configuration': 'pre-data',
  'composite-type': 'pre-data',
  'range-type': 'pre-data',
  'base-type': 'pre-data',
  cast: 'pre-data',
  transform: 'pre-data',
  operator: 'pre-data',
  'operator-family': 'pre-data',
  'operator-class': 'pre-data',
  conversion: 'pre-data',
  collation: 'pre-data',
  'event-trigger': 'post-data',
  'procedural-language': 'pre-data',
  publication: 'post-data',
  subscription: 'post-data',
  tablespace: 'pre-data',
  role: 'pre-data',
  'role-membership': 'pre-data',
  'security-label': 'post-data',
  statistics: 'post-data',
};

const PRIORITY_BY_TYPE: Readonly<Record<ArchiveObjectType, number>> = {
  database: 0,
  extension: 10,
  schema: 20,
  enum: 30,
  domain: 40,
  sequence: 50,
  function: 60,
  procedure: 65,
  aggregate: 70,
  table: 80,
  column: 90,
  view: 100,
  'materialized-view': 110,
  'table-data': 10,
  'materialized-view-data': 20,
  'sequence-state': 30,
  'sequence-ownership': 5,
  constraint: 10,
  index: 20,
  'foreign-key': 30,
  trigger: 40,
  rule: 50,
  policy: 60,
  ownership: 70,
  comment: 80,
  acl: 90,
  'default-privilege': 100,
  'large-object': 5,
  'large-object-data': 1,
  'large-object-metadata': 65,
  'foreign-data-wrapper': 15,
  'foreign-server': 16,
  'user-mapping': 17,
  'text-search-parser': 42,
  'text-search-template': 43,
  'text-search-dictionary': 44,
  'text-search-configuration': 45,
  'composite-type': 31,
  'range-type': 32,
  'base-type': 29,
  cast: 72,
  transform: 73,
  operator: 55,
  'operator-family': 56,
  'operator-class': 57,
  conversion: 46,
  collation: 25,
  'event-trigger': 110,
  'procedural-language': 12,
  publication: 105,
  subscription: 120,
  tablespace: 2,
  role: 1,
  'role-membership': 2,
  'security-label': 95,
  statistics: 25,
};

export function assignDumpSection(objectType: ArchiveObjectType): DumpSection {
  return SECTION_BY_TYPE[objectType];
}

export function dumpSectionPriority(section: DumpSection): number {
  return SECTIONS[section];
}

export function archiveObjectPriority(objectType: ArchiveObjectType): number {
  return PRIORITY_BY_TYPE[objectType];
}
