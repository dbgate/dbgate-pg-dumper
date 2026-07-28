import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { redactSensitiveText } from '../security/SensitiveValuePolicy.js';
import {
  RestoreCancellationError,
  RestoreCopyLoadError,
  RestoreCopyValidationError,
  safeSqlPreview,
  type RestoreSqlErrorFields,
} from './RestoreErrors.js';
import type { PostgresRestoreConnection, PostgreSqlCopyFromOperation } from './RestoreTarget.js';

const PROGRESS_BYTE_INTERVAL = 1024 * 1024;
const PROGRESS_TIME_INTERVAL_MILLISECONDS = 250;

export interface CopyTextProgress {
  readonly bytes: number;
  readonly rows: number;
  readonly elapsedMilliseconds: number;
}

export interface CopyTextLoadResult extends CopyTextProgress {
  readonly serverRowCount?: number;
}

export interface CopyTextStreamLoadRequest {
  readonly source: Readable;
  readonly connection: PostgresRestoreConnection;
  readonly copyCommand: string;
  readonly operationId: string;
  readonly objectIdentity: string;
  readonly signal?: AbortSignal;
  readonly onStarted?: (copyCommand: string) => void;
  readonly onProgress?: (progress: CopyTextProgress) => void;
}

class CopyPayloadMonitor extends Transform {
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

  assertFinalNewline(): void {
    if (this.#bytes > 0 && this.#lastByte !== 0x0a) {
      throw new RestoreCopyValidationError('COPY text payload must end with a newline.');
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
  source: Readable,
  copy: PostgreSqlCopyFromOperation | undefined,
  cause: unknown,
): Promise<void> {
  const reason = cause instanceof Error ? cause : new Error('COPY input failed.');
  if (!source.destroyed) source.destroy(reason);
  if (copy !== undefined) await copy.abort(reason).catch(() => undefined);
}

/** Streams a plain-SQL COPY payload through a PostgreSQL COPY FROM STDIN connection. */
export async function loadCopyTextStream(
  request: CopyTextStreamLoadRequest,
): Promise<CopyTextLoadResult> {
  request.signal?.throwIfAborted();
  if (request.connection.openCopyFrom === undefined) {
    if (!request.source.destroyed) request.source.destroy();
    throw new RestoreCopyValidationError(
      'The PostgreSQL restore connection does not support COPY FROM STDIN.',
    );
  }

  const startedAt = Date.now();
  let copy: PostgreSqlCopyFromOperation | undefined;
  const monitor = new CopyPayloadMonitor(startedAt, request.onProgress);

  try {
    copy = await request.connection.openCopyFrom({
      query: request.copyCommand,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    request.onStarted?.(request.copyCommand);
    const completion = copy.completion;
    const streaming = pipeline(request.source, monitor, copy.writable, {
      signal: request.signal,
    });
    const [, serverResult] = await Promise.all([streaming, completion]);
    monitor.assertFinalNewline();
    monitor.emitFinalProgress();
    return {
      ...monitor.progress,
      ...(serverResult.rowCount === undefined ? {} : { serverRowCount: serverResult.rowCount }),
    };
  } catch (cause) {
    await abortCopy(request.source, copy, cause);
    if (request.signal?.aborted === true) {
      throw new RestoreCancellationError('PostgreSQL COPY restore was cancelled.', { cause });
    }
    if (cause instanceof RestoreCopyLoadError) throw cause;
    const progress = monitor.progress;
    throw new RestoreCopyLoadError(
      'PostgreSQL COPY FROM STDIN table-data restore failed.',
      request.operationId,
      request.objectIdentity,
      safeSqlPreview(request.copyCommand),
      progress.bytes,
      progress.rows,
      errorFields(cause),
      { cause },
    );
  } finally {
    if (!request.source.destroyed) request.source.destroy();
  }
}
