import { describe, expect, it } from 'vitest';

import {
  PostgresVersionService,
  UnsupportedPostgresVersionError,
  detectSourceCapabilities,
} from '../../src/index.js';

describe('PostgresVersionService', () => {
  const service = new PostgresVersionService();

  it('parses pre-10 version numbering', () => {
    expect(service.parse('90624', '9.6.24')).toEqual({
      complete: '9.6.24',
      number: 90624,
      normalizedMajor: '9.6',
      major: 9,
      minor: 6,
      patch: 24,
    });
  });

  it('parses post-10 version numbering', () => {
    expect(service.parse(180004, '18.4 (Debian)')).toEqual({
      complete: '18.4 (Debian)',
      number: 180004,
      normalizedMajor: '18',
      major: 18,
      minor: 4,
      patch: 0,
    });
  });

  it('rejects unsupported source versions', () => {
    expect(() => service.parse(90525, '9.5.25')).toThrow(UnsupportedPostgresVersionError);
  });
});

describe('source capabilities', () => {
  const service = new PostgresVersionService();

  it('uses source catalog feature thresholds', () => {
    expect(detectSourceCapabilities(service.parse(90624, '9.6.24'))).toMatchObject({
      identityColumns: false,
      declarativePartitioning: false,
      procedures: false,
      generatedColumns: false,
      columnCompression: false,
      transitionTables: false,
      restrictivePolicies: false,
      supportFunctions: false,
      securityInvokerViews: false,
    });
    expect(detectSourceCapabilities(service.parse(140012, '14.12'))).toMatchObject({
      identityColumns: true,
      declarativePartitioning: true,
      procedures: true,
      includeIndexes: true,
      generatedColumns: true,
      columnCompression: true,
      nullsNotDistinct: false,
      multiranges: true,
      transitionTables: true,
      restrictivePolicies: true,
      supportFunctions: true,
      securityInvokerViews: false,
    });
    expect(detectSourceCapabilities(service.parse(150008, '15.8'))).toMatchObject({
      nullsNotDistinct: true,
      securityInvokerViews: true,
    });
  });
});
