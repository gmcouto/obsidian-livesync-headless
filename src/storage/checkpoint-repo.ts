import type { DatabaseSync } from 'node:sqlite';

export interface CheckpointRecord {
  readonly remoteFingerprint: string;
  readonly lastUpdateSeq: string;
  readonly completedAt: string;
}

export class CheckpointRepository {
  constructor(private readonly db: DatabaseSync) {}

  saveCheckpoint(record: CheckpointRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO pull_checkpoints (
        remote_fingerprint,
        last_update_seq,
        completed_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(remote_fingerprint) DO UPDATE SET
        last_update_seq = excluded.last_update_seq,
        completed_at = excluded.completed_at;
    `);

    stmt.run(record.remoteFingerprint, record.lastUpdateSeq, record.completedAt);
  }

  getCheckpoint(remoteFingerprint: string): CheckpointRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        remote_fingerprint,
        last_update_seq,
        completed_at
      FROM pull_checkpoints
      WHERE remote_fingerprint = ?
    `);

    const row = stmt.get(remoteFingerprint) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    return {
      remoteFingerprint: String(row.remote_fingerprint),
      lastUpdateSeq: String(row.last_update_seq),
      completedAt: String(row.completed_at),
    };
  }
}
