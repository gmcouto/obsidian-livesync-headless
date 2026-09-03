import type { DatabaseSync } from 'node:sqlite';

export interface AdmissionRecord {
  readonly remoteFingerprint: string;
  readonly couchdbUrl: string;
  readonly databaseName: string;
  readonly couchdbVersion: string;
  readonly versionInfoRev: string;
  readonly milestoneRev: string;
  readonly syncParamsRev: string | null;
  readonly negotiatedSettingsHash: string;
  readonly negotiatedSettingsJson: string;
  readonly updateSeq: string;
  readonly admittedAt: string;
}

export class AdmissionRepository {
  constructor(private readonly db: DatabaseSync) {}

  saveAdmission(record: AdmissionRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO remote_admission (
        remote_fingerprint,
        couchdb_url,
        database_name,
        couchdb_version,
        version_info_rev,
        milestone_rev,
        sync_params_rev,
        negotiated_settings_hash,
        negotiated_settings_json,
        update_seq,
        admitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(remote_fingerprint) DO UPDATE SET
        couchdb_url = excluded.couchdb_url,
        database_name = excluded.database_name,
        couchdb_version = excluded.couchdb_version,
        version_info_rev = excluded.version_info_rev,
        milestone_rev = excluded.milestone_rev,
        sync_params_rev = excluded.sync_params_rev,
        negotiated_settings_hash = excluded.negotiated_settings_hash,
        negotiated_settings_json = excluded.negotiated_settings_json,
        update_seq = excluded.update_seq,
        admitted_at = excluded.admitted_at;
    `);

    stmt.run(
      record.remoteFingerprint,
      record.couchdbUrl,
      record.databaseName,
      record.couchdbVersion,
      record.versionInfoRev,
      record.milestoneRev,
      record.syncParamsRev ?? null,
      record.negotiatedSettingsHash,
      record.negotiatedSettingsJson,
      record.updateSeq,
      record.admittedAt
    );
  }

  getAdmissionByFingerprint(fingerprint: string): AdmissionRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        remote_fingerprint,
        couchdb_url,
        database_name,
        couchdb_version,
        version_info_rev,
        milestone_rev,
        sync_params_rev,
        negotiated_settings_hash,
        negotiated_settings_json,
        update_seq,
        admitted_at
      FROM remote_admission
      WHERE remote_fingerprint = ?
    `);

    const row = stmt.get(fingerprint) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    return {
      remoteFingerprint: String(row.remote_fingerprint),
      couchdbUrl: String(row.couchdb_url),
      databaseName: String(row.database_name),
      couchdbVersion: String(row.couchdb_version),
      versionInfoRev: String(row.version_info_rev),
      milestoneRev: String(row.milestone_rev),
      syncParamsRev: row.sync_params_rev ? String(row.sync_params_rev) : null,
      negotiatedSettingsHash: String(row.negotiated_settings_hash),
      negotiatedSettingsJson: String(row.negotiated_settings_json),
      updateSeq: String(row.update_seq),
      admittedAt: String(row.admitted_at),
    };
  }

  hasMatchingAdmission(fingerprint: string, settingsHash: string): boolean {
    const stmt = this.db.prepare(`
      SELECT id FROM remote_admission
      WHERE remote_fingerprint = ? AND negotiated_settings_hash = ?
    `);
    return Boolean(stmt.get(fingerprint, settingsHash));
  }
}
