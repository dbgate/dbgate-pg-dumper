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
