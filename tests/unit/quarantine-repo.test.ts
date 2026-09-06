import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, CURRENT_SCHEMA_VERSION } from "../../src/storage/sqlite.js";
import { QuarantineRepository, type QuarantineRecord } from "../../src/storage/quarantine-repo.js";

describe("SQLite Quarantine Repository", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "livesync-quarantine-test-"));
    dbPath = path.join(tempDir, "state.sqlite");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("ensures schema version is at least 4 and quarantine table exists with proper indexes", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    const db = openDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("schema_migrations");
    expect(names).toContain("quarantine");

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index';")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_quarantine_path");

    db.close();
  });

  it("saves and retrieves quarantine records by original path in descending ID order", () => {
    const db = openDatabase(dbPath);
    const repo = new QuarantineRepository(db);

    const rec1: QuarantineRecord = {
      originalPath: "folder/test.md",
      quarantinePath: "/data/quarantine/2026-09-06_12345678/folder/test.md",
      remoteRevision: "1-abc",
      contentSha256: "hash111",
      reason: "REMOTE_DELETION",
      quarantinedAt: "2026-09-06T00:00:00.000Z",
    };

    const id1 = repo.saveQuarantine(rec1);
    expect(id1).toBeGreaterThan(0);

    const rec2: QuarantineRecord = {
      originalPath: "folder/test.md",
      quarantinePath: "/data/quarantine/2026-09-06_87654321/folder/test.md",
      remoteRevision: "2-def",
      contentSha256: "hash222",
      reason: "DIVERGENT_DISPLACEMENT",
      quarantinedAt: "2026-09-06T01:00:00.000Z",
    };

    const id2 = repo.saveQuarantine(rec2);
    expect(id2).toBeGreaterThan(id1);

    const results = repo.listByOriginalPath("folder/test.md");
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(id2);
    expect(results[0].reason).toBe("DIVERGENT_DISPLACEMENT");
    expect(results[0].remoteRevision).toBe("2-def");
    expect(results[1].id).toBe(id1);
    expect(results[1].reason).toBe("REMOTE_DELETION");

    expect(repo.listByOriginalPath("nonexistent.md")).toEqual([]);

    db.close();
  });

  it("handles null remoteRevision correctly", () => {
    const db = openDatabase(dbPath);
    const repo = new QuarantineRepository(db);

    const rec: QuarantineRecord = {
      originalPath: "nullrev.md",
      quarantinePath: "/data/quarantine/nullrev.md",
      remoteRevision: null,
      contentSha256: "hashnull",
      reason: "REMOTE_DELETION",
      quarantinedAt: new Date().toISOString(),
    };

    repo.saveQuarantine(rec);
    const list = repo.listByOriginalPath("nullrev.md");
    expect(list).toHaveLength(1);
    expect(list[0].remoteRevision).toBeNull();

    db.close();
  });

  it("strictly excludes secrets, passwords, passphrases, or plaintext bodies from quarantine table columns", () => {
    const db = openDatabase(dbPath);

    const columns = db.prepare("PRAGMA table_info('quarantine');").all() as {
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
