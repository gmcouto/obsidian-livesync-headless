import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export interface WriteGrantBinding {
  readonly remoteFingerprint: string;
  readonly vaultRoot: string;
  readonly settingsHash: string;
  readonly commonlibVersion: string;
  readonly bootstrapGeneration: string;
}

export interface WriteGrantRecord extends WriteGrantBinding {
  readonly grantId: string;
  readonly issuedAt: string;
  readonly revoked: boolean;
  readonly revokedAt?: string | null;
  readonly revocationReason?: string | null;
}

export interface GrantVerificationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly grant?: WriteGrantRecord;
}

export class WriteGrantRepo {
  constructor(private readonly db: DatabaseSync) {}

  issueGrant(binding: WriteGrantBinding): WriteGrantRecord {
    this.revokeActiveGrantsForVault(
      binding.vaultRoot,
      'Superseded by newly issued write grant'
    );

    const grantId = crypto.randomUUID();
    const issuedAt = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO write_grants (
        grant_id,
        remote_fingerprint,
        vault_root,
        settings_hash,
        commonlib_version,
        bootstrap_generation,
        issued_at,
        revoked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `);

    stmt.run(
      grantId,
      binding.remoteFingerprint,
      binding.vaultRoot,
      binding.settingsHash,
      binding.commonlibVersion,
      binding.bootstrapGeneration,
      issuedAt
    );

    return {
      grantId,
      ...binding,
      issuedAt,
      revoked: false,
      revokedAt: null,
      revocationReason: null,
    };
  }

  getGrantById(grantId: string): WriteGrantRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        grant_id,
        remote_fingerprint,
        vault_root,
        settings_hash,
        commonlib_version,
        bootstrap_generation,
        issued_at,
        revoked,
        revoked_at,
        revocation_reason
      FROM write_grants
      WHERE grant_id = ?
    `);

    const row = stmt.get(grantId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    return this.mapRowToRecord(row);
  }

  getActiveGrant(remoteFingerprint: string, vaultRoot: string): WriteGrantRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        grant_id,
        remote_fingerprint,
        vault_root,
        settings_hash,
        commonlib_version,
        bootstrap_generation,
        issued_at,
        revoked,
        revoked_at,
        revocation_reason
      FROM write_grants
      WHERE remote_fingerprint = ? AND vault_root = ? AND revoked = 0
      ORDER BY issued_at DESC
      LIMIT 1
    `);

    const row = stmt.get(remoteFingerprint, vaultRoot) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    return this.mapRowToRecord(row);
  }

  verifyGrantBinding(grantId: string, currentBinding: WriteGrantBinding): GrantVerificationResult {
    const grant = this.getGrantById(grantId);
    if (!grant) {
      return { valid: false, reason: `Write grant '${grantId}' not found.` };
    }

    if (grant.revoked) {
      return {
        valid: false,
        reason: `Write grant '${grantId}' was already revoked: ${grant.revocationReason ?? 'no reason given'}`,
        grant,
      };
    }

    // 5-tuple verification (CONF-07, CONF-08)
    if (grant.remoteFingerprint !== currentBinding.remoteFingerprint) {
      const reason = `Remote fingerprint drift detected (grant=${grant.remoteFingerprint}, current=${currentBinding.remoteFingerprint})`;
      this.revokeGrant(grantId, reason);
      return { valid: false, reason, grant: this.getGrantById(grantId)! };
    }

    if (grant.vaultRoot !== currentBinding.vaultRoot) {
      const reason = `Vault root drift detected (grant=${grant.vaultRoot}, current=${currentBinding.vaultRoot})`;
      this.revokeGrant(grantId, reason);
      return { valid: false, reason, grant: this.getGrantById(grantId)! };
    }

    if (grant.settingsHash !== currentBinding.settingsHash) {
      const reason = `Settings hash drift detected (grant=${grant.settingsHash}, current=${currentBinding.settingsHash})`;
      this.revokeGrant(grantId, reason);
      return { valid: false, reason, grant: this.getGrantById(grantId)! };
    }

    if (grant.commonlibVersion !== currentBinding.commonlibVersion) {
      const reason = `Commonlib version drift detected (grant=${grant.commonlibVersion}, current=${currentBinding.commonlibVersion})`;
      this.revokeGrant(grantId, reason);
      return { valid: false, reason, grant: this.getGrantById(grantId)! };
    }

    if (grant.bootstrapGeneration !== currentBinding.bootstrapGeneration) {
      const reason = `Bootstrap generation drift detected (grant=${grant.bootstrapGeneration}, current=${currentBinding.bootstrapGeneration})`;
      this.revokeGrant(grantId, reason);
      return { valid: false, reason, grant: this.getGrantById(grantId)! };
    }

    return { valid: true, grant };
  }

  revokeGrant(grantId: string, reason: string): void {
    const stmt = this.db.prepare(`
      UPDATE write_grants
      SET
        revoked = 1,
        revoked_at = ?,
        revocation_reason = ?
      WHERE grant_id = ? AND revoked = 0
    `);

    stmt.run(new Date().toISOString(), reason, grantId);
  }

  revokeActiveGrantsForVault(vaultRoot: string, reason: string): void {
    const stmt = this.db.prepare(`
      UPDATE write_grants
      SET
        revoked = 1,
        revoked_at = ?,
        revocation_reason = ?
      WHERE vault_root = ? AND revoked = 0
    `);

    stmt.run(new Date().toISOString(), reason, vaultRoot);
  }

  private mapRowToRecord(row: Record<string, unknown>): WriteGrantRecord {
    return {
      grantId: String(row.grant_id),
      remoteFingerprint: String(row.remote_fingerprint),
      vaultRoot: String(row.vault_root),
      settingsHash: String(row.settings_hash),
      commonlibVersion: String(row.commonlib_version),
      bootstrapGeneration: String(row.bootstrap_generation),
      issuedAt: String(row.issued_at),
      revoked: Boolean(row.revoked),
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      revocationReason: row.revocation_reason ? String(row.revocation_reason) : null,
    };
  }
}
