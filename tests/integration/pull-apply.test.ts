import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CouchDbTestHarness } from "./couchdb-harness.js";
import { runPullCommand } from "../../src/cli/commands/pull.js";
import { EXIT_CODES, OutcomeCategory } from "../../src/diagnostics/outcomes.js";
import { openDatabase } from "../../src/storage/sqlite.js";

describe("CLI Pull Apply Integration Tests", () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pull-apply-test-"));
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
  ): string {
    const creds = harness.getCredentials();
    const configPath = path.join(tempDir, "config.yaml");
    const statePath = path.join(stateDir, "admission.sqlite");
    const vPath = options?.vaultPath ?? vaultDir;

    const encryptionBlock = options?.encryption
      ? `
encryption:
  enabled: ${options.encryption.enabled}
  passphrase: ${options.encryption.passphrase}
`
      : "";

    const dedicatedLine = options?.dedicated !== undefined ? `  dedicated: ${options.dedicated}` : "";

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
    return configPath;
  }

  async function snapshotRemote(dbName: string): Promise<{ update_seq: string; doc_count: number }> {
    const creds = harness.getCredentials();
    const res = await fetch(new URL(`/${dbName}`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization: "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64"),
      },
    });
    return (await res.json()) as { update_seq: string; doc_count: number };
  }

  it("two live leaves exit CONFLICT 8 and leave the destination missing", async () => {
    const dbName = "pull-apply-conflict-leaves";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });
    await harness.seedConflictingLegacyNotes(
      dbName,
      "Welcome.md",
      "# CouchDB winner\n",
      "# Other live leaf\n"
    );

    const configPath = writeConfigFile(dbName);
    let output = "";
    const exitCode = await runPullCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.CONFLICT);
    expect(EXIT_CODES.CONFLICT).toBe(8);
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.CONFLICT);
    expect(report.actions.some((action: { kind: string }) => action.kind === "create")).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, "Welcome.md"))).toBe(false);
    expect(fs.readdirSync(vaultDir)).toEqual([]);
  });

  it("empty vault apply materializes notes, plain, and newnote files with exact provenance and unchanged update_seq", async () => {
    const dbName = "pull-apply-all-types";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    const legacyBody = "# Legacy Notes\nContent here\n";
    const plainBody = "Plain text chunked content";
    const binaryBody = "BINARY_DATA_NEWNOTE";

    const legacy = await harness.seedLegacyNote(dbName, "Legacy.md", legacyBody);
    const plain = await harness.seedChunkedPlainNote(dbName, "Plain.md", plainBody);
    const binary = await harness.seedNewnoteBinary(dbName, "Photo.bin", binaryBody);

    const configPath = writeConfigFile(dbName);
    const preSnapshot = await snapshotRemote(dbName);
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
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.SUCCESS);

    // Check files on disk
    expect(fs.readFileSync(path.join(vaultDir, "Legacy.md"), "utf8")).toBe(legacyBody);
    expect(fs.readFileSync(path.join(vaultDir, "Plain.md"), "utf8")).toBe(plainBody);
    expect(fs.readFileSync(path.join(vaultDir, "Photo.bin"), "utf8")).toBe(binaryBody);

    // Check provenance in SQLite
    const statePath = path.join(stateDir, "admission.sqlite");
    const db = openDatabase(statePath);

    const rowLegacy = db
      .prepare("SELECT remote_revision FROM file_provenance WHERE path = ?")
      .get("Legacy.md") as { remote_revision: string };
    expect(rowLegacy?.remote_revision).toBe(legacy.rev);

    const rowPlain = db
      .prepare("SELECT remote_revision FROM file_provenance WHERE path = ?")
      .get("Plain.md") as { remote_revision: string };
    expect(rowPlain?.remote_revision).toBe(plain.rev);

    const rowBinary = db
      .prepare("SELECT remote_revision FROM file_provenance WHERE path = ?")
      .get("Photo.bin") as { remote_revision: string };
    expect(rowBinary?.remote_revision).toBe(binary.rev);

    db.close();

    // Verify remote is not mutated
    const postSnapshot = await snapshotRemote(dbName);
    expect(preSnapshot.update_seq).toBe(postSnapshot.update_seq);
    expect(preSnapshot.doc_count).toBe(postSnapshot.doc_count);
  });

  it("encrypted V2 apply writes dest bytes equal to plaintext and records ciphertext rev in provenance", async () => {
    const { createPBKDF2Salt } = await import("octagonal-wheels/encryption/hkdf");
    const { uint8ArrayToHexString } = await import("octagonal-wheels/binary/hex");
    const passphrase = "vault-passphrase-v2";
    const saltHex = uint8ArrayToHexString(createPBKDF2Salt());

    const dbName = "pull-apply-encrypted-v2";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, {
      version: 12,
      locked: false,
      pbkdf2salt: saltHex,
      tweakValues: { encrypt: true },
    });

    const plaintext = "# Secret Journal\nPersonal thoughts.\n";
    const encrypted = await harness.seedEncryptedV2Note(
      dbName,
      "Journal.md",
      plaintext,
      passphrase,
      saltHex
    );

    const configPath = writeConfigFile(dbName, {
      encryption: { enabled: true, passphrase },
    });

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
    expect(fs.readFileSync(path.join(vaultDir, "Journal.md"), "utf8")).toBe(plaintext);

    const statePath = path.join(stateDir, "admission.sqlite");
    const db = openDatabase(statePath);
    const row = db
      .prepare("SELECT remote_revision FROM file_provenance WHERE path = ?")
      .get("Journal.md") as { remote_revision: string };
    expect(row?.remote_revision).toBe(encrypted.rev);
    db.close();
  });

  it("obfuscated-path apply installs document.path as the vault filename, never the f: id", async () => {
    const { createPBKDF2Salt } = await import("octagonal-wheels/encryption/hkdf");
    const { uint8ArrayToHexString } = await import("octagonal-wheels/binary/hex");
    const passphrase = "obfuscate-passphrase";
    const saltHex = uint8ArrayToHexString(createPBKDF2Salt());

    const dbName = "pull-apply-obfuscated";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, {
      version: 12,
      locked: false,
      pbkdf2salt: saltHex,
      tweakValues: { encrypt: true, usePathObfuscation: true },
    });

    const notePath = "folder/HiddenSecret.md";
    const body = "# Obfuscated Content\n";
    const seeded = await harness.seedObfuscatedNote(
      dbName,
      notePath,
      body,
      passphrase,
      saltHex
    );

    // Confirm that CouchDB doc ID starts with f:
    expect(seeded.id).toMatch(/^f:/);

    const configPath = writeConfigFile(dbName, {
      encryption: { enabled: true, passphrase },
    });

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

    // File must exist at folder/HiddenSecret.md
    expect(fs.existsSync(path.join(vaultDir, "folder", "HiddenSecret.md"))).toBe(true);
    expect(fs.readFileSync(path.join(vaultDir, "folder", "HiddenSecret.md"), "utf8")).toBe(body);

    // File MUST NOT exist under the f: document ID
    expect(fs.existsSync(path.join(vaultDir, seeded.id))).toBe(false);
  });

  it("dry-run false on non-empty non-dedicated vault exits CONFIG_ERROR and does not overwrite", async () => {
    const dbName = "pull-apply-not-empty";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });
    await harness.seedLegacyNote(dbName, "Welcome.md", "# Remote content\n");

    // Put existing local file in vault
    fs.writeFileSync(path.join(vaultDir, "LocalOnly.md"), "local content", "utf8");

    const configPath = writeConfigFile(dbName, { dedicated: false });
    let output = "";
    const exitCode = await runPullCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.CONFIG_ERROR);
    expect(report.blockers.some((b: { code: string }) => b.code === "VAULT_NOT_EMPTY")).toBe(true);

    // Remote file is not written
    expect(fs.existsSync(path.join(vaultDir, "Welcome.md"))).toBe(false);
    // Local file is preserved
    expect(fs.readFileSync(path.join(vaultDir, "LocalOnly.md"), "utf8")).toBe("local content");
  });

  it("JSON Lines pull_report output contains no fields named bytes or passphrase", async () => {
    const dbName = "pull-apply-json-report";
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });
    await harness.seedLegacyNote(dbName, "Public.md", "# Public Note\n");

    const configPath = writeConfigFile(dbName);
    let output = "";
    await runPullCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(output).not.toContain('"bytes"');
    expect(output).not.toContain('"passphrase"');
    expect(output).not.toContain('"password"');

    const parsed = JSON.parse(output.trim());
    expect(parsed.type).toBe("pull_report");
    expect(parsed).not.toHaveProperty("bytes");
    expect(parsed).not.toHaveProperty("passphrase");
  });
});
