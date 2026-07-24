/**
 * PostgreSQL COPY text-format escaping and incremental field output.
 *
 * Backslashes are escaped before all COPY control sequences. Remaining C0
 * controls and DEL use three-digit octal escapes accepted by PostgreSQL COPY.
 * Consequently literal `\N` is data, and a literal `\.` can never terminate a
 * block. Unicode code points are preserved unchanged.
 */

import type { DumpWriter } from '../writer/DumpWriter.js';

function copyEscape(character: string): string | undefined {
  switch (character) {
    case '\\':
      return '\\\\';
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    case '\v':
      return '\\v';
    default: {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? `\\${code.toString(8).padStart(3, '0')}` : undefined;
    }
  }
}

export function escapeCopyText(value: string): string {
  let output = '';
  for (const character of value) output += copyEscape(character) ?? character;
  return output;
}

/** Writes one field without allocating an escaped copy of a potentially large value. */
export async function writeCopyTextValue(
  writer: DumpWriter,
  value: string,
  signal?: AbortSignal,
): Promise<void> {
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const escaped = copyEscape(value[index]!);
    if (escaped === undefined) continue;
    if (index > start) await writer.write(value.slice(start, index), signal);
    await writer.write(escaped, signal);
    start = index + 1;
  }
  if (start < value.length) await writer.write(value.slice(start), signal);
}
