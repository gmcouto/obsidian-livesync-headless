import type { DatabaseSync } from 'node:sqlite';

export interface QuarantineRecord {
  readonly id?: number;
  readonly originalPath: string;
  readonly quarantinePath: string;
  readonly remoteRevision: string | null;
  readonly contentSha256: string;
  readonly reason: 'REMOTE_DELETION' | 'DIVERGENT_DISPLACEMENT' | string;
  readonly quarantinedAt: string;
}

export class QuarantineRepository {
  constructor(private readonly db: DatabaseSync) {}

  saveQuarantine(record: Omit<QuarantineRecord, 'id'> | QuarantineRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO quarantine (
        original_path,
        quarantine_path,
        remote_revision,
        content_sha256,
        reason,
        quarantined_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      record.originalPath,
      record.quarantinePath,
      record.remoteRevision,
      record.contentSha256,
      record.reason,
      record.quarantinedAt
    );

    return Number(result.lastInsertRowid);
  }

  listByOriginalPath(originalPath: string): QuarantineRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        original_path,
        quarantine_path,
        remote_revision,
        content_sha256,
        reason,
        quarantined_at
      FROM quarantine
      WHERE original_path = ?
      ORDER BY id DESC
    `);

    const rows = stmt.all(originalPath) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      originalPath: String(row.original_path),
      quarantinePath: String(row.quarantine_path),
      remoteRevision:
        row.remote_revision === null || row.remote_revision === undefined
          ? null
          : String(row.remote_revision),
      contentSha256: String(row.content_sha256),
      reason: String(row.reason),
      quarantinedAt: String(row.quarantined_at),
    }));
  }
}
