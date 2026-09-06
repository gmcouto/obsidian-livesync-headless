import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CouchDbTestHarness } from "./couchdb-harness.js";
import { runPullCommand } from "../../src/cli/commands/pull.js";
import { EXIT_CODES, OutcomeCategory } from "../../src/diagnostics/outcomes.js";
import { openDatabase } from "../../src/storage/sqlite.js";
import { ProvenanceRepository } from "../../src/storage/provenance-repo.js";
import { QuarantineRepository } from "../../src/storage/quarantine-repo.js";
import { CheckpointRepository } from "../../src/storage/checkpoint-repo.js";

describe("CLI Pull Recovery Integration Tests", () => {
  const harness = new CouchDbTestHarness();
  let tempDir: string;
  let vaultDir: string;
  let stateDir: string;

  beforeAll(async () => {
    await harness.start();
  }, 120000);

  afterAll(async () => {
    await harness.stop();
  }, 60000);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pull-recovery-test-"));
    vaultDir = path.join(tempDir, "vault");
    stateDir = path.join(tempDir, "state");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  function writeConfigFile(
    dbName: string,
    options?: {
      dedicated?: boolean;
      encryption?: { enabled: boolean; passphrase: string };
      vaultPath?: string;
    }
  ): { configPath: string; statePath: string } {
    const creds = harness.getCredentials();
    const configPath = path.join(tempDir, "config.yaml");
    const statePath = path.join(stateDir, "state.sqlite");
    const vPath = options?.vaultPath ?? vaultDir;

    const encryptionBlock = options?.encryption
      ? `
encryption:
  enabled: ${options.encryption.enabled}
  passphrase: ${options.encryption.passphrase}
`
      : "";

    const dedicatedLine =
      options?.dedicated !== undefined ? `  dedicated: ${options.dedicated}` : "";

    const content = `
remote:
  url: ${harness.getBaseUrl().href}
  database: ${dbName}
  username: ${creds.username}
  password: ${creds.password}
vault:
  path: ${vPath}
${dedicatedLine}
state:
  path: ${statePath}
${encryptionBlock}
`;
    fs.writeFileSync(configPath, content, "utf8");
    return { configPath, statePath };
  }

  async function snapshotRemote(
    dbName: string
  ): Promise<{ update_seq: string; doc_count: number }> {
    const creds = harness.getCredentials();
    const res = await fetch(new URL(`/${dbName}`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${creds.username}:${creds.password}`).toString("base64"),
      },
    });
    return (await res.json()) as { update_seq: string; doc_count: number };
  }

  it("PULL-08: Rerun of completed pull produces 100% noop actions, 0 vault file writes, and 0 CouchDB mutations", async () => {
    const dbName = "pull-recovery-idempotent";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    await harness.seedLegacyNote(dbName, "Note1.md", "# Note One\nContent");
    await harness.seedLegacyNote(dbName, "Note2.md", "# Note Two\nContent");
    await harness.seedLegacyNote(dbName, "Note3.md", "# Note Three\nContent");

    const { configPath, statePath } = writeConfigFile(dbName, { dedicated: true });

    // First pull: creates all 3 files
    let output1 = "";
    const exit1 = await runPullCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output1 += msg;
      },
    });
    expect(exit1).toBe(EXIT_CODES.SUCCESS);

    const report1 = JSON.parse(output1.trim());
    expect(report1.outcome).toBe(OutcomeCategory.SUCCESS);
    expect(report1.actions.filter((a: any) => a.kind === "create")).toHaveLength(3);
    expect(fs.existsSync(path.join(vaultDir, "Note1.md"))).toBe(true);

    // Record mtime of files before second run
    const mtime1 = fs.statSync(path.join(vaultDir, "Note1.md")).mtimeMs;
    const mtime2 = fs.statSync(path.join(vaultDir, "Note2.md")).mtimeMs;
    const mtime3 = fs.statSync(path.join(vaultDir, "Note3.md")).mtimeMs;

    const preSnapshot = await snapshotRemote(dbName);

    // Second pull: should be 100% noop
    let output2 = "";
    const exit2 = await runPullCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output2 += msg;
      },
    });
    expect(exit2).toBe(EXIT_CODES.SUCCESS);

    const report2 = JSON.parse(output2.trim());
    expect(report2.outcome).toBe(OutcomeCategory.SUCCESS);
    expect(report2.actions.filter((a: any) => a.kind === "noop")).toHaveLength(3);
    expect(report2.actions.filter((a: any) => a.kind === "create")).toHaveLength(0);

    // Verify mtimes did not change (0 disk writes)
    expect(fs.statSync(path.join(vaultDir, "Note1.md")).mtimeMs).toBe(mtime1);
    expect(fs.statSync(path.join(vaultDir, "Note2.md")).mtimeMs).toBe(mtime2);
    expect(fs.statSync(path.join(vaultDir, "Note3.md")).mtimeMs).toBe(mtime3);

    // Verify checkpoint is present in database
    const db = openDatabase(statePath);
    const checkRepo = new CheckpointRepository(db);
    const checkpoint = checkRepo.getCheckpoint(report2.remoteFingerprint);
    expect(checkpoint).not.toBeNull();
    db.close();

    // Verify remote was not mutated
    const postSnapshot = await snapshotRemote(dbName);
    expect(preSnapshot.update_seq).toBe(postSnapshot.update_seq);
  });

  it("PULL-04: Remote deletion safely moves local vault file to external quarantine, records SQLite row, and unlinks from vault", async () => {
    const dbName = "pull-recovery-quarantine";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    await harness.seedLegacyNote(dbName, "ToDelete.md", "# Heading\nOriginal text before deletion");

    const { configPath, statePath } = writeConfigFile(dbName, { dedicated: true });

    // Step 1: Initial pull materializes the file
    let output1 = "";
    const exit1 = await runPullCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output1 += msg;
      },
    });
    expect(exit1).toBe(EXIT_CODES.SUCCESS);
    expect(fs.existsSync(path.join(vaultDir, "ToDelete.md"))).toBe(true);

    // Step 2: Seed remote deletion tombstone
    await harness.seedDeletedNote(dbName, "ToDelete.md");

    const preSnapshot = await snapshotRemote(dbName);

    // Step 3: Run pull again -> must quarantine and delete locally
    let output2 = "";
    const exit2 = await runPullCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output2 += msg;
      },
    });
    expect(exit2).toBe(EXIT_CODES.SUCCESS);

    const report2 = JSON.parse(output2.trim());
    expect(report2.outcome).toBe(OutcomeCategory.SUCCESS);
    expect(report2.actions.filter((a: any) => a.kind === "quarantine-delete")).toHaveLength(1);

    // Verify file unlinked from vault
    expect(fs.existsSync(path.join(vaultDir, "ToDelete.md"))).toBe(false);

    // Verify quarantine record in SQLite
    const db = openDatabase(statePath);
    const quarRepo = new QuarantineRepository(db);
    const records = quarRepo.listByOriginalPath("ToDelete.md");
    expect(records).toHaveLength(1);
    expect(records[0].originalPath).toBe("ToDelete.md");
    expect(records[0].reason).toBe("REMOTE_DELETION");

    // Verify quarantined file exists outside the vault in state directory
    expect(fs.existsSync(records[0].quarantinePath)).toBe(true);
    expect(records[0].quarantinePath.startsWith(vaultDir)).toBe(false);
    expect(fs.readFileSync(records[0].quarantinePath, "utf8")).toBe(
      "# Heading\nOriginal text before deletion"
    );

    // Verify provenance row was deleted
    const provRepo = new ProvenanceRepository(db);
    expect(provRepo.getByPath("ToDelete.md")).toBeNull();

    db.close();

    // Verify zero mutations to CouchDB
    const postSnapshot = await snapshotRemote(dbName);
    expect(preSnapshot.update_seq).toBe(postSnapshot.update_seq);
  });

  it("PULL-06: Interrupted pull with leftover .ols-tmp-* staging files resumes cleanly and completes materialization", async () => {
    const dbName = "pull-recovery-crash-cleanup";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    await harness.seedLegacyNote(dbName, "Resume1.md", "# Resume Note 1\n");
    await harness.seedLegacyNote(dbName, "Resume2.md", "# Resume Note 2\n");

    // Inject leftover staging files from a simulated crashed pull
    fs.writeFileSync(path.join(vaultDir, ".ols-tmp-crashed1"), "incomplete junk 1");
    fs.mkdirSync(path.join(vaultDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "nested", ".ols-tmp-crashed2"), "incomplete junk 2");

    const { configPath, statePath } = writeConfigFile(dbName, { dedicated: true });

    let output = "";
    const exitCode = await runPullCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);

    // Verify leftover staging files were cleaned
    expect(fs.existsSync(path.join(vaultDir, ".ols-tmp-crashed1"))).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, "nested", ".ols-tmp-crashed2"))).toBe(false);

    // Verify actual notes materialized
    expect(fs.readFileSync(path.join(vaultDir, "Resume1.md"), "utf8")).toBe("# Resume Note 1\n");
    expect(fs.readFileSync(path.join(vaultDir, "Resume2.md"), "utf8")).toBe("# Resume Note 2\n");

    // Verify checkpoint recorded
    const db = openDatabase(statePath);
    const checkRepo = new CheckpointRepository(db);
    const report = JSON.parse(output.trim());
    expect(checkRepo.getCheckpoint(report.remoteFingerprint)).not.toBeNull();
    db.close();
  });

  it("SAFE-05: Durable state isolation: SQLite databases and quarantine directories reside strictly outside the vault", async () => {
    const dbName = "pull-recovery-state-isolation";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    await harness.seedLegacyNote(dbName, "VaultOnly.md", "# Vault Only Note\n");

    const { configPath, statePath } = writeConfigFile(dbName, { dedicated: true });

    const exitCode = await runPullCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: () => {},
    });
    expect(exitCode).toBe(EXIT_CODES.SUCCESS);

    // Inspect vault contents: should only contain VaultOnly.md
    const vaultFiles = fs.readdirSync(vaultDir);
    expect(vaultFiles).toEqual(["VaultOnly.md"]);
    expect(vaultFiles.some((f) => f.includes("sqlite"))).toBe(false);
    expect(vaultFiles.some((f) => f.includes("quarantine"))).toBe(false);

    // Inspect state directory: should contain state.sqlite and related files
    const stateFiles = fs.readdirSync(stateDir);
    expect(stateFiles.some((f) => f.startsWith("state.sqlite"))).toBe(true);

    // Verify state.sqlite has required tables
    const db = openDatabase(statePath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("schema_migrations");
    expect(tableNames).toContain("remote_admission");
    expect(tableNames).toContain("file_provenance");
    expect(tableNames).toContain("quarantine");
    expect(tableNames).toContain("pull_checkpoints");

    db.close();
  });
});
