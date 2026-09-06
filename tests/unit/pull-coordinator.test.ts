import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { applyVerifiedPull } from "../../src/cli/commands/pull.js";
import { createVaultReflectCapability } from "../../src/security/capabilities.js";
import { openDatabase } from "../../src/storage/sqlite.js";
import { ProvenanceRepository } from "../../src/storage/provenance-repo.js";
import { QuarantineRepository } from "../../src/storage/quarantine-repo.js";
import { CheckpointRepository } from "../../src/storage/checkpoint-repo.js";
import type { PullAction } from "../../src/domain/pull-plan.js";

describe("Pull Coordinator (applyVerifiedPull)", () => {
  let tempDir: string;
  let vaultRoot: string;
  let statePath: string;
  const remoteFingerprint = "test-remote-fingerprint-123";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "livesync-pull-coordinator-test-"));
    vaultRoot = path.join(tempDir, "vault");
    statePath = path.join(tempDir, "state.sqlite");
    await fs.mkdir(vaultRoot, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("throws if capability is not a valid VaultReflectCapability", async () => {
    const invalidCap = { name: "invalid" } as any;
    await expect(
      applyVerifiedPull(invalidCap, {
        vaultRoot,
        actions: [],
        remoteFingerprint,
        statePath,
      })
    ).rejects.toThrow(/Reflect capability required/);
  });

  it("applies create actions: installs files atomically, saves provenance, and commits checkpoint", async () => {
    const capability = createVaultReflectCapability(
      new URL("http://localhost:5984"),
      "testdb",
      vaultRoot
    );

    const noteContent = Buffer.from("# Created Note\nRecoverable pull test.");
    const actions: PullAction[] = [
      {
        kind: "create",
        path: "sub/NewNote.md",
        sourceRevision: "1-rev1",
        bytes: noteContent,
      },
    ];

    await applyVerifiedPull(capability, {
      vaultRoot,
      actions,
      remoteFingerprint,
      statePath,
      updateSeq: "10-seq1",
    });

    // 1. Verify file on disk
    const onDisk = await fs.readFile(path.join(vaultRoot, "sub/NewNote.md"));
    expect(Buffer.from(onDisk).equals(noteContent)).toBe(true);

    // 2. Verify provenance in SQLite
    const db = openDatabase(statePath);
    const provRepo = new ProvenanceRepository(db);
    const prov = provRepo.getByPath("sub/NewNote.md");
    expect(prov).not.toBeNull();
    expect(prov?.remoteRevision).toBe("1-rev1");
    expect(prov?.remoteFingerprint).toBe(remoteFingerprint);

    // 3. Verify checkpoint in SQLite
    const checkRepo = new CheckpointRepository(db);
    const checkpoint = checkRepo.getCheckpoint(remoteFingerprint);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.lastUpdateSeq).toBe("10-seq1");

    db.close();
  });

  it("applies quarantine-delete actions: quarantines file, removes provenance, and commits checkpoint", async () => {
    const capability = createVaultReflectCapability(
      new URL("http://localhost:5984"),
      "testdb",
      vaultRoot
    );

    // Pre-populate vault file and provenance
    const filePath = path.join(vaultRoot, "DeleteMe.md");
    const content = Buffer.from("Pre-existing content");
    await fs.writeFile(filePath, content);

    const dbInit = openDatabase(statePath);
    const provInit = new ProvenanceRepository(dbInit);
    provInit.saveProvenance({
      path: "DeleteMe.md",
      remoteRevision: "1-old",
      contentSha256: "hash123",
      observedMtime: 12345,
      remoteFingerprint,
      reflectedAt: new Date().toISOString(),
    });
    dbInit.close();

    const actions: PullAction[] = [
      {
        kind: "quarantine-delete",
        path: "DeleteMe.md",
        sourceRevision: "2-del",
      },
    ];

    await applyVerifiedPull(capability, {
      vaultRoot,
      actions,
      remoteFingerprint,
      statePath,
      updateSeq: "20-seq2",
    });

    // 1. Verify file unlinked from vault
    await expect(fs.access(filePath)).rejects.toThrow();

    // 2. Verify provenance deleted
    const db = openDatabase(statePath);
    const provRepo = new ProvenanceRepository(db);
    expect(provRepo.getByPath("DeleteMe.md")).toBeNull();

    // 3. Verify quarantine record
    const quarRepo = new QuarantineRepository(db);
    const quarRecords = quarRepo.listByOriginalPath("DeleteMe.md");
    expect(quarRecords).toHaveLength(1);
    expect(quarRecords[0].remoteRevision).toBe("2-del");
    expect(await fs.readFile(quarRecords[0].quarantinePath)).toEqual(content);

    // 4. Verify checkpoint updated
    const checkRepo = new CheckpointRepository(db);
    const checkpoint = checkRepo.getCheckpoint(remoteFingerprint);
    expect(checkpoint?.lastUpdateSeq).toBe("20-seq2");

    db.close();
  });

  it("performs zero writes on noop actions but advances checkpoint if provided", async () => {
    const capability = createVaultReflectCapability(
      new URL("http://localhost:5984"),
      "testdb",
      vaultRoot
    );

    const actions: PullAction[] = [
      {
        kind: "noop",
        path: "Unchanged.md",
        sourceRevision: "1-same",
        contentSha256: "hash-same",
      },
    ];

    await applyVerifiedPull(capability, {
      vaultRoot,
      actions,
      remoteFingerprint,
      statePath,
      updateSeq: "30-seq3",
    });

    const db = openDatabase(statePath);
    const checkRepo = new CheckpointRepository(db);
    const checkpoint = checkRepo.getCheckpoint(remoteFingerprint);
    expect(checkpoint?.lastUpdateSeq).toBe("30-seq3");
    db.close();
  });

  it("does not commit checkpoint if action throws an error", async () => {
    const capability = createVaultReflectCapability(
      new URL("http://localhost:5984"),
      "testdb",
      vaultRoot
    );

    const actions: PullAction[] = [
      {
        kind: "quarantine-delete",
        path: "non-existent-file-that-fails-quarantine.md",
        sourceRevision: "1-del",
      },
    ];

    await expect(
      applyVerifiedPull(capability, {
        vaultRoot,
        actions,
        remoteFingerprint,
        statePath,
        updateSeq: "40-seq4",
      })
    ).rejects.toThrow();

    const db = openDatabase(statePath);
    const checkRepo = new CheckpointRepository(db);
    expect(checkRepo.getCheckpoint(remoteFingerprint)).toBeNull();
    db.close();
  });
});
