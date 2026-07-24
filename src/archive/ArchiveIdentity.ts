/**
 * Deterministic archive identity and dump-ID generation.
 *
 * Canonical identities use length-prefixed components, avoiding delimiter
 * ambiguity. The short SHA-256 dump ID is stable across processes and does not
 * depend on input array or object iteration order.
 */

import { createHash } from 'node:crypto';

import type { ArchiveObjectType } from './ArchiveTypes.js';

export interface ArchiveIdentityInput {
  readonly objectType: ArchiveObjectType;
  readonly schema?: string;
  readonly name: string;
  readonly parentIdentity?: string;
  readonly specificIdentity?: string;
}

function component(value: string | undefined): string {
  const normalized = value ?? '';
  return `${normalized.length}:${normalized}`;
}

export function createArchiveIdentity(input: ArchiveIdentityInput): string {
  return [
    component(input.objectType),
    component(input.schema),
    component(input.name),
    component(input.parentIdentity),
    component(input.specificIdentity),
  ].join('|');
}

export function createDumpId(archiveIdentity: string): string {
  return `d_${createHash('sha256').update(archiveIdentity).digest('hex').slice(0, 24)}`;
}
