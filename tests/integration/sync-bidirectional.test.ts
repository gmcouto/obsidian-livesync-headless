import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { runArmCommand } from '../../src/cli/commands/arm.js';
import { runSyncCommand } from '../../src/cli/commands/sync.js';
import { EXIT_CODES, OutcomeCategory } from '../../src/diagnostics/outcomes.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { ProvenanceRepository } from '../../src/storage/provenance-repo.js';

describe('Sync Bidirectional Integration Tests (Real CouchDB 3.5.2)', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-bidi-test-'));
    vaultDir = path.join(tempDir, 'vault');
    stateDir = path.join(tempDir, 'state');
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
      encryption?: { enabled: boolean; passphrase: string };
      usePathObfuscation?: boolean;
    }
  ): string {
    const creds = harness.getCredentials();
    const configPath = path.join(tempDir, 'config.yaml');
    const statePath = path.join(stateDir, 'state.sqlite');

    const encryptionBlock = options?.encryption
      ? `
encryption:
  enabled: ${options.encryption.enabled}
  passphrase: ${options.encryption.passphrase}
`
      : '';

    const content = `
remote:
  url: ${harness.getBaseUrl().href}
  database: ${dbName}
  username: ${creds.username}
  password: ${creds.password}
vault:
  path: ${vaultDir}
state:
  path: ${statePath}
${encryptionBlock}
`;
    fs.writeFileSync(configPath, content, 'utf8');
    return configPath;
  }

  it('executes full bidirectional convergence: push, pull, update, and logical deletion (SYNC-01, SYNC-02, SYNC-03, SYNC-04)', async () => {
    const dbName = 'sync-bidi-full-flow';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    // 1. Seed a remote note
    const remoteContent = '# Remote Note Initial';
    await harness.seedLegacyNote(dbName, 'RemoteNote.md', remoteContent);

    // 2. Create a local note
    const localContent = '# Local Note Initial';
    fs.writeFileSync(path.join(vaultDir, 'LocalNote.md'), localContent, 'utf8');

    const configPath = writeConfigFile(dbName);

    // 3. Arm the write grant (CONF-07)
    const armExit = await runArmCommand({ configPath, json: true });
    expect(armExit).toBe(EXIT_CODES.SUCCESS);

    // 4. Run bidirectional sync (apply mode)
    let output = '';
    const syncExit1 = await runSyncCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(syncExit1).toBe(EXIT_CODES.SUCCESS);

    // Verify local vault has both files
    expect(fs.existsSync(path.join(vaultDir, 'RemoteNote.md'))).toBe(true);
    expect(fs.readFileSync(path.join(vaultDir, 'RemoteNote.md'), 'utf8')).toBe(remoteContent);
    expect(fs.existsSync(path.join(vaultDir, 'LocalNote.md'))).toBe(true);

    // Verify CouchDB has the pushed local note document
    const creds = harness.getCredentials();
    const docRes = await fetch(new URL(`/${dbName}/localnote.md`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64'),
      },
    });
    expect(docRes.status).toBe(200);
    const localDoc = (await docRes.json()) as any;
    expect(localDoc.path).toBe('LocalNote.md');
    expect(localDoc.deleted).toBe(false);
    expect(Array.isArray(localDoc.children)).toBe(true);

    // 5. Test Local Update -> CouchDB receives new revision
    const updatedLocalContent = '# Local Note Modified Locally';
    fs.writeFileSync(path.join(vaultDir, 'LocalNote.md'), updatedLocalContent, 'utf8');

    const syncExit2 = await runSyncCommand({ configPath, dryRun: false, json: true });
    expect(syncExit2).toBe(EXIT_CODES.SUCCESS);

    // Verify updated revision on CouchDB
    const updatedDocRes = await fetch(new URL(`/${dbName}/localnote.md`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64'),
      },
    });
    const updatedDoc = (await updatedDocRes.json()) as any;
    expect(updatedDoc._rev).not.toBe(localDoc._rev);
    expect(updatedDoc._rev.startsWith('2-')).toBe(true);

    // 6. Test Local Deletion -> CouchDB receives logical deletion (deleted: true) without HTTP DELETE
    fs.unlinkSync(path.join(vaultDir, 'LocalNote.md'));

    const syncExit3 = await runSyncCommand({ configPath, dryRun: false, json: true });
    expect(syncExit3).toBe(EXIT_CODES.SUCCESS);

    const deletedDocRes = await fetch(new URL(`/${dbName}/localnote.md`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64'),
      },
    });
    expect(deletedDocRes.status).toBe(200);
    const deletedDoc = (await deletedDocRes.json()) as any;
    expect(deletedDoc.deleted).toBe(true);
    expect(deletedDoc._rev.startsWith('3-')).toBe(true);
  });

  it('safely preserves independent divergent conflicts without overwriting either side (SYNC-06, SYNC-07)', async () => {
    const dbName = 'sync-bidi-divergent-conflict';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    // Initial synchronized state
    const initialContent = '# Baseline Note';
    const seeded = await harness.seedLegacyNote(dbName, 'SharedDoc.md', initialContent);

    const configPath = writeConfigFile(dbName);
    await runArmCommand({ configPath, json: true });
    await runSyncCommand({ configPath, dryRun: false, json: true });

    // Modify file remotely
    const creds = harness.getCredentials();
    const remoteDocRes = await fetch(new URL(`/${dbName}/${seeded.id}`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64'),
      },
    });
    const remoteDoc = (await remoteDocRes.json()) as any;
    remoteDoc.data = '# Remote Divergent Edit';
    remoteDoc.size = new TextEncoder().encode(remoteDoc.data).byteLength;
    await harness.putDocument(dbName, seeded.id, remoteDoc);

    // Modify file locally independently
    const localDivergent = '# Local Divergent Edit';
    fs.writeFileSync(path.join(vaultDir, 'SharedDoc.md'), localDivergent, 'utf8');

    // Run sync -> must detect conflict and halt fail-closed
    let output = '';
    const syncExit = await runSyncCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(syncExit).toBe(EXIT_CODES.CONFLICT);

    // Parse JSON report
    const jsonLine = output.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    expect(jsonLine).toBeDefined();
    const report = JSON.parse(jsonLine!);
    expect(report.outcome).toBe(OutcomeCategory.CONFLICT);
    expect(report.conflicts.length).toBe(1);
    expect(report.appliedActions).toBe(0);

    // Ensure local file was NOT overwritten
    expect(fs.readFileSync(path.join(vaultDir, 'SharedDoc.md'), 'utf8')).toBe(localDivergent);
  });
});
