import { Readable } from 'node:stream';

import type { ArchiveObjectType, DumpSection } from '../archive/ArchiveTypes.js';
import type { PostgresVersion } from '../version/PostgresVersion.js';
import { RestoreArchiveValidationError } from './RestoreErrors.js';

export const RESTORE_ARCHIVE_FORMAT = 'dbgate-postgres-structured-restore';
export const RESTORE_ARCHIVE_FORMAT_VERSION = 1;

export type RestoreTransactionRequirement = 'allowed' | 'required' | 'forbidden';

export interface RestoreTargetVersionConstraint {
  readonly minimum?: number;
  readonly maximumExclusive?: number;
  readonly description?: string;
}

export interface RestoreArchiveDiagnosticMetadata {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly archiveEntryId?: string;
  readonly objectIdentity?: string;
}

export interface RestoreArchiveMetadata {
  readonly format: typeof RESTORE_ARCHIVE_FORMAT;
  readonly formatVersion: typeof RESTORE_ARCHIVE_FORMAT_VERSION;
  readonly archiveId: string;
  readonly sourceVersion: PostgresVersion;
  readonly createdAt?: string;
  readonly targetVersionConstraint?: RestoreTargetVersionConstraint;
  readonly requiredExtensions: readonly string[];
  readonly requiredRoles: readonly string[];
  readonly requiredPrivileges: readonly string[];
  readonly requiredTablespaces: readonly string[];
  readonly transactionCompatibility: 'compatible' | 'section-only' | 'incompatible';
  readonly estimatedRows?: number;
  readonly estimatedDataBytes?: number;
  readonly diagnostics: readonly RestoreArchiveDiagnosticMetadata[];
}

export interface RestoreSqlOperation {
  readonly kind: 'sql';
  readonly sql: string;
  readonly parameters?: readonly unknown[];
  readonly transactionRequirement: RestoreTransactionRequirement;
  readonly privilegeRequirements: readonly string[];
  readonly targetVersionConstraint?: RestoreTargetVersionConstraint;
  readonly containsSensitiveFragments?: boolean;
}

export type RestoreDataFormat = 'copy-text' | 'copy-csv' | 'copy-binary' | 'insert-records';

export interface RestoreCopyTextFormat {
  readonly encoding: 'UTF8';
  readonly delimiter: '\t';
  readonly nullMarker: '\\N';
  readonly escapeBehavior: 'postgres-backslash';
  readonly lineEnding: '\n';
  readonly finalNewline: 'required';
  readonly endMarker: 'absent' | 'psql';
  readonly onePhysicalLinePerRow: true;
}

export const CANONICAL_RESTORE_COPY_TEXT_FORMAT: RestoreCopyTextFormat = {
  encoding: 'UTF8',
  delimiter: '\t',
  nullMarker: '\\N',
  escapeBehavior: 'postgres-backslash',
  lineEnding: '\n',
  finalNewline: 'required',
  endMarker: 'absent',
  onePhysicalLinePerRow: true,
};

export interface RestoreTableIdentity {
  readonly schema: string;
  readonly table: string;
}

export interface RestoreIdentityColumn {
  readonly name: string;
  readonly generation: 'always' | 'by-default';
}

export interface RestoreDataOperation {
  readonly kind: 'table-data';
  readonly table: RestoreTableIdentity;
  readonly columns: readonly string[];
  readonly format: RestoreDataFormat;
  readonly copyText?: RestoreCopyTextFormat;
  readonly dataSourceId: string;
  readonly estimatedRows?: number;
  readonly estimatedBytes?: number;
  readonly identityBehavior: 'preserve' | 'generate';
  readonly identityColumns?: readonly RestoreIdentityColumn[];
  readonly generatedColumns?: readonly string[];
  readonly allowZeroColumns?: boolean;
  readonly partitionBehavior: 'target-table' | 'route-partitions';
  readonly tableKind?: 'ordinary' | 'partitioned-root' | 'partition-leaf' | 'foreign';
  readonly partitionDataSetId?: string;
  readonly foreignTableDataRequired?: boolean;
  readonly checksum?: {
    readonly algorithm: 'sha256';
    readonly value: string;
  };
  readonly targetVersionConstraint?: RestoreTargetVersionConstraint;
  readonly transactionRequirement: RestoreTransactionRequirement;
}

export interface RestoreSequenceStateOperation {
  readonly kind: 'sequence-state';
  readonly schema: string;
  readonly sequence: string;
  readonly lastValue: string;
  readonly isCalled: boolean;
  readonly ownedBy?: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
  };
  readonly targetVersionConstraint?: RestoreTargetVersionConstraint;
  readonly transactionRequirement: RestoreTransactionRequirement;
}

export type RestoreArchiveOperation =
  RestoreSqlOperation | RestoreDataOperation | RestoreSequenceStateOperation;

export interface RestoreArchiveEntry {
  readonly entryId: string;
  readonly archiveIdentity: string;
  readonly objectType: ArchiveObjectType;
  readonly section: DumpSection;
  readonly objectIdentity?: string;
  readonly dependencyEntryIds: readonly string[];
  readonly operation: RestoreArchiveOperation;
  readonly description: string;
  readonly diagnostics: readonly RestoreArchiveDiagnosticMetadata[];
}

export interface RestoreArchiveSource {
  readMetadata(signal?: AbortSignal): Promise<RestoreArchiveMetadata>;
  listEntries(signal?: AbortSignal): AsyncIterable<RestoreArchiveEntry>;
  openData(entryId: string, signal?: AbortSignal): Promise<Readable>;
  close(): Promise<void>;
}

export type InMemoryRestoreData = string | Uint8Array | (() => Readable | Promise<Readable>);

export interface InMemoryRestoreArchive {
  readonly metadata: RestoreArchiveMetadata;
  readonly entries: readonly RestoreArchiveEntry[];
  readonly data?: ReadonlyMap<string, InMemoryRestoreData>;
}

export class InMemoryRestoreArchiveSource implements RestoreArchiveSource {
  #closed = false;
  readonly #openedDataSources = new Set<string>();

  constructor(private readonly archive: InMemoryRestoreArchive) {}

  get closed(): boolean {
    return this.#closed;
  }

  readMetadata(signal?: AbortSignal): Promise<RestoreArchiveMetadata> {
    try {
      this.assertOpen(signal);
      return Promise.resolve(this.archive.metadata);
    } catch (cause) {
      return Promise.reject(
        cause instanceof Error
          ? cause
          : new RestoreArchiveValidationError('Failed to read restore archive metadata.', {
              cause,
            }),
      );
    }
  }

  async *listEntries(signal?: AbortSignal): AsyncIterable<RestoreArchiveEntry> {
    await Promise.resolve();
    this.assertOpen(signal);
    for (const entry of this.archive.entries) {
      this.assertOpen(signal);
      yield entry;
    }
  }

  async openData(entryId: string, signal?: AbortSignal): Promise<Readable> {
    this.assertOpen(signal);
    if (this.#openedDataSources.has(entryId)) {
      throw new RestoreArchiveValidationError(
        'A single-use restore archive data source cannot be opened more than once.',
      );
    }
    const value = this.archive.data?.get(entryId);
    if (value === undefined) {
      throw new RestoreArchiveValidationError(
        'The structured restore archive does not contain the requested data source.',
      );
    }
    this.#openedDataSources.add(entryId);
    if (typeof value === 'function') return value();
    return Readable.from([value]);
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  private assertOpen(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.#closed) {
      throw new RestoreArchiveValidationError('The structured restore archive source is closed.');
    }
  }
}
