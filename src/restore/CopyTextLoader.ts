import { createHash } from 'node:crypto';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { quoteIdentifier, quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import { redactSensitiveText } from '../security/SensitiveValuePolicy.js';
import type { RestoreArchiveSource, RestoreDataOperation } from './RestoreArchive.js';
import {
  RestoreArchiveValidationError,
  RestoreCancellationError,
  RestoreCopyLoadError,
  safeSqlPreview,
  type RestoreSqlErrorFields,
} from './RestoreErrors.js';
import type { PostgresRestoreConnection, PostgreSqlCopyFromOperation } from './RestoreTarget.js';

const QUOTE_ALL = { quoteAllIdentifiers: true } as const;
const PSQL_END_MARKER = Buffer.from('\\.\n');
const PROGRESS_BYTE_INTERVAL = 1024 * 1024;
const PROGRESS_TIME_INTERVAL_MILLISECONDS = 250;

export interface CopyTextProgress {
  readonly bytes: number;
  readonly rows: number;
  readonly elapsedMilliseconds: number;
}

export interface CopyTextLoadRequest {
  readonly archive: RestoreArchiveSource;
  readonly connection: PostgresRestoreConnection;
  readonly operation: RestoreDataOperation;
  readonly stepId: string;
  readonly archiveEntryId: string;
  readonly objectIdentity?: string;
  readonly signal?: AbortSignal;
  readonly onStarted?: (copyCommand: string) => void;
  readonly onProgress?: (progress: CopyTextProgress) => void;
}

export interface CopyTextLoadResult extends CopyTextProgress {
  readonly serverRowCount?: number;
  readonly archiveReadDurationMilliseconds: number;
}

export interface CopyTextStreamLoadRequest {
  readonly source: Readable;
  readonly connection: PostgresRestoreConnection;
  readonly copyCommand: string;
  readonly endMarker?: 'absent' | 'psql';
  readonly checksum?: { readonly algorithm: 'sha256'; readonly value: string };
  readonly stepId: string;
  readonly archiveEntryId: string;
  readonly objectIdentity: string;
  readonly signal?: AbortSignal;
  readonly onStarted?: (copyCommand: string) => void;
  readonly onProgress?: (progress: CopyTextProgress) => void;
}

export function buildCopyFromCommand(operation: RestoreDataOperation): string {
  if (operation.columns.length === 0 && operation.allowZeroColumns !== true) {
    throw new RestoreArchiveValidationError(
      'A COPY table-data operation must contain at least one target column.',
    );
  }
  const table = quoteQualifiedIdentifier(
    [operation.table.schema, operation.table.table],
    QUOTE_ALL,
  );
  const columns =
    operation.columns.length === 0
      ? ''
      : ` (${operation.columns.map((column) => quoteIdentifier(column, QUOTE_ALL)).join(', ')})`;
  return `COPY ${table}${columns} FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`;
}

class PsqlEndMarkerStripper extends Transform {
  #tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    const combined = this.#tail.length === 0 ? bytes : Buffer.concat([this.#tail, bytes]);
    if (combined.length <= PSQL_END_MARKER.length) {
      this.#tail = combined;
      callback();
      return;
    }
    const emitLength = combined.length - PSQL_END_MARKER.length;
    this.push(combined.subarray(0, emitLength));
    this.#tail = Buffer.from(combined.subarray(emitLength));
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (!this.#tail.equals(PSQL_END_MARKER)) {
      callback(
        new RestoreArchiveValidationError(
          'A COPY payload declared a psql end marker but did not end with "\\\\.\\n".',
        ),
      );
      return;
    }
    this.#tail = Buffer.alloc(0);
    callback();
  }
}

class CopyPayloadMonitor extends Transform {
  readonly #hash = createHash('sha256');
  readonly #startedAt: number;
  #bytes = 0;
  #rows = 0;
  #lastByte: number | undefined;
  #lastProgressBytes = 0;
  #lastProgressAt: number;

  constructor(
    startedAt: number,
    private readonly onProgress?: (progress: CopyTextProgress) => void,
  ) {
    super();
    this.#startedAt = startedAt;
    this.#lastProgressAt = startedAt;
  }

  get progress(): CopyTextProgress {
    return {
      bytes: this.#bytes,
      rows: this.#rows,
      elapsedMilliseconds: Math.max(0, Date.now() - this.#startedAt),
    };
  }

  digest(): string {
    return this.#hash.digest('hex');
  }

  assertFinalNewline(): void {
    if (this.#bytes > 0 && this.#lastByte !== 0x0a) {
      throw new RestoreArchiveValidationError(
        'Canonical COPY text payload must end with a newline.',
      );
    }
  }

  emitFinalProgress(): void {
    this.emitProgress(true);
  }

  private emitProgress(force = false): void {
    if (this.onProgress === undefined) return;
    const now = Date.now();
    if (
      !force &&
      this.#lastProgressBytes > 0 &&
      this.#bytes - this.#lastProgressBytes < PROGRESS_BYTE_INTERVAL &&
      now - this.#lastProgressAt < PROGRESS_TIME_INTERVAL_MILLISECONDS
    ) {
      return;
    }
    this.onProgress(this.progress);
    this.#lastProgressBytes = this.#bytes;
    this.#lastProgressAt = now;
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#bytes += bytes.length;
    for (const byte of bytes) if (byte === 0x0a) this.#rows += 1;
    this.#lastByte = bytes.at(-1);
    this.#hash.update(bytes);
    try {
      this.emitProgress();
    } catch (cause) {
      callback(cause instanceof Error ? cause : new Error('COPY progress callback failed.'));
      return;
    }
    callback(undefined, bytes);
  }
}

function errorFields(cause: unknown): RestoreSqlErrorFields {
  const safeServerText = (value: string): string =>
    redactSensitiveText(value)
      .replace(/:\s*"[^"]*"(?=\s*$)/u, ': [REDACTED]')
      .replace(/Key \(([^)]*)\)=\([^)]*\)/gu, 'Key ($1)=([REDACTED])');
  let value = cause;
  for (let depth = 0; depth < 5; depth += 1) {
    if (value === null || typeof value !== 'object') break;
    const record = value as Record<string, unknown>;
    const fields: RestoreSqlErrorFields = {
      ...(typeof record.code === 'string' ? { sqlState: record.code } : {}),
      ...(typeof record.message === 'string'
        ? { serverMessage: safeServerText(record.message) }
        : {}),
      ...(typeof record.detail === 'string' ? { detail: safeServerText(record.detail) } : {}),
      ...(typeof record.hint === 'string' ? { hint: safeServerText(record.hint) } : {}),
      ...(typeof record.context === 'string' ? { context: safeServerText(record.context) } : {}),
      ...(typeof record.schema === 'string' ? { schema: record.schema } : {}),
      ...(typeof record.table === 'string' ? { table: record.table } : {}),
      ...(typeof record.column === 'string' ? { column: record.column } : {}),
      ...(typeof record.constraint === 'string' ? { constraint: record.constraint } : {}),
    };
    if (Object.keys(fields).length > 0) return fields;
    value = record.cause;
  }
  return {};
}

async function abortCopy(
  source: Readable | undefined,
  copy: PostgreSqlCopyFromOperation | undefined,
  cause: unknown,
): Promise<void> {
  const reason = cause instanceof Error ? cause : new Error('COPY input failed.');
  if (source !== undefined && !source.destroyed) source.destroy(reason);
  if (copy !== undefined) await copy.abort(reason).catch(() => undefined);
}

export async function loadCopyText(request: CopyTextLoadRequest): Promise<CopyTextLoadResult> {
  request.signal?.throwIfAborted();
  if (request.connection.openCopyFrom === undefined) {
    throw new RestoreArchiveValidationError(
      'The PostgreSQL restore connection does not support COPY FROM STDIN.',
    );
  }
  let source: Readable;
  try {
    source = await request.archive.openData(request.operation.dataSourceId, request.signal);
  } catch (cause) {
    const copyCommand = buildCopyFromCommand(request.operation);
    throw new RestoreCopyLoadError(
      'PostgreSQL COPY FROM STDIN table-data restore failed.',
      request.stepId,
      request.archiveEntryId,
      request.objectIdentity ??
        `${request.operation.table.schema}.${request.operation.table.table}`,
      safeSqlPreview(copyCommand),
      0,
      0,
      errorFields(cause),
      { cause },
    );
  }
  return loadCopyTextStream({
    source,
    connection: request.connection,
    copyCommand: buildCopyFromCommand(request.operation),
    endMarker: request.operation.copyText?.endMarker ?? 'absent',
    ...(request.operation.checksum === undefined ? {} : { checksum: request.operation.checksum }),
    stepId: request.stepId,
    archiveEntryId: request.archiveEntryId,
    objectIdentity:
      request.objectIdentity ??
      `${request.operation.table.schema}.${request.operation.table.table}`,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.onStarted === undefined ? {} : { onStarted: request.onStarted }),
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
  });
}

/** Streams an already-split COPY text payload through the native driver loader. */
export async function loadCopyTextStream(
  request: CopyTextStreamLoadRequest,
): Promise<CopyTextLoadResult> {
  request.signal?.throwIfAborted();
  if (request.connection.openCopyFrom === undefined) {
    if (!request.source.destroyed) request.source.destroy();
    throw new RestoreArchiveValidationError(
      'The PostgreSQL restore connection does not support COPY FROM STDIN.',
    );
  }

  const copyCommand = request.copyCommand;
  const startedAt = Date.now();
  const source: Readable = request.source;
  let copy: PostgreSqlCopyFromOperation | undefined;
  const monitor = new CopyPayloadMonitor(startedAt, request.onProgress);

  try {
    request.signal?.throwIfAborted();
    copy = await request.connection.openCopyFrom({
      query: copyCommand,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    request.onStarted?.(copyCommand);

    const completion = copy.completion;
    const streaming =
      request.endMarker === 'psql'
        ? pipeline(source, new PsqlEndMarkerStripper(), monitor, copy.writable, {
            signal: request.signal,
          })
        : pipeline(source, monitor, copy.writable, { signal: request.signal });
    const [, serverResult] = await Promise.all([streaming, completion]);
    monitor.assertFinalNewline();
    monitor.emitFinalProgress();
    const checksum = monitor.digest();
    if (
      request.checksum !== undefined &&
      checksum.toLowerCase() !== request.checksum.value.toLowerCase()
    ) {
      throw new RestoreArchiveValidationError('COPY payload SHA-256 checksum does not match.');
    }
    const progress = monitor.progress;
    return {
      ...progress,
      ...(serverResult.rowCount === undefined ? {} : { serverRowCount: serverResult.rowCount }),
      archiveReadDurationMilliseconds: progress.elapsedMilliseconds,
    };
  } catch (cause) {
    await abortCopy(source, copy, cause);
    if (request.signal?.aborted === true) {
      throw new RestoreCancellationError('PostgreSQL COPY restore was cancelled.', { cause });
    }
    if (cause instanceof RestoreCopyLoadError) throw cause;
    const progress = monitor.progress;
    throw new RestoreCopyLoadError(
      'PostgreSQL COPY FROM STDIN table-data restore failed.',
      request.stepId,
      request.archiveEntryId,
      request.objectIdentity,
      safeSqlPreview(copyCommand),
      progress.bytes,
      progress.rows,
      errorFields(cause),
      { cause },
    );
  } finally {
    if (source !== undefined && !source.destroyed) source.destroy();
  }
}
