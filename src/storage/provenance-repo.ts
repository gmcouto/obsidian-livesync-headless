import type { DatabaseSync } from 'node:sqlite';

export interface ProvenanceRecord {
  readonly path: string;
  readonly remoteRevision: string;
  readonly contentSha256: string;
  readonly observedMtime: number | null;
  readonly remoteFingerprint: string;
  readonly reflectedAt: string;
}

export class ProvenanceRepository {
  constructor(private readonly db: DatabaseSync) {}

  saveProvenance(record: ProvenanceRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO file_provenance (
        path,
        remote_revision,
        content_sha256,
        observed_mtime,
        remote_fingerprint,
        reflected_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        remote_revision = excluded.remote_revision,
        content_sha256 = excluded.content_sha256,
        observed_mtime = excluded.observed_mtime,
        remote_fingerprint = excluded.remote_fingerprint,
        reflected_at = excluded.reflected_at;
    `);

    stmt.run(
      record.path,
      record.remoteRevision,
      record.contentSha256,
      record.observedMtime,
      record.remoteFingerprint,
      record.reflectedAt
    );
  }

  getByPath(path: string): ProvenanceRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        path,
        remote_revision,
        content_sha256,
        observed_mtime,
        remote_fingerprint,
        reflected_at
      FROM file_provenance
      WHERE path = ?
    `);

    let row = stmt.get(path) as Record<string, unknown> | undefined;
    if (!row) {
      const caseStmt = this.db.prepare(`
        SELECT
          path,
          remote_revision,
          content_sha256,
          observed_mtime,
          remote_fingerprint,
          reflected_at
        FROM file_provenance
        WHERE path = ? COLLATE NOCASE
      `);
      row = caseStmt.get(path) as Record<string, unknown> | undefined;
    }
    if (!row) {
      return null;
    }

    return {
      path: String(row.path),
      remoteRevision: String(row.remote_revision),
      contentSha256: String(row.content_sha256),
      observedMtime: row.observed_mtime === null || row.observed_mtime === undefined
        ? null
        : Number(row.observed_mtime),
      remoteFingerprint: String(row.remote_fingerprint),
      reflectedAt: String(row.reflected_at),
    };
  }

  deleteProvenance(path: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM file_provenance
      WHERE path = ?
    `);
    stmt.run(path);
  }

  getAllAsMap(): Map<string, ProvenanceRecord> {
    const stmt = this.db.prepare(`
      SELECT
        path,
        remote_revision,
        content_sha256,
        observed_mtime,
        remote_fingerprint,
        reflected_at
      FROM file_provenance
    `);

    const rows = stmt.all() as Record<string, unknown>[];
    const map = new Map<string, ProvenanceRecord>();

    for (const row of rows) {
      const record: ProvenanceRecord = {
        path: String(row.path),
        remoteRevision: String(row.remote_revision),
        contentSha256: String(row.content_sha256),
        observedMtime:
          row.observed_mtime === null || row.observed_mtime === undefined
            ? null
            : Number(row.observed_mtime),
        remoteFingerprint: String(row.remote_fingerprint),
        reflectedAt: String(row.reflected_at),
      };
      map.set(record.path, record);
    }

    return map;
  }
}
