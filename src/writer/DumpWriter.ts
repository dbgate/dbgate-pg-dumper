/**
 * Incremental, backpressure-aware plain-text output writers.
 *
 * Writers never close caller-owned streams. Serial awaited writes ensure the
 * renderer cannot outpace Node.js stream backpressure, and byte counts use the
 * exact UTF-8 representation accepted by the output.
 */

import type { Writable } from 'node:stream';

import { OutputWriteError, toCancellationError } from '../utils/errors.js';

export type SqlLineEnding = '\n' | '\r\n';

export interface DumpWriter {
  readonly bytesWritten: number;
  readonly lineEnding: SqlLineEnding;
  write(chunk: string | Uint8Array, signal?: AbortSignal): Promise<void>;
  writeLine(line?: string, signal?: AbortSignal): Promise<void>;
  flush(signal?: AbortSignal): Promise<void>;
}

export interface DumpWriterOptions {
  readonly lineEnding?: SqlLineEnding;
}

export class StreamDumpWriter implements DumpWriter {
  #bytesWritten = 0;
  readonly lineEnding: SqlLineEnding;

  constructor(
    private readonly output: Writable,
    options: DumpWriterOptions = {},
  ) {
    this.lineEnding = options.lineEnding ?? '\n';
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }

  async write(chunk: string | Uint8Array, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw toCancellationError(signal.reason);
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    if (buffer.byteLength === 0) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error === undefined || error === null) {
          this.output.removeListener('error', streamFailed);
        }
        if (error !== undefined && error !== null) {
          reject(
            new OutputWriteError('Failed to write the PostgreSQL dump output.', { cause: error }),
          );
          return;
        }
        this.#bytesWritten += buffer.byteLength;
        resolve();
      };
      const abort = (): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        this.output.removeListener('error', streamFailed);
        reject(toCancellationError(signal?.reason));
      };
      const streamFailed = (error: Error): void => finish(error);
      signal?.addEventListener('abort', abort, { once: true });
      this.output.once('error', streamFailed);
      try {
        this.output.write(buffer, (error) => finish(error));
      } catch (cause) {
        this.output.removeListener('error', streamFailed);
        finish(cause instanceof Error ? cause : new Error('Writable stream rejected output.'));
      }
    });
  }

  writeLine(line = '', signal?: AbortSignal): Promise<void> {
    return this.write(`${line}${this.lineEnding}`, signal);
  }

  async flush(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw toCancellationError(signal.reason);
    if (!this.output.writableNeedDrain) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        this.output.off('drain', drained);
        this.output.off('error', failed);
        signal?.removeEventListener('abort', aborted);
      };
      const complete = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const drained = (): void => complete(resolve);
      const failed = (cause: Error): void =>
        complete(() =>
          reject(new OutputWriteError('Failed while flushing PostgreSQL dump output.', { cause })),
        );
      const aborted = (): void => complete(() => reject(toCancellationError(signal?.reason)));
      this.output.once('drain', drained);
      this.output.once('error', failed);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
}

/** In-memory writer intended for tests and bounded previews only. */
export class StringDumpWriter implements DumpWriter {
  #bytesWritten = 0;
  #chunks: string[] = [];
  readonly lineEnding: SqlLineEnding;

  constructor(options: DumpWriterOptions = {}) {
    this.lineEnding = options.lineEnding ?? '\n';
  }

  get bytesWritten(): number {
    return this.#bytesWritten;
  }

  write(chunk: string | Uint8Array, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(toCancellationError(signal.reason));
    const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.#chunks.push(value);
    this.#bytesWritten += Buffer.byteLength(value, 'utf8');
    return Promise.resolve();
  }

  writeLine(line = '', signal?: AbortSignal): Promise<void> {
    return this.write(`${line}${this.lineEnding}`, signal);
  }

  flush(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(toCancellationError(signal.reason));
    return Promise.resolve();
  }

  toString(): string {
    return this.#chunks.join('');
  }
}
