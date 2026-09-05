import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, CURRENT_SCHEMA_VERSION } from "../../src/storage/sqlite.js";
import { ProvenanceRepository, type ProvenanceRecord } from "../../src/storage/provenance-repo.js";

describe("SQLite Provenance Repository", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "livesync-provenance-test-"));
    dbPath = path.join(tempDir, "state.sqlite");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("ensures schema version is at least 2 and file_provenance table exists", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
    const db = openDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("schema_migrations");
    expect(names).toContain("remote_admission");
    expect(names).toContain("file_provenance");
    db.close();
  });

  it("saves and retrieves a provenance record with full round-trip verification", () => {
    const db = openDatabase(dbPath);
    const repo = new ProvenanceRepository(db);

    const record: ProvenanceRecord = {
      path: "folder/Note.md",
      remoteRevision: "1-abc123456789",
      contentSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      observedMtime: 1700000000000,
      remoteFingerprint: "fingerprint-123456",
      reflectedAt: new Date().toISOString(),
    };

    repo.saveProvenance(record);

    const retrieved = repo.getByPath(record.path);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.path).toBe(record.path);
    expect(retrieved?.remoteRevision).toBe(record.remoteRevision);
    expect(retrieved?.contentSha256).toBe(record.contentSha256);
    expect(retrieved?.observedMtime).toBe(record.observedMtime);
    expect(retrieved?.remoteFingerprint).toBe(record.remoteFingerprint);
    expect(retrieved?.reflectedAt).toBe(record.reflectedAt);

    // Non-existent path returns null
    expect(repo.getByPath("nonexistent.md")).toBeNull();

    db.close();
  });

  it("handles null observedMtime correctly", () => {
    const db = openDatabase(dbPath);
    const repo = new ProvenanceRepository(db);

    const record: ProvenanceRecord = {
      path: "NullMtime.md",
      remoteRevision: "2-rev",
      contentSha256: "hash123",
      observedMtime: null,
      remoteFingerprint: "fp",
      reflectedAt: new Date().toISOString(),
    };

    repo.saveProvenance(record);
    const retrieved = repo.getByPath("NullMtime.md");
    expect(retrieved?.observedMtime).toBeNull();

    db.close();
  });

  it("upserts provenance record on revision change", () => {
    const db = openDatabase(dbPath);
    const repo = new ProvenanceRepository(db);

    const initial: ProvenanceRecord = {
      path: "Update.md",
      remoteRevision: "1-first",
      contentSha256: "hash1",
      observedMtime: 1000,
      remoteFingerprint: "fp1",
      reflectedAt: "2026-01-01T00:00:00.000Z",
    };

    repo.saveProvenance(initial);

    const updated: ProvenanceRecord = {
      path: "Update.md",
      remoteRevision: "2-second",
      contentSha256: "hash2",
      observedMtime: 2000,
      remoteFingerprint: "fp1",
      reflectedAt: "2026-01-02T00:00:00.000Z",
    };

    repo.saveProvenance(updated);

    const retrieved = repo.getByPath("Update.md");
    expect(retrieved?.remoteRevision).toBe("2-second");
    expect(retrieved?.contentSha256).toBe("hash2");
    expect(retrieved?.observedMtime).toBe(2000);
    expect(retrieved?.reflectedAt).toBe("2026-01-02T00:00:00.000Z");

    db.close();
  });

  it("strictly excludes secrets, passwords, passphrases, or plaintext bodies from columns", () => {
    const db = openDatabase(dbPath);
    const repo = new ProvenanceRepository(db);

    const record: ProvenanceRecord = {
      path: "SecretCheck.md",
      remoteRevision: "1-rev",
      contentSha256: "sha256-only-no-body",
      observedMtime: 123456,
      remoteFingerprint: "fp-check",
      reflectedAt: new Date().toISOString(),
    };

    repo.saveProvenance(record);

    const columns = db.prepare("PRAGMA table_info('file_provenance');").all() as {
      name: string;
    }[];
    const columnNames = columns.map((c) => c.name.toLowerCase());

    expect(columnNames).not.toContain("password");
    expect(columnNames).not.toContain("passphrase");
    expect(columnNames).not.toContain("secret");
    expect(columnNames).not.toContain("authorization");
    expect(columnNames).not.toContain("body");
    expect(columnNames).not.toContain("content");
    expect(columnNames).not.toContain("data");

    db.close();
  });
});
