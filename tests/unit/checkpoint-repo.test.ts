import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, CURRENT_SCHEMA_VERSION } from "../../src/storage/sqlite.js";
import { CheckpointRepository, type CheckpointRecord } from "../../src/storage/checkpoint-repo.js";

describe("SQLite Checkpoint Repository", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "livesync-checkpoint-test-"));
    dbPath = path.join(tempDir, "state.sqlite");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("ensures schema version is 4 and pull_checkpoints table exists", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
    const db = openDatabase(dbPath);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("pull_checkpoints");
    db.close();
  });

  it("saves, retrieves, and upserts checkpoint records by remoteFingerprint", () => {
    const db = openDatabase(dbPath);
    const repo = new CheckpointRepository(db);

    expect(repo.getCheckpoint("fp-abc")).toBeNull();

    const record: CheckpointRecord = {
      remoteFingerprint: "fp-abc",
      lastUpdateSeq: "100-g1AAAA",
      completedAt: "2026-09-06T00:00:00.000Z",
    };

    repo.saveCheckpoint(record);

    const retrieved = repo.getCheckpoint("fp-abc");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.remoteFingerprint).toBe("fp-abc");
    expect(retrieved?.lastUpdateSeq).toBe("100-g1AAAA");
    expect(retrieved?.completedAt).toBe("2026-09-06T00:00:00.000Z");

    // Upsert
    const updated: CheckpointRecord = {
      remoteFingerprint: "fp-abc",
      lastUpdateSeq: "250-g2BBBB",
      completedAt: "2026-09-06T02:00:00.000Z",
    };

    repo.saveCheckpoint(updated);

    const retrievedUpdated = repo.getCheckpoint("fp-abc");
    expect(retrievedUpdated?.lastUpdateSeq).toBe("250-g2BBBB");
    expect(retrievedUpdated?.completedAt).toBe("2026-09-06T02:00:00.000Z");

    db.close();
  });
});
