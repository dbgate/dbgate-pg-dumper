import type { PostgresQuery } from '../connection/PostgresConnection.js';
import { quoteQualifiedIdentifier } from '../renderer/SqlPrimitives.js';
import type { RestoreSequenceStateOperation } from './RestoreArchive.js';
import { RestoreArchiveValidationError } from './RestoreErrors.js';

const BIGINT_MINIMUM = -(1n << 63n);
const BIGINT_MAXIMUM = (1n << 63n) - 1n;
const INTEGER_MINIMUM = -(1n << 31n);
const INTEGER_MAXIMUM = (1n << 31n) - 1n;
const SMALLINT_MINIMUM = -(1n << 15n);
const SMALLINT_MAXIMUM = (1n << 15n) - 1n;
const QUOTE_ALL = { quoteAllIdentifiers: true } as const;

export function sequenceIdentity(operation: RestoreSequenceStateOperation): string {
  return quoteQualifiedIdentifier([operation.schema, operation.sequence], QUOTE_ALL);
}

export function validateSequenceState(operation: RestoreSequenceStateOperation): void {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(operation.lastValue)) {
    throw new RestoreArchiveValidationError(
      'Sequence lastValue must be a canonical decimal integer string.',
    );
  }
  const value = BigInt(operation.lastValue);
  const [minimum, maximum] =
    operation.dataType === 'smallint'
      ? [SMALLINT_MINIMUM, SMALLINT_MAXIMUM]
      : operation.dataType === 'integer'
        ? [INTEGER_MINIMUM, INTEGER_MAXIMUM]
        : [BIGINT_MINIMUM, BIGINT_MAXIMUM];
  if (value < minimum || value > maximum) {
    throw new RestoreArchiveValidationError(
      `Sequence lastValue is outside the ${operation.dataType ?? 'bigint'} range.`,
    );
  }
  if (
    operation.increment !== undefined &&
    (!/^-?(?:0|[1-9]\d*)$/u.test(operation.increment) || BigInt(operation.increment) === 0n)
  ) {
    throw new RestoreArchiveValidationError('Sequence increment must be a non-zero integer.');
  }
  if (
    operation.ownership === 'standalone' &&
    (operation.ownedBy !== undefined || operation.identityGeneration !== undefined)
  ) {
    throw new RestoreArchiveValidationError(
      'A standalone sequence cannot declare a column ownership relationship.',
    );
  }
  if (operation.ownership === 'identity' && operation.ownedBy === undefined) {
    throw new RestoreArchiveValidationError(
      'An identity sequence must identify its owned table column.',
    );
  }
  if (
    operation.identityGeneration !== undefined &&
    operation.ownership !== undefined &&
    operation.ownership !== 'identity'
  ) {
    throw new RestoreArchiveValidationError(
      'Identity generation metadata is valid only for identity sequences.',
    );
  }
}

export function buildSequenceSetvalQuery(operation: RestoreSequenceStateOperation): PostgresQuery {
  validateSequenceState(operation);
  return {
    text: `SELECT pg_catalog.setval($1::pg_catalog.regclass, $2::pg_catalog.int8, $3::pg_catalog.bool)`,
    values: [sequenceIdentity(operation), operation.lastValue, operation.isCalled],
  };
}
