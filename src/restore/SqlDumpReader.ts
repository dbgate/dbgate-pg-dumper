import { Readable } from 'node:stream';

import { RestoreCancellationError, SqlDumpRestoreError } from './RestoreErrors.js';

const DEFAULT_MAX_STATEMENT_BYTES = 64 * 1024 * 1024;
const COPY_OUTPUT_CHUNK_BYTES = 256 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
export const SQL_DUMP_HEADER_MARKER = '-- dbgate-pg-dumper PostgreSQL schema dump';

/** Detects the package marker in a caller-provided leading file sample. */
export function isDumperSqlDump(sample: string | Uint8Array): boolean {
  const decoded =
    typeof sample === 'string' ? sample : new TextDecoder('utf-8', { fatal: false }).decode(sample);
  const text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === SQL_DUMP_HEADER_MARKER) return true;
    if (trimmed !== '' && !trimmed.startsWith('--')) return false;
  }
  return false;
}

export interface SqlDumpReaderOptions {
  /** Reject inputs without the dbgate-pg-dumper header. Defaults to true. */
  readonly requireDumperHeader?: boolean;
  /** Maximum buffered SQL statement size. COPY payloads are never subject to this limit. */
  readonly maxStatementBytes?: number;
}

export interface SqlDumpLocation {
  /** Zero-based UTF-8 byte offset. */
  readonly offset: number;
  /** One-based physical line number. */
  readonly line: number;
  /** One-based byte column. */
  readonly column: number;
}

export interface SqlDumpSqlOperation {
  readonly kind: 'sql';
  readonly sql: string;
  readonly start: SqlDumpLocation;
  readonly end: SqlDumpLocation;
}

export interface SqlDumpCopyOperation {
  readonly kind: 'copy';
  readonly sql: string;
  readonly copyCommand: string;
  readonly table: { readonly schema: string; readonly table: string };
  readonly columns: readonly string[];
  readonly payload: Readable;
  readonly start: SqlDumpLocation;
  readonly dataStart: SqlDumpLocation;
}

export type SqlDumpOperation = SqlDumpSqlOperation | SqlDumpCopyOperation;

type ParserMode =
  | 'normal'
  | 'single-quote'
  | 'double-quote'
  | 'line-comment'
  | 'block-comment'
  | 'dollar-candidate'
  | 'dollar-quote';

interface CopyToken {
  readonly kind: 'word' | 'identifier' | 'punctuation';
  readonly value: string;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return result;
}

function isWhitespace(byte: number): boolean {
  return byte === 0xef || byte === 0xbb || byte === 0xbf || byte <= 0x20;
}

function isDollarTagStart(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f ||
    byte >= 0x80
  );
}

function isDollarTagPart(byte: number): boolean {
  return isDollarTagStart(byte) || (byte >= 0x30 && byte <= 0x39);
}

function decodeUtf8(bytes: Buffer, location: SqlDumpLocation): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new SqlDumpRestoreError(
      'RESTORE_SQL_DUMP_INVALID',
      'The SQL dump is not valid UTF-8.',
      location.offset,
      location.line,
      location.column,
      undefined,
      undefined,
      {},
      { cause },
    );
  }
}

function tokenizeCopyStatement(sql: string): readonly CopyToken[] {
  const tokens: CopyToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (character === '"') {
      index += 1;
      let value = '';
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (sql[index] === '"') {
          index += 1;
          break;
        } else {
          value += sql[index]!;
          index += 1;
        }
      }
      tokens.push({ kind: 'identifier', value });
      continue;
    }
    if (/[A-Za-z_\u0080-\u{10ffff}]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$\u0080-\u{10ffff}]/u.test(sql[index]!)) {
        index += 1;
      }
      tokens.push({ kind: 'word', value: sql.slice(start, index) });
      continue;
    }
    tokens.push({ kind: 'punctuation', value: character });
    index += 1;
  }
  return tokens;
}

function stripLeadingSqlTrivia(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    while (index < sql.length && /\s/u.test(sql[index]!)) index += 1;
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    break;
  }
  return sql.slice(index);
}

function identifier(token: CopyToken | undefined): string | undefined {
  if (token?.kind === 'identifier') return token.value;
  if (token?.kind === 'word') return token.value.toLowerCase();
  return undefined;
}

function parseGeneratedCopyStatement(sql: string):
  | {
      readonly table: { readonly schema: string; readonly table: string };
      readonly columns: readonly string[];
    }
  | undefined {
  const tokens = tokenizeCopyStatement(sql);
  let index = 0;
  if (tokens[index]?.kind !== 'word' || tokens[index]!.value.toUpperCase() !== 'COPY') {
    return undefined;
  }
  index += 1;
  const first = identifier(tokens[index]);
  if (first === undefined) return undefined;
  index += 1;
  if (tokens[index]?.value !== '.') return undefined;
  index += 1;
  const second = identifier(tokens[index]);
  if (second === undefined) return undefined;
  index += 1;
  if (tokens[index]?.value !== '(') return undefined;
  index += 1;
  const columns: string[] = [];
  while (true) {
    const column = identifier(tokens[index]);
    if (column === undefined) return undefined;
    columns.push(column);
    index += 1;
    if (tokens[index]?.value === ')') {
      index += 1;
      break;
    }
    if (tokens[index]?.value !== ',') return undefined;
    index += 1;
  }
  if (tokens[index]?.kind !== 'word' || tokens[index]!.value.toUpperCase() !== 'FROM') {
    return undefined;
  }
  index += 1;
  if (tokens[index]?.kind !== 'word' || tokens[index]!.value.toUpperCase() !== 'STDIN') {
    return undefined;
  }
  index += 1;
  if (tokens[index]?.value === ';') index += 1;
  if (index !== tokens.length || columns.length === 0) return undefined;
  return { table: { schema: first, table: second }, columns };
}

function isCopyFromStdinStatement(sql: string): boolean {
  const tokens = tokenizeCopyStatement(sql);
  return (
    tokens[0]?.kind === 'word' &&
    tokens[0].value.toUpperCase() === 'COPY' &&
    tokens.some(
      (token, index) =>
        token.kind === 'word' &&
        token.value.toUpperCase() === 'FROM' &&
        tokens[index + 1]?.kind === 'word' &&
        tokens[index + 1]!.value.toUpperCase() === 'STDIN',
    )
  );
}

function isPsqlMetaCommand(sql: string): boolean {
  return /^(?:\uFEFF|\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*\\/u.test(sql);
}

/**
 * Incremental reader for the deterministic plain-SQL format emitted by this package.
 *
 * It buffers at most one SQL statement. COPY payloads stay attached to the same
 * source and are exposed as a single-use Readable.
 */
export class SqlDumpReader {
  readonly #iterator: AsyncIterator<unknown>;
  readonly #signal: AbortSignal | undefined;
  readonly #maxStatementBytes: number;
  readonly #requireDumperHeader: boolean;
  #buffer = Buffer.alloc(0);
  #index = 0;
  #ended = false;
  #closed = false;
  #activeCopy = false;
  #headerChecked = false;
  #offset = 0;
  #line = 1;
  #column = 1;

  constructor(
    private readonly source: Readable,
    options: SqlDumpReaderOptions = {},
    signal?: AbortSignal,
  ) {
    this.#iterator = source[Symbol.asyncIterator]();
    this.#signal = signal;
    this.#maxStatementBytes = positiveInteger(
      options.maxStatementBytes,
      DEFAULT_MAX_STATEMENT_BYTES,
      'maxStatementBytes',
    );
    this.#requireDumperHeader = options.requireDumperHeader ?? true;
  }

  get location(): SqlDumpLocation {
    return { offset: this.#offset, line: this.#line, column: this.#column };
  }

  async nextOperation(): Promise<SqlDumpOperation | undefined> {
    this.assertReadable();
    if (this.#activeCopy) {
      throw this.parseError('The preceding COPY payload must be consumed before reading more SQL.');
    }
    await this.ensureBuffer();

    const parts: Buffer[] = [];
    let partBytes = 0;
    let partStart = this.#index;
    let mode: ParserMode = 'normal';
    let blockDepth = 0;
    let escaped = false;
    let singleBackslashEscapes = false;
    let previousNormalByte: number | undefined;
    let beforePreviousNormalByte: number | undefined;
    let dollarCandidate: number[] = [];
    let dollarDelimiter: number[] = [];
    let dollarMatch = 0;
    let hasCode = false;
    let start: SqlDumpLocation | undefined;

    const appendPart = (): void => {
      if (this.#index <= partStart) return;
      const part = this.#buffer.subarray(partStart, this.#index);
      parts.push(part);
      partBytes += part.length;
      if (partBytes > this.#maxStatementBytes) {
        throw this.parseError(
          `A SQL statement exceeds the configured ${this.#maxStatementBytes}-byte limit.`,
          start,
        );
      }
      partStart = this.#index;
    };
    const markCode = (location: SqlDumpLocation): void => {
      if (!hasCode) {
        hasCode = true;
        start = location;
      }
    };
    const peek = async (): Promise<number | undefined> => {
      if (this.#index >= this.#buffer.length) {
        appendPart();
        partStart = 0;
      }
      return (await this.ensureBuffer()) ? this.#buffer[this.#index] : undefined;
    };

    while (true) {
      this.throwIfCancelled();
      if (!(await this.ensureBuffer())) {
        appendPart();
        if (
          mode === 'single-quote' ||
          mode === 'double-quote' ||
          mode === 'block-comment' ||
          mode === 'dollar-quote'
        ) {
          throw this.parseError(
            `Unexpected end of file inside ${mode.replaceAll('-', ' ')}.`,
            start,
          );
        }
        if (!hasCode) {
          this.assertHeaderAtEnd(parts);
          return undefined;
        }
        throw this.parseError('The final SQL statement is missing a semicolon.', start);
      }
      const location = this.location;
      const byte = this.consumeByte();
      let reprocess = true;
      while (reprocess) {
        reprocess = false;
        if (mode === 'line-comment') {
          if (byte === 0x0a) mode = 'normal';
        } else if (mode === 'block-comment') {
          if (byte === 0x2f && (await peek()) === 0x2a) {
            this.consumeByte();
            blockDepth += 1;
          } else if (byte === 0x2a && (await peek()) === 0x2f) {
            this.consumeByte();
            blockDepth -= 1;
            if (blockDepth === 0) mode = 'normal';
          }
        } else if (mode === 'single-quote') {
          if (escaped) {
            escaped = false;
          } else if (singleBackslashEscapes && byte === 0x5c) {
            escaped = true;
          } else if (byte === 0x27) {
            if ((await peek()) === 0x27) this.consumeByte();
            else {
              mode = 'normal';
              beforePreviousNormalByte = undefined;
              previousNormalByte = byte;
            }
          }
        } else if (mode === 'double-quote') {
          if (byte === 0x22) {
            if ((await peek()) === 0x22) this.consumeByte();
            else mode = 'normal';
          }
        } else if (mode === 'dollar-candidate') {
          if (byte === 0x24) {
            dollarDelimiter = [...dollarCandidate, byte];
            dollarCandidate = [];
            dollarMatch = 0;
            mode = 'dollar-quote';
          } else {
            const tagIndex = dollarCandidate.length - 1;
            if (
              (tagIndex === 0 && isDollarTagStart(byte)) ||
              (tagIndex > 0 && isDollarTagPart(byte))
            ) {
              dollarCandidate.push(byte);
            } else {
              dollarCandidate = [];
              mode = 'normal';
              reprocess = true;
            }
          }
        } else if (mode === 'dollar-quote') {
          if (byte === dollarDelimiter[dollarMatch]) {
            dollarMatch += 1;
            if (dollarMatch === dollarDelimiter.length) {
              dollarMatch = 0;
              mode = 'normal';
            }
          } else {
            dollarMatch = byte === dollarDelimiter[0] ? 1 : 0;
          }
        } else {
          if (byte === 0x2d && (await peek()) === 0x2d) {
            this.consumeByte();
            mode = 'line-comment';
            previousNormalByte = undefined;
            beforePreviousNormalByte = undefined;
          } else if (byte === 0x2f && (await peek()) === 0x2a) {
            this.consumeByte();
            blockDepth = 1;
            mode = 'block-comment';
            previousNormalByte = undefined;
            beforePreviousNormalByte = undefined;
          } else if (byte === 0x27) {
            markCode(location);
            singleBackslashEscapes =
              (previousNormalByte === 0x45 || previousNormalByte === 0x65) &&
              (beforePreviousNormalByte === undefined ||
                !isDollarTagPart(beforePreviousNormalByte));
            mode = 'single-quote';
          } else if (byte === 0x22) {
            markCode(location);
            mode = 'double-quote';
            previousNormalByte = undefined;
            beforePreviousNormalByte = undefined;
          } else if (byte === 0x24) {
            markCode(location);
            dollarCandidate = [byte];
            mode = 'dollar-candidate';
            previousNormalByte = undefined;
            beforePreviousNormalByte = undefined;
          } else if (byte === 0x3b) {
            markCode(location);
            appendPart();
            const sqlBytes = Buffer.concat(parts, partBytes);
            const rawSql = decodeUtf8(
              sqlBytes.subarray(sqlBytes.subarray(0, 3).equals(UTF8_BOM) ? 3 : 0),
              start ?? location,
            );
            this.assertCompatibleHeader(rawSql, start ?? location);
            const sql = stripLeadingSqlTrivia(rawSql);
            if (isPsqlMetaCommand(sql)) {
              throw this.parseError(
                'psql meta-commands are not supported by the native SQL dump reader.',
                start,
              );
            }
            const copy = parseGeneratedCopyStatement(sql);
            if (copy === undefined) {
              if (isCopyFromStdinStatement(sql)) {
                throw this.parseError(
                  'This COPY FROM STDIN variant is not supported by the dbgate plain-SQL reader.',
                  start,
                );
              }
              return {
                kind: 'sql',
                sql,
                start: start ?? location,
                end: this.location,
              };
            }
            await this.consumeCopyCommandLineEnding();
            this.#activeCopy = true;
            const copyCommand = buildCanonicalCopyCommand(copy.table, copy.columns);
            return {
              kind: 'copy',
              sql,
              copyCommand,
              table: copy.table,
              columns: copy.columns,
              payload: Readable.from(this.readCopyPayload()),
              start: start ?? location,
              dataStart: this.location,
            };
          } else if (!isWhitespace(byte)) {
            markCode(location);
            beforePreviousNormalByte = previousNormalByte;
            previousNormalByte = byte;
          } else {
            previousNormalByte = undefined;
            beforePreviousNormalByte = undefined;
          }
        }
      }

      if (this.#index >= this.#buffer.length) {
        appendPart();
        partStart = 0;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#iterator.return?.();
    if (!this.source.destroyed) this.source.destroy();
  }

  private async *readCopyPayload(): AsyncGenerator<Buffer> {
    let lineParts: Buffer[] = [];
    let lineBytes = 0;
    let outputParts: Buffer[] = [];
    let outputBytes = 0;
    const emitOutput = (): Buffer | undefined => {
      if (outputBytes === 0) return undefined;
      const output = Buffer.concat(outputParts, outputBytes);
      outputParts = [];
      outputBytes = 0;
      return output;
    };

    try {
      while (true) {
        this.throwIfCancelled();
        if (!(await this.ensureBuffer())) {
          throw this.parseError('COPY FROM STDIN data is missing its terminating "\\\\." line.');
        }
        const newline = this.#buffer.indexOf(0x0a, this.#index);
        const end = newline === -1 ? this.#buffer.length : newline + 1;
        const part = this.#buffer.subarray(this.#index, end);
        this.advanceBytes(part);
        this.#index = end;
        lineParts.push(part);
        lineBytes += part.length;
        if (newline === -1) continue;

        const line = Buffer.concat(lineParts, lineBytes);
        lineParts = [];
        lineBytes = 0;
        const contentEnd =
          line.length >= 2 && line.at(-2) === 0x0d ? line.length - 2 : line.length - 1;
        const marker = contentEnd === 2 && line[0] === 0x5c && line[1] === 0x2e;
        if (marker) {
          const output = emitOutput();
          if (output !== undefined) yield output;
          return;
        }
        outputParts.push(line);
        outputBytes += line.length;
        if (outputBytes >= COPY_OUTPUT_CHUNK_BYTES) {
          const output = emitOutput();
          if (output !== undefined) yield output;
        }
      }
    } finally {
      this.#activeCopy = false;
    }
  }

  private async ensureBuffer(): Promise<boolean> {
    while (this.#index >= this.#buffer.length && !this.#ended) {
      this.throwIfCancelled();
      const next = await this.#iterator.next();
      if (next.done) {
        this.#ended = true;
        this.#buffer = Buffer.alloc(0);
        this.#index = 0;
        break;
      }
      if (typeof next.value === 'string') {
        this.#buffer = Buffer.from(next.value, 'utf8');
      } else if (Buffer.isBuffer(next.value) || next.value instanceof Uint8Array) {
        this.#buffer = Buffer.from(next.value);
      } else {
        throw this.parseError('The SQL dump stream emitted a non-byte chunk.');
      }
      this.#index = 0;
    }
    return this.#index < this.#buffer.length;
  }

  private async consumeCopyCommandLineEnding(): Promise<void> {
    while (await this.ensureBuffer()) {
      const location = this.location;
      const byte = this.consumeByte();
      if (byte === 0x0a) return;
      if (byte !== 0x0d && byte !== 0x20 && byte !== 0x09) {
        throw this.parseError(
          'COPY FROM STDIN data must begin on the physical line after the COPY statement.',
          location,
        );
      }
    }
    throw this.parseError('COPY FROM STDIN data is missing after the COPY statement.');
  }

  private consumeByte(): number {
    const byte = this.#buffer[this.#index]!;
    this.#index += 1;
    this.#offset += 1;
    if (byte === 0x0a) {
      this.#line += 1;
      this.#column = 1;
    } else {
      this.#column += 1;
    }
    return byte;
  }

  private advanceBytes(bytes: Buffer): void {
    this.#offset += bytes.length;
    let lastNewline = -1;
    let newlines = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0x0a) {
        newlines += 1;
        lastNewline = index;
      }
    }
    if (newlines === 0) {
      this.#column += bytes.length;
    } else {
      this.#line += newlines;
      this.#column = bytes.length - lastNewline;
    }
  }

  private assertCompatibleHeader(sql: string, location: SqlDumpLocation): void {
    if (this.#headerChecked) return;
    this.#headerChecked = true;
    if (this.#requireDumperHeader && !isDumperSqlDump(sql)) {
      throw new SqlDumpRestoreError(
        'RESTORE_SQL_DUMP_INVALID',
        'The input is not a compatible dbgate-pg-dumper plain-SQL dump.',
        location.offset,
        location.line,
        location.column,
      );
    }
  }

  private assertHeaderAtEnd(parts: readonly Buffer[]): void {
    if (this.#headerChecked || !this.#requireDumperHeader) return;
    const trailing = Buffer.concat(parts).toString('utf8');
    if (isDumperSqlDump(trailing)) {
      this.#headerChecked = true;
      return;
    }
    throw this.parseError('The input is not a compatible dbgate-pg-dumper plain-SQL dump.');
  }

  private assertReadable(): void {
    this.throwIfCancelled();
    if (this.#closed) throw this.parseError('The SQL dump reader is closed.');
  }

  private throwIfCancelled(): void {
    if (this.#signal?.aborted) {
      throw new RestoreCancellationError('PostgreSQL SQL dump restore was cancelled.', {
        cause: this.#signal.reason,
      });
    }
  }

  private parseError(
    message: string,
    location: SqlDumpLocation = this.location,
  ): SqlDumpRestoreError {
    return new SqlDumpRestoreError(
      'RESTORE_SQL_DUMP_INVALID',
      message,
      location.offset,
      location.line,
      location.column,
    );
  }
}

function quoteIdentifier(identifierValue: string): string {
  return `"${identifierValue.replaceAll('"', '""')}"`;
}

function buildCanonicalCopyCommand(
  table: { readonly schema: string; readonly table: string },
  columns: readonly string[],
): string {
  return `COPY ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)} (${columns
    .map(quoteIdentifier)
    .join(', ')}) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`;
}
