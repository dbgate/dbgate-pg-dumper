/**
 * PostgreSQL server-version parsing and comparison.
 *
 * `server_version_num` uses MMmmpp before PostgreSQL 10 and MMmmmm from 10
 * onward. Keeping the original number avoids ambiguity and permits catalog
 * feature checks without parsing vendor suffixes from the display string.
 */

import { UnsupportedPostgresVersionError } from '../utils/errors.js';

/** Oldest source version whose catalogs are intentionally supported. */
export const MINIMUM_SUPPORTED_POSTGRES_VERSION_NUM = 90600;

/** Complete normalized source server version metadata. */
export interface PostgresVersion {
  readonly complete: string;
  readonly number: number;
  /** PostgreSQL major line, for example `9.6`, `14`, or `18`. */
  readonly normalizedMajor: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parses and compares PostgreSQL versions without accessing a connection. */
export class PostgresVersionService {
  parse(serverVersionNumber: number | string, completeVersion: string): PostgresVersion {
    const number =
      typeof serverVersionNumber === 'string'
        ? Number.parseInt(serverVersionNumber, 10)
        : serverVersionNumber;

    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new UnsupportedPostgresVersionError(
        'The PostgreSQL server returned an invalid numeric version.',
      );
    }
    if (number < MINIMUM_SUPPORTED_POSTGRES_VERSION_NUM) {
      throw new UnsupportedPostgresVersionError(
        `PostgreSQL source version ${completeVersion} is unsupported; version 9.6 or newer is required.`,
      );
    }

    if (number >= 100000) {
      return {
        complete: completeVersion,
        number,
        normalizedMajor: String(Math.floor(number / 10000)),
        major: Math.floor(number / 10000),
        minor: number % 10000,
        patch: 0,
      };
    }

    return {
      complete: completeVersion,
      number,
      normalizedMajor: `${Math.floor(number / 10000)}.${Math.floor((number % 10000) / 100)}`,
      major: Math.floor(number / 10000),
      minor: Math.floor((number % 10000) / 100),
      patch: number % 100,
    };
  }

  compare(left: PostgresVersion, right: PostgresVersion): number {
    return Math.sign(left.number - right.number);
  }
}
