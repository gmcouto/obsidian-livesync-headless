import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { runArmCommand } from '../../src/cli/commands/arm.js';
import { runSyncCommand } from '../../src/cli/commands/sync.js';
import { EXIT_CODES, OutcomeCategory } from '../../src/diagnostics/outcomes.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { WriteGrantRepo } from '../../src/storage/write-grant-repo.js';

describe('Sync Recovery, Idempotency & Auto-Revocation Integration Tests (Real CouchDB 3.5.2)', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-recov-test-'));
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

  function writeConfigFile(dbName: string): string {
    const creds = harness.getCredentials();
    const configPath = path.join(tempDir, 'config.yaml');
    const statePath = path.join(stateDir, 'state.sqlite');

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
`;
    fs.writeFileSync(configPath, content, 'utf8');
    return configPath;
  }

  async function snapshotRemote(dbName: string): Promise<{ update_seq: string; doc_count: number }> {
    const creds = harness.getCredentials();
    const res = await fetch(new URL(`/${dbName}`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64'),
      },
    });
    return (await res.json()) as { update_seq: string; doc_count: number };
  }

  it('proves rerun idempotency: subsequent sync on unchanged vault produces zero additional revisions (SYNC-09)', async () => {
    const dbName = 'sync-idempotency';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    // Seed notes
    await harness.seedLegacyNote(dbName, 'Doc1.md', '# Content 1');
    fs.writeFileSync(path.join(vaultDir, 'Doc2.md'), '# Content 2', 'utf8');

    const configPath = writeConfigFile(dbName);

    // Arm and initial sync
    await runArmCommand({ configPath, json: true });
    const exit1 = await runSyncCommand({ configPath, dryRun: false, json: true });
    expect(exit1).toBe(EXIT_CODES.SUCCESS);

    // Capture snapshot after initial sync
    const snap1 = await snapshotRemote(dbName);

    // Run sync again immediately
    let output = '';
    const exit2 = await runSyncCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exit2).toBe(EXIT_CODES.SUCCESS);

    const jsonLine = output.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const report = JSON.parse(jsonLine!);
    expect(report.summary.noops).toBe(2);
    expect(report.summary.totalActions).toBe(2);
    expect(report.appliedActions).toBe(0);
    expect(report.converged).toBe(true);

    // Verify remote database had ZERO mutations
    const snap2 = await snapshotRemote(dbName);
    expect(snap2.doc_count).toBe(snap1.doc_count);
    expect(snap2.update_seq).toBe(snap1.update_seq);
  });

  it('auto-revokes write grant on evidence drift and blocks mutation (CONF-08)', async () => {
    const dbName = 'sync-grant-auto-revocation';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    const configPath = writeConfigFile(dbName);

    // 1. Arm write grant
    const armExit = await runArmCommand({ configPath, json: true });
    expect(armExit).toBe(EXIT_CODES.SUCCESS);

    // 2. Simulate drift on remote database: re-put version doc so its _rev changes (bootstrap generation drift)
    const versionRes = await fetch(new URL(`/${dbName}/obsydian_livesync_version`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization: 'Basic ' + Buffer.from('admin:password').toString('base64'),
      },
    });
    const versionDoc = (await versionRes.json()) as any;
    await harness.putDocument(dbName, 'obsydian_livesync_version', versionDoc);

    // 3. Attempt sync -> should detect bootstrap generation drift, auto-revoke grant, and fail closed
    let output = '';
    const syncExit = await runSyncCommand({
      configPath,
      dryRun: false,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(syncExit).toBe(EXIT_CODES.MUTATION_VIOLATION);

    const jsonLine = output.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const report = JSON.parse(jsonLine!);
    expect(report.outcome).toBe(OutcomeCategory.MUTATION_VIOLATION);
    expect(report.message).toContain('auto-revoked due to evidence drift');

    // 4. Verify in SQLite that the grant was marked revoked
    const statePath = path.join(stateDir, 'state.sqlite');
    const db = openDatabase(statePath);
    const grantRepo = new WriteGrantRepo(db);
    const activeGrants = db.prepare('SELECT * FROM write_grants WHERE revoked = 0').all();
    expect(activeGrants.length).toBe(0);

    const allGrants = db.prepare('SELECT * FROM write_grants').all() as any[];
    expect(allGrants.length).toBe(1);
    expect(allGrants[0].revoked).toBe(1);
    expect(allGrants[0].revocation_reason).toContain('Bootstrap generation drift');
    db.close();
  });
});
