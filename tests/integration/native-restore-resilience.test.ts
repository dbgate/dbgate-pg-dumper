import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  CANONICAL_RESTORE_COPY_TEXT_FORMAT,
  createRestoreEngine,
  InMemoryRestoreArchiveSource,
  quoteIdentifier,
  type RestoreArchiveEntry,
  type RestoreProgressEvent,
} from '../../src/index.js';
import { NativeRestoreFixture, restoreFailureContext } from './support/nativeRestoreTestSupport.js';

function schemaEntry(fixture: NativeRestoreFixture): RestoreArchiveEntry {
  return {
    entryId: 'schema',
    archiveIdentity: `schema:${fixture.schema}`,
    objectType: 'schema',
    section: 'pre-data',
    objectIdentity: fixture.schema,
    dependencyEntryIds: [],
    operation: {
      kind: 'sql',
      sql: `CREATE SCHEMA ${quoteIdentifier(fixture.schema)}`,
      target: { kind: 'schema', name: fixture.schema },
      transactionRequirement: 'allowed',
      privilegeRequirements: [],
    },
    description: 'Create resilience-test schema.',
    diagnostics: [],
  };
}

function tableEntry(
  fixture: NativeRestoreFixture,
  entryId: string,
  name: string,
  sql: string,
  dependencies: readonly string[] = ['schema'],
): RestoreArchiveEntry {
  return {
    entryId,
    archiveIdentity: `table:${fixture.schema}:${name}`,
    objectType: 'table',
    section: 'pre-data',
    objectIdentity: `${fixture.schema}.${name}`,
    dependencyEntryIds: dependencies,
    operation: {
      kind: 'sql',
      sql,
      target: { kind: 'table', schema: fixture.schema, name },
      transactionRequirement: 'allowed',
      privilegeRequirements: [],
    },
    description: `Create ${name}.`,
    diagnostics: [],
  };
}

describe('native PostgreSQL restore resilience', () => {
  it('rolls back all earlier work when a later single-transaction step fails', async () => {
    const fixture = await NativeRestoreFixture.create('native_rollback');
    const entries = [
      schemaEntry(fixture),
      tableEntry(
        fixture,
        'good-table',
        'good_items',
        `CREATE TABLE ${fixture.qualified('good_items')} (id integer PRIMARY KEY)`,
      ),
      tableEntry(
        fixture,
        'bad-table',
        'bad_items',
        `CREATE TABLE ${fixture.qualified('bad_items')} (value type_that_does_not_exist)`,
        ['good-table'],
      ),
    ];
    try {
      const result = await createRestoreEngine().restore({
        archive: new InMemoryRestoreArchiveSource({
          metadata: fixture.metadata('rollback'),
          entries,
        }),
        target: fixture.target,
        options: { transactionMode: 'single', validationLevel: 'none' },
      });
      expect(result.status).toBe('failed');
      expect(result.failedStepCount).toBe(1);
      expect(await fixture.relationExists('good_items')).toBe(false);
      expect(await fixture.relationExists('bad_items')).toBe(false);
      expect(await fixture.target.getTransactionStatus()).toBe('idle');
      await expect(fixture.client.query('SELECT 1')).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await fixture.close();
    }
  });

  it('continues independent entries and skips dependants after an entry failure', async () => {
    const fixture = await NativeRestoreFixture.create('native_continue');
    const goodTable = tableEntry(
      fixture,
      'good-table',
      'good_items',
      `CREATE TABLE ${fixture.qualified('good_items')} (id integer PRIMARY KEY, value text)`,
    );
    const entries: readonly RestoreArchiveEntry[] = [
      schemaEntry(fixture),
      tableEntry(
        fixture,
        'bad-table',
        'bad_items',
        `CREATE TABLE ${fixture.qualified('bad_items')} (value type_that_does_not_exist)`,
      ),
      {
        entryId: 'bad-dependent-index',
        archiveIdentity: `index:${fixture.schema}:bad_items_idx`,
        objectType: 'index',
        section: 'post-data',
        objectIdentity: `${fixture.schema}.bad_items_idx`,
        dependencyEntryIds: ['bad-table'],
        operation: {
          kind: 'sql',
          sql: `CREATE INDEX bad_items_idx ON ${fixture.qualified('bad_items')} (value)`,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        description: 'This index must be skipped.',
        diagnostics: [],
      },
      goodTable,
      {
        entryId: 'good-data',
        archiveIdentity: `table-data:${fixture.schema}:good_items`,
        objectType: 'table-data',
        section: 'data',
        objectIdentity: `${fixture.schema}.good_items`,
        dependencyEntryIds: ['good-table'],
        operation: {
          kind: 'table-data',
          table: { schema: fixture.schema, table: 'good_items' },
          columns: ['id', 'value'],
          format: 'copy-text',
          copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          dataSourceId: 'good-data',
          estimatedRows: 1,
          identityBehavior: 'preserve',
          partitionBehavior: 'target-table',
          transactionRequirement: 'allowed',
        },
        description: 'Load the independent table.',
        diagnostics: [],
      },
    ];
    try {
      const result = await createRestoreEngine().restore({
        archive: new InMemoryRestoreArchiveSource({
          metadata: fixture.metadata('continue'),
          entries,
          data: new Map([['good-data', '1\tindependent\n']]),
        }),
        target: fixture.target,
        options: {
          transactionMode: 'entry',
          errorMode: 'continue',
          validationLevel: 'none',
        },
      });
      expect(result.status, restoreFailureContext(result)).toBe('partial');
      expect(result.failedStepCount).toBe(1);
      expect(result.skippedStepCount).toBeGreaterThanOrEqual(1);
      expect(await fixture.relationExists('bad_items')).toBe(false);
      expect(await fixture.relationExists('good_items')).toBe(true);
      const rows = await fixture.client.query<{ id: number; value: string }>(
        `SELECT id, value FROM ${fixture.qualified('good_items')} ORDER BY id`,
      );
      expect(rows.rows).toEqual([{ id: 1, value: 'independent' }]);
      expect(await fixture.target.getTransactionStatus()).toBe('idle');
    } finally {
      await fixture.close();
    }
  });

  it('reports invalid COPY rows and rolls back the target without leaking a transaction', async () => {
    const fixture = await NativeRestoreFixture.create('native_invalid_copy');
    const table = tableEntry(
      fixture,
      'table',
      'typed_items',
      `CREATE TABLE ${fixture.qualified('typed_items')} (id integer NOT NULL, value text)`,
    );
    const entries: readonly RestoreArchiveEntry[] = [
      schemaEntry(fixture),
      table,
      {
        entryId: 'invalid-data',
        archiveIdentity: `table-data:${fixture.schema}:typed_items`,
        objectType: 'table-data',
        section: 'data',
        objectIdentity: `${fixture.schema}.typed_items`,
        dependencyEntryIds: ['table'],
        operation: {
          kind: 'table-data',
          table: { schema: fixture.schema, table: 'typed_items' },
          columns: ['id', 'value'],
          format: 'copy-text',
          copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          dataSourceId: 'invalid-data',
          estimatedRows: 1,
          identityBehavior: 'preserve',
          partitionBehavior: 'target-table',
          transactionRequirement: 'allowed',
        },
        description: 'Deliberately invalid integer COPY payload.',
        diagnostics: [],
      },
    ];
    const source = new InMemoryRestoreArchiveSource({
      metadata: fixture.metadata('invalid-copy'),
      entries,
      data: new Map([['invalid-data', 'not-an-integer\tbad\n']]),
    });

    try {
      const result = await createRestoreEngine().restore({
        archive: source,
        target: fixture.target,
        options: { transactionMode: 'single', validationLevel: 'none' },
      });
      expect(result.status).toBe('failed');
      expect(result.failedStepCount).toBe(1);
      expect(result.tableDataFailedCount).toBe(1);
      expect(await fixture.relationExists('typed_items')).toBe(false);
      expect(await fixture.target.getTransactionStatus()).toBe('idle');
      expect(source.closed).toBe(true);
      await expect(fixture.client.query('SELECT 1')).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await fixture.close();
    }
  });

  it('cancels an active COPY, rolls back, and leaves no misleading partial target', async () => {
    const fixture = await NativeRestoreFixture.create('native_cancel');
    const controller = new AbortController();
    const progress: RestoreProgressEvent[] = [];
    let openedStream: Readable | undefined;
    const table = tableEntry(
      fixture,
      'table',
      'large_items',
      `CREATE TABLE ${fixture.qualified('large_items')} (id integer, value text)`,
    );
    const entries: readonly RestoreArchiveEntry[] = [
      schemaEntry(fixture),
      table,
      {
        entryId: 'large-data',
        archiveIdentity: `table-data:${fixture.schema}:large_items`,
        objectType: 'table-data',
        section: 'data',
        objectIdentity: `${fixture.schema}.large_items`,
        dependencyEntryIds: ['table'],
        operation: {
          kind: 'table-data',
          table: { schema: fixture.schema, table: 'large_items' },
          columns: ['id', 'value'],
          format: 'copy-text',
          copyText: CANONICAL_RESTORE_COPY_TEXT_FORMAT,
          dataSourceId: 'large-data',
          identityBehavior: 'preserve',
          partitionBehavior: 'target-table',
          transactionRequirement: 'allowed',
        },
        description: 'Cancellation COPY payload.',
        diagnostics: [],
      },
    ];
    const source = new InMemoryRestoreArchiveSource({
      metadata: fixture.metadata('cancellation'),
      entries,
      data: new Map([
        [
          'large-data',
          () => {
            openedStream = Readable.from(
              (function* (): Generator<string> {
                for (let index = 0; index < 100_000; index += 1) {
                  yield `${String(index)}\t${'x'.repeat(256)}\n`;
                }
              })(),
            );
            return openedStream;
          },
        ],
      ]),
    });

    try {
      const result = await createRestoreEngine().restore({
        archive: source,
        target: fixture.target,
        options: { transactionMode: 'single', validationLevel: 'none' },
        signal: controller.signal,
        onProgress: (event) => {
          progress.push(event);
          if (event.event === 'copy-started') controller.abort(new Error('test cancellation'));
        },
      });
      expect(result.status).toBe('cancelled');
      expect(progress.some((event) => event.event === 'copy-started')).toBe(true);
      expect(progress.some((event) => event.event === 'copy-completed')).toBe(false);
      expect(await fixture.relationExists('large_items')).toBe(false);
      expect(await fixture.target.getTransactionStatus()).toBe('idle');
      expect(source.closed).toBe(true);
      expect(openedStream?.destroyed).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
