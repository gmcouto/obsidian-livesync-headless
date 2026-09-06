import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/storage/sqlite.js';
import { WriteGrantRepo, type WriteGrantBinding } from '../../src/storage/write-grant-repo.js';

describe('WriteGrantRepo', () => {
  let db: DatabaseSync;
  let repo: WriteGrantRepo;

  const validBinding: WriteGrantBinding = {
    remoteFingerprint: 'couchdb-fp-12345',
    vaultRoot: '/home/user/vault',
    settingsHash: 'hash-abcde',
    commonlibVersion: '0.1.21',
    bootstrapGeneration: 'gen-001',
  };

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    repo = new WriteGrantRepo(db);
  });

  it('issues a grant and retrieves active grant', () => {
    const grant = repo.issueGrant(validBinding);

    expect(grant.grantId).toBeDefined();
    expect(grant.remoteFingerprint).toBe(validBinding.remoteFingerprint);
    expect(grant.vaultRoot).toBe(validBinding.vaultRoot);
    expect(grant.settingsHash).toBe(validBinding.settingsHash);
    expect(grant.commonlibVersion).toBe(validBinding.commonlibVersion);
    expect(grant.bootstrapGeneration).toBe(validBinding.bootstrapGeneration);
    expect(grant.revoked).toBe(false);

    const active = repo.getActiveGrant(validBinding.remoteFingerprint, validBinding.vaultRoot);
    expect(active).not.toBeNull();
    expect(active?.grantId).toBe(grant.grantId);
  });

  it('verifies valid grant when all 5 tuples match', () => {
    const grant = repo.issueGrant(validBinding);
    const result = repo.verifyGrantBinding(grant.grantId, validBinding);

    expect(result.valid).toBe(true);
    expect(result.grant?.revoked).toBe(false);
  });

  it('auto-revokes grant when remoteFingerprint drifts', () => {
    const grant = repo.issueGrant(validBinding);
    const result = repo.verifyGrantBinding(grant.grantId, {
      ...validBinding,
      remoteFingerprint: 'different-fingerprint',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Remote fingerprint drift');

    const updated = repo.getGrantById(grant.grantId);
    expect(updated?.revoked).toBe(true);
    expect(updated?.revocationReason).toContain('Remote fingerprint drift');

    expect(repo.getActiveGrant(validBinding.remoteFingerprint, validBinding.vaultRoot)).toBeNull();
  });

  it('auto-revokes grant when vaultRoot drifts', () => {
    const grant = repo.issueGrant(validBinding);
    const result = repo.verifyGrantBinding(grant.grantId, {
      ...validBinding,
      vaultRoot: '/home/user/different-vault',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Vault root drift');

    const updated = repo.getGrantById(grant.grantId);
    expect(updated?.revoked).toBe(true);
  });

  it('auto-revokes grant when settingsHash drifts', () => {
    const grant = repo.issueGrant(validBinding);
    const result = repo.verifyGrantBinding(grant.grantId, {
      ...validBinding,
      settingsHash: 'different-hash',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Settings hash drift');

    const updated = repo.getGrantById(grant.grantId);
    expect(updated?.revoked).toBe(true);
  });

  it('auto-revokes grant when commonlibVersion drifts', () => {
    const grant = repo.issueGrant(validBinding);
    const result = repo.verifyGrantBinding(grant.grantId, {
      ...validBinding,
      commonlibVersion: '0.1.22',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Commonlib version drift');

    const updated = repo.getGrantById(grant.grantId);
    expect(updated?.revoked).toBe(true);
  });

  it('auto-revokes grant when bootstrapGeneration drifts', () => {
    const grant = repo.issueGrant(validBinding);
    const result = repo.verifyGrantBinding(grant.grantId, {
      ...validBinding,
      bootstrapGeneration: 'gen-002',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Bootstrap generation drift');

    const updated = repo.getGrantById(grant.grantId);
    expect(updated?.revoked).toBe(true);
  });

  it('supports explicit revocation of a grant', () => {
    const grant = repo.issueGrant(validBinding);
    repo.revokeGrant(grant.grantId, 'Explicitly revoked by test');

    const updated = repo.getGrantById(grant.grantId);
    expect(updated?.revoked).toBe(true);
    expect(updated?.revocationReason).toBe('Explicitly revoked by test');

    const result = repo.verifyGrantBinding(grant.grantId, validBinding);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('already revoked');
  });

  it('supports revoking active grants for a vault root', () => {
    const grant1 = repo.issueGrant(validBinding);
    repo.revokeActiveGrantsForVault(validBinding.vaultRoot, 'Vault unmounted');

    const updated = repo.getGrantById(grant1.grantId);
    expect(updated?.revoked).toBe(true);
    expect(updated?.revocationReason).toBe('Vault unmounted');
  });
});
