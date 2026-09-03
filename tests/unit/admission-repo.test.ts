import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/storage/sqlite.js';
import { AdmissionRepository, type AdmissionRecord } from '../../src/storage/admission-repo.js';

describe('SQLite Admission Repository', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livesync-test-sqlite-'));
    dbPath = path.join(tempDir, 'state.sqlite');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('initializes SQLite database, runs migrations, and creates WAL mode', () => {
    const db = openDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('schema_migrations');
    expect(names).toContain('remote_admission');
    db.close();
  });

  it('saves and retrieves an admission record with full metadata', () => {
    const db = openDatabase(dbPath);
    const repo = new AdmissionRepository(db);

    const record: AdmissionRecord = {
      remoteFingerprint: 'f00ba4'.repeat(10) + '1234',
      couchdbUrl: 'http://127.0.0.1:5984',
      databaseName: 'my-vault',
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-v',
      milestoneRev: '2-m',
      syncParamsRev: '3-p',
      negotiatedSettingsHash: 'hash-abc-123',
      negotiatedSettingsJson: JSON.stringify({ chunkSize: 100 }),
      updateSeq: '42-g1AAAA',
      admittedAt: new Date().toISOString(),
    };

    repo.saveAdmission(record);

    const retrieved = repo.getAdmissionByFingerprint(record.remoteFingerprint);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.remoteFingerprint).toBe(record.remoteFingerprint);
    expect(retrieved?.couchdbUrl).toBe(record.couchdbUrl);
    expect(retrieved?.databaseName).toBe(record.databaseName);
    expect(retrieved?.syncParamsRev).toBe('3-p');
    expect(retrieved?.negotiatedSettingsHash).toBe('hash-abc-123');

    expect(repo.hasMatchingAdmission(record.remoteFingerprint, 'hash-abc-123')).toBe(true);
    expect(repo.hasMatchingAdmission(record.remoteFingerprint, 'different-hash')).toBe(false);

    db.close();
  });

  it('saves and retrieves an unencrypted database record where syncParamsRev is null', () => {
    const db = openDatabase(dbPath);
    const repo = new AdmissionRepository(db);

    const record: AdmissionRecord = {
      remoteFingerprint: 'unencrypted-fprint-123',
      couchdbUrl: 'http://127.0.0.1:5984',
      databaseName: 'unencrypted-vault',
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-v',
      milestoneRev: '1-m',
      syncParamsRev: null,
      negotiatedSettingsHash: 'hash-plain-456',
      negotiatedSettingsJson: JSON.stringify({}),
      updateSeq: '1-g1AAAA',
      admittedAt: new Date().toISOString(),
    };

    repo.saveAdmission(record);

    const retrieved = repo.getAdmissionByFingerprint(record.remoteFingerprint);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.syncParamsRev).toBeNull();
    db.close();
  });

  it('upserts an admission record when remote state updates', () => {
    const db = openDatabase(dbPath);
    const repo = new AdmissionRepository(db);

    const fingerprint = 'upsert-fingerprint';
    const initialRecord: AdmissionRecord = {
      remoteFingerprint: fingerprint,
      couchdbUrl: 'http://127.0.0.1:5984',
      databaseName: 'my-vault',
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-v',
      milestoneRev: '1-m',
      syncParamsRev: null,
      negotiatedSettingsHash: 'hash-v1',
      negotiatedSettingsJson: JSON.stringify({ v: 1 }),
      updateSeq: '10',
      admittedAt: new Date(100000).toISOString(),
    };

    repo.saveAdmission(initialRecord);

    const updatedRecord: AdmissionRecord = {
      ...initialRecord,
      milestoneRev: '2-m',
      updateSeq: '20',
      negotiatedSettingsHash: 'hash-v2',
    };

    repo.saveAdmission(updatedRecord);

    const retrieved = repo.getAdmissionByFingerprint(fingerprint);
    expect(retrieved?.milestoneRev).toBe('2-m');
    expect(retrieved?.updateSeq).toBe('20');
    expect(retrieved?.negotiatedSettingsHash).toBe('hash-v2');
    db.close();
  });

  it('strictly excludes secrets, passwords, or passphrases from stored tables and columns', () => {
    const db = openDatabase(dbPath);
    const repo = new AdmissionRepository(db);

    const secretPassword = 'SUPER_SECRET_COUCHDB_PASSWORD';
    const secretPassphrase = 'SUPER_SECRET_E2EE_PASSPHRASE';

    const record: AdmissionRecord = {
      remoteFingerprint: 'fprint-safe-check',
      couchdbUrl: 'http://127.0.0.1:5984', // URL without userinfo
      databaseName: 'safe-vault',
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-v',
      milestoneRev: '1-m',
      syncParamsRev: '1-p',
      negotiatedSettingsHash: 'safe-hash',
      negotiatedSettingsJson: JSON.stringify({ hashAlg: 'sha256' }),
      updateSeq: '5',
      admittedAt: new Date().toISOString(),
    };

    repo.saveAdmission(record);

    // Inspect columns of remote_admission
    const columns = db.prepare("PRAGMA table_info('remote_admission');").all() as {
      name: string;
    }[];
    const columnNames = columns.map((c) => c.name.toLowerCase());

    expect(columnNames).not.toContain('password');
    expect(columnNames).not.toContain('passphrase');
    expect(columnNames).not.toContain('secret');
    expect(columnNames).not.toContain('authorization');

    // Query entire row as string
    const row = db
      .prepare('SELECT * FROM remote_admission WHERE remote_fingerprint = ?')
      .get(record.remoteFingerprint);
    const rowString = JSON.stringify(row);

    expect(rowString).not.toContain(secretPassword);
    expect(rowString).not.toContain(secretPassphrase);

    db.close();
  });
});
