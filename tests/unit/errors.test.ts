import { describe, expect, it } from 'vitest';

import { ConnectionError, IntrospectionQueryError } from '../../src/index.js';
import { redactSecrets } from '../../src/utils/errors.js';

describe('structured errors', () => {
  it('preserves causes under stable error codes', () => {
    const cause = new Error('driver detail');
    const error = new IntrospectionQueryError('Failed to introspect tables.', { cause });
    expect(error.code).toBe('INTROSPECTION_QUERY_FAILURE');
    expect(error.cause).toBe(cause);
  });

  it('redacts URI and key-value credentials', () => {
    const message = redactSecrets('postgresql://alice:hunter2@db/app password=secret token="abc"');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('abc');
    expect(message).toContain('[REDACTED]');
  });

  it('does not expose driver causes in connection messages', () => {
    const error = new ConnectionError('Failed to connect.', {
      cause: new Error('password=super-secret'),
    });
    expect(error.message).toBe('Failed to connect.');
  });
});
