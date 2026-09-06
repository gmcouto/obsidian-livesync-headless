import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const CURRENT_SCHEMA_VERSION = 4;

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  const appliedVersions = new Set<number>(appliedRows.map((r) => r.version));

  // Migration 001: remote_admission table
  if (!appliedVersions.has(1)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS remote_admission (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_fingerprint TEXT NOT NULL UNIQUE,
        couchdb_url TEXT NOT NULL,
        database_name TEXT NOT NULL,
        couchdb_version TEXT NOT NULL,
        version_info_rev TEXT NOT NULL,
        milestone_rev TEXT NOT NULL,
        sync_params_rev TEXT,
        negotiated_settings_hash TEXT NOT NULL,
        negotiated_settings_json TEXT NOT NULL,
        update_seq TEXT NOT NULL,
        admitted_at TEXT NOT NULL
      );
    `);

    const stmt = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    );
    stmt.run(1, new Date().toISOString());
  }

  // Migration 002: file_provenance table (exact remote revision after verified reflection)
  if (!appliedVersions.has(2)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_provenance (
        path TEXT PRIMARY KEY,
        remote_revision TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        observed_mtime INTEGER,
        remote_fingerprint TEXT NOT NULL,
        reflected_at TEXT NOT NULL
      );
    `);

    const stmt = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    );
    stmt.run(2, new Date().toISOString());
  }

  // Migration 003: quarantine table
  if (!appliedVersions.has(3)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_path TEXT NOT NULL,
        quarantine_path TEXT NOT NULL,
        remote_revision TEXT,
        content_sha256 TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quarantine_path ON quarantine(original_path);
    `);

    const stmt = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    );
    stmt.run(3, new Date().toISOString());
  }

  // Migration 004: pull_checkpoints table
  if (!appliedVersions.has(4)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pull_checkpoints (
        remote_fingerprint TEXT PRIMARY KEY,
        last_update_seq TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
    `);

    const stmt = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    );
    stmt.run(4, new Date().toISOString());
  }
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    const absolutePath = path.resolve(dbPath);
    const parentDir = path.dirname(absolutePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  runMigrations(db);

  return db;
}
