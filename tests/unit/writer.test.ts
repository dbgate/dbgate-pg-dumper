/** Streaming writer tests cover byte accounting, cancellation, and failures. */

import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { StreamDumpWriter, StringDumpWriter } from '../../src/index.js';

describe('plain SQL writers', () => {
  it('tracks UTF-8 bytes and deterministic line endings', async () => {
    const writer = new StringDumpWriter({ lineEnding: '\r\n' });
    await writer.writeLine('ž');
    await writer.write('done');
    expect(writer.toString()).toBe('ž\r\ndone');
    expect(writer.bytesWritten).toBe(Buffer.byteLength('ž\r\ndone'));
  });

  it('surfaces structured writable failures', async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('disk full'));
      },
    });
    const writer = new StreamDumpWriter(output);
    await expect(writer.write('SQL')).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILURE' });
  });

  it('honors cancellation without writing', async () => {
    const controller = new AbortController();
    controller.abort();
    const writer = new StringDumpWriter();
    await expect(writer.write('SQL', controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(writer.bytesWritten).toBe(0);
  });
});
