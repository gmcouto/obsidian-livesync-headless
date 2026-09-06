import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../../src/storage/sqlite.js";
import { QuarantineRepository } from "../../src/storage/quarantine-repo.js";
import { quarantineVaultFile, QuarantineError } from "../../src/filesystem/quarantine-store.js";

describe("Quarantine Store", () => {
  let tempDir: string;
  let vaultRoot: string;
  let stateRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "livesync-quarantine-store-test-"));
    vaultRoot = path.join(tempDir, "vault");
    stateRoot = path.join(tempDir, "state");
    dbPath = path.join(stateRoot, "state.sqlite");

    await fs.mkdir(vaultRoot, { recursive: true });
    await fs.mkdir(stateRoot, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("successfully quarantines a vault file and preserves content outside the vault", async () => {
    const db = openDatabase(dbPath);
    const repo = new QuarantineRepository(db);

    const relativePath = "notes/hello.md";
    const fullVaultPath = path.join(vaultRoot, relativePath);
    await fs.mkdir(path.dirname(fullVaultPath), { recursive: true });
    const content = Buffer.from("# Hello World\nThis is a test note.");
    await fs.writeFile(fullVaultPath, content);

    const record = await quarantineVaultFile(
      vaultRoot,
      stateRoot,
      relativePath,
      "1-rev123",
      repo
    );

    // Verify record
    expect(record.originalPath).toBe(relativePath);
    expect(record.remoteRevision).toBe("1-rev123");
    expect(record.reason).toBe("REMOTE_DELETION");
    expect(record.quarantinePath.startsWith(stateRoot)).toBe(true);

    // Verify source vault file was unlinked
    await expect(fs.access(fullVaultPath)).rejects.toThrow();

    // Verify quarantine file exists on disk with exact bytes
    const quarantinedBytes = await fs.readFile(record.quarantinePath);
    expect(Buffer.from(quarantinedBytes).equals(content)).toBe(true);

    // Verify SQLite record
    const list = repo.listByOriginalPath(relativePath);
    expect(list).toHaveLength(1);
    expect(list[0].quarantinePath).toBe(record.quarantinePath);
    expect(list[0].contentSha256).toBe(record.contentSha256);

    db.close();
  });

  it("produces collision-safe directories when quarantining the same path repeatedly", async () => {
    const db = openDatabase(dbPath);
    const repo = new QuarantineRepository(db);

    const relativePath = "conflict.md";
    const fullVaultPath = path.join(vaultRoot, relativePath);

    // First quarantine
    await fs.writeFile(fullVaultPath, Buffer.from("version 1"));
    const rec1 = await quarantineVaultFile(vaultRoot, stateRoot, relativePath, "1-a", repo);

    // Second quarantine
    await fs.writeFile(fullVaultPath, Buffer.from("version 2"));
    const rec2 = await quarantineVaultFile(vaultRoot, stateRoot, relativePath, "2-b", repo);

    expect(rec1.quarantinePath).not.toBe(rec2.quarantinePath);
    expect(await fs.readFile(rec1.quarantinePath, "utf-8")).toBe("version 1");
    expect(await fs.readFile(rec2.quarantinePath, "utf-8")).toBe("version 2");

    const history = repo.listByOriginalPath(relativePath);
    expect(history).toHaveLength(2);

    db.close();
  });

  it("rejects path traversal attempts before touching filesystem", async () => {
    const db = openDatabase(dbPath);
    const repo = new QuarantineRepository(db);

    await expect(
      quarantineVaultFile(vaultRoot, stateRoot, "../outside.md", "1-a", repo)
    ).rejects.toThrow(QuarantineError);

    await expect(
      quarantineVaultFile(vaultRoot, stateRoot, "/absolute.md", "1-a", repo)
    ).rejects.toThrow(QuarantineError);

    db.close();
  });

  it("fails closed and leaves source vault file intact if read-back verification fails", async () => {
    const db = openDatabase(dbPath);
    const repo = new QuarantineRepository(db);

    const relativePath = "corrupt-target.md";
    const fullVaultPath = path.join(vaultRoot, relativePath);
    const content = Buffer.from("original vault content");
    await fs.writeFile(fullVaultPath, content);

    // Inject corrupted read-back
    let readCount = 0;
    const readFileFn = async (p: string) => {
      readCount++;
      if (readCount === 1) {
        return content; // Source read
      }
      return Buffer.from("corrupted read-back bytes"); // Read-back from quarantine
    };

    await expect(
      quarantineVaultFile(vaultRoot, stateRoot, relativePath, "1-a", repo, {
        readFileFn,
      })
    ).rejects.toThrow(QuarantineError);

    // Source file must remain intact in vault
    const sourceAfter = await fs.readFile(fullVaultPath);
    expect(Buffer.from(sourceAfter).equals(content)).toBe(true);

    // DB must not have record
    expect(repo.listByOriginalPath(relativePath)).toHaveLength(0);

    db.close();
  });

  it("fails closed and leaves source vault file intact if database insertion throws", async () => {
    const db = openDatabase(dbPath);
    const repo = new QuarantineRepository(db);

    const relativePath = "db-failure.md";
    const fullVaultPath = path.join(vaultRoot, relativePath);
    const content = Buffer.from("save me from db crash");
    await fs.writeFile(fullVaultPath, content);

    // Mock saveQuarantine to throw
    repo.saveQuarantine = () => {
      throw new Error("Disk full in SQLite");
    };

    await expect(
      quarantineVaultFile(vaultRoot, stateRoot, relativePath, "1-a", repo)
    ).rejects.toThrow(QuarantineError);

    // Vault file must still exist
    const sourceAfter = await fs.readFile(fullVaultPath);
    expect(Buffer.from(sourceAfter).equals(content)).toBe(true);

    db.close();
  });

  it("fails closed if reading source vault file fails", async () => {
    const db = openDatabase(dbPath);
    const repo = new QuarantineRepository(db);

    await expect(
      quarantineVaultFile(vaultRoot, stateRoot, "does-not-exist.md", "1-a", repo)
    ).rejects.toThrow(QuarantineError);

    expect(repo.listByOriginalPath("does-not-exist.md")).toHaveLength(0);
    db.close();
  });
});
