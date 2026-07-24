import { describe, expect, it } from 'vitest';

import {
  buildAclSql,
  buildCommentSql,
  buildDefaultPrivilegeSql,
  buildOwnershipSql,
  normalizeRestoreOptions,
  RESTORE_ARCHIVE_FORMAT,
  RESTORE_ARCHIVE_FORMAT_VERSION,
  resolveRestoreRole,
  type RestoreArchiveEntry,
  type RestoreArchiveMetadata,
  type RestoreTargetSnapshot,
} from '../../src/index.js';
import { RestorePlanner } from '../../src/restore/RestorePlanner.js';
import { RestorePreflightAnalyzer } from '../../src/restore/RestorePreflight.js';

const target = {
  roles: ['runner', 'Mapped "owner'],
  setRoleTargets: ['runner', 'Mapped "owner'],
  currentUser: {
    name: 'runner',
    superuser: false,
    createRole: false,
    createDatabase: false,
  },
} as unknown as RestoreTargetSnapshot;

describe('native restore finalization', () => {
  it('resolves PUBLIC, mapped, current-user, omitted, and missing roles deterministically', () => {
    const context = {
      target,
      mappings: [
        {
          kind: 'role' as const,
          sourceRole: 'source',
          action: 'map' as const,
          targetRole: 'Mapped "owner',
        },
        { kind: 'role' as const, sourceRole: 'gone', action: 'omit' as const },
      ],
      missingRolePolicy: 'map-to-current-user' as const,
    };

    expect(resolveRestoreRole('PUBLIC', context).status).toBe('public');
    expect(resolveRestoreRole('source', context)).toMatchObject({
      status: 'mapped',
      targetRole: 'Mapped "owner',
    });
    expect(resolveRestoreRole('missing', context)).toMatchObject({
      status: 'current-user',
      targetRole: 'runner',
    });
    expect(resolveRestoreRole('gone', context).status).toBe('omitted');
  });

  it('quotes ownership and preserves comment edge cases', () => {
    const owner = {
      status: 'mapped' as const,
      sourceRole: 'source',
      targetRole: 'Mapped "owner',
    };
    expect(
      buildOwnershipSql(
        {
          kind: 'ownership',
          target: { kind: 'table', schema: 'Odd schema', name: 'Table "one' },
          owner: 'source',
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
        owner,
      ).statements,
    ).toEqual(['ALTER TABLE "Odd schema"."Table ""one" OWNER TO "Mapped ""owner"']);

    expect(
      buildCommentSql({
        kind: 'comment',
        target: { kind: 'schema', name: 'Odd schema' },
        text: "line one\nO'Brien 🦊",
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      }).statements[0],
    ).toBe(`COMMENT ON SCHEMA "Odd schema" IS 'line one\nO''Brien 🦊'`);
    expect(
      buildCommentSql({
        kind: 'comment',
        target: { kind: 'schema', name: 'Odd schema' },
        text: '',
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      }).statements[0],
    ).toBe(`COMMENT ON SCHEMA "Odd schema" IS ''`);
  });

  it('renders PUBLIC, column grants, revocations, default privileges, and grantor switching', () => {
    const publicRole = resolveRestoreRole('PUBLIC', {
      target,
      mappings: [],
      missingRolePolicy: 'error',
    });
    const runner = resolveRestoreRole('runner', {
      target,
      mappings: [],
      missingRolePolicy: 'error',
    });
    const acl = buildAclSql(
      {
        kind: 'acl',
        target: {
          kind: 'column',
          name: 'value',
          subName: 'Odd "column',
          parent: { kind: 'table', schema: 'app', name: 'items' },
        },
        grantee: 'PUBLIC',
        grantor: 'runner',
        privilege: 'select',
        grantOption: true,
        action: 'grant',
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
      publicRole,
      runner,
      'preserve-when-possible',
    );
    expect(acl.statements).toEqual([
      'GRANT SELECT ("Odd ""column") ON TABLE "app"."items" TO PUBLIC WITH GRANT OPTION',
    ]);
    expect(acl.executeAsRole).toBe('runner');

    const defaults = buildDefaultPrivilegeSql(
      {
        kind: 'default-privilege',
        owner: 'runner',
        schema: 'app',
        objectType: 'table',
        grantee: 'PUBLIC',
        privilege: 'select',
        grantOption: false,
        action: 'revoke',
        transactionRequirement: 'allowed',
        privilegeRequirements: [],
      },
      runner,
      publicRole,
      undefined,
      'use-current-user',
    );
    expect(defaults.statements).toEqual([
      'ALTER DEFAULT PRIVILEGES FOR ROLE "runner" IN SCHEMA "app" REVOKE SELECT ON TABLES FROM PUBLIC',
    ]);
  });

  it('plans dedicated ordered finalization steps instead of generic SQL steps', () => {
    const metadata: RestoreArchiveMetadata = {
      format: RESTORE_ARCHIVE_FORMAT,
      formatVersion: RESTORE_ARCHIVE_FORMAT_VERSION,
      archiveId: 'finalization-plan',
      sourceVersion: {
        complete: 'PostgreSQL 18',
        number: 180000,
        normalizedMajor: '18',
        major: 18,
        minor: 0,
        patch: 0,
      },
      requiredExtensions: [],
      requiredRoles: [],
      requiredPrivileges: [],
      requiredTablespaces: [],
      transactionCompatibility: 'compatible',
      diagnostics: [],
    };
    const base = {
      section: 'post-data' as const,
      dependencyEntryIds: [],
      diagnostics: [],
    };
    const entries: RestoreArchiveEntry[] = [
      {
        ...base,
        entryId: 'acl',
        archiveIdentity: 'acl:app.items',
        objectType: 'acl',
        description: 'ACL',
        operation: {
          kind: 'acl',
          target: { kind: 'table', schema: 'app', name: 'items' },
          grantee: 'PUBLIC',
          grantor: 'runner',
          privilege: 'SELECT',
          grantOption: false,
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
      },
      {
        ...base,
        entryId: 'comment',
        archiveIdentity: 'comment:app.items',
        objectType: 'comment',
        description: 'Comment',
        operation: {
          kind: 'comment',
          target: { kind: 'table', schema: 'app', name: 'items' },
          text: 'hello',
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
      },
      {
        ...base,
        entryId: 'owner',
        archiveIdentity: 'ownership:app.items',
        objectType: 'ownership',
        description: 'Owner',
        operation: {
          kind: 'ownership',
          target: { kind: 'table', schema: 'app', name: 'items' },
          owner: 'runner',
          transactionRequirement: 'allowed',
          privilegeRequirements: [],
        },
      },
    ];
    const fullTarget = {
      ...target,
      version: metadata.sourceVersion,
      serverCapabilities: {} as RestoreTargetSnapshot['serverCapabilities'],
      driverCapabilities: {
        parameterizedQueries: true,
        abortSignalCancellation: true,
        copyFromStdin: true,
        explicitCancellation: true,
        noticeReporting: false,
        identifierQuoting: 'library',
      } as const,
      clientEncoding: 'UTF8',
      schemas: ['app'],
      extensions: [],
      tablespaces: ['pg_default'],
    };
    const options = normalizeRestoreOptions({
      transactionMode: 'none',
      ownershipMode: 'preserve',
    });
    const preflight = new RestorePreflightAnalyzer().analyze(
      metadata,
      entries,
      fullTarget,
      options,
    );
    expect(preflight.canProceed).toBe(true);
    const plan = new RestorePlanner().createPlan(metadata, entries, preflight, options);
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'restore-ownership',
      'apply-comment',
      'apply-acl',
    ]);
  });
});
