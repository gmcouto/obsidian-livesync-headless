import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { runSyncCommand } from '../../src/cli/commands/sync.js';
import { EXIT_CODES, OutcomeCategory } from '../../src/diagnostics/outcomes.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { ProvenanceRepository } from '../../src/storage/provenance-repo.js';

describe('Sync Dry-Run Integration Tests (Real CouchDB)', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-dry-run-test-'));
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

  it('proves dry-run accurately previews bidirectional create/push actions with zero remote or local mutations (SYNC-08)', async () => {
    const dbName = 'sync-dry-run-zero-mutation';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    // Seed a remote note
    const remoteContent = '# Remote Note\nFrom CouchDB';
    await harness.seedLegacyNote(dbName, 'RemoteNote.md', remoteContent);

    // Create a local note
    const localContent = '# Local Note\nFrom Local Vault';
    fs.writeFileSync(path.join(vaultDir, 'LocalNote.md'), localContent, 'utf8');

    const configPath = writeConfigFile(dbName);
    const preSnapshot = await snapshotRemote(dbName);
    let output = '';

    const exitCode = await runSyncCommand({
      configPath,
      dryRun: true,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);

    // Parse JSON report
    const jsonLine = output.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    expect(jsonLine).toBeDefined();
    const report = JSON.parse(jsonLine!);

    expect(report.type).toBe('sync_report');
    expect(report.outcome).toBe(OutcomeCategory.SUCCESS);
    expect(report.dryRun).toBe(true);
    expect(report.summary.pullCreates).toBe(1);
    expect(report.summary.pushCreates).toBe(1);
    expect(report.summary.totalActions).toBe(2);
    expect(report.appliedActions).toBe(0);
    expect(report.zeroMutationVerified).toBe(true);

    // 1. Verify ZERO CouchDB mutations
    const postSnapshot = await snapshotRemote(dbName);
    expect(postSnapshot.doc_count).toBe(preSnapshot.doc_count);
    expect(postSnapshot.update_seq).toBe(preSnapshot.update_seq);

    // 2. Verify ZERO local disk mutations
    const filesOnDisk = fs.readdirSync(vaultDir);
    expect(filesOnDisk).toEqual(['LocalNote.md']);
    expect(fs.readFileSync(path.join(vaultDir, 'LocalNote.md'), 'utf8')).toBe(localContent);

    // 3. Verify ZERO SQLite provenance records
    const statePath = path.join(stateDir, 'state.sqlite');
    const db = openDatabase(statePath);
    const pRepo = new ProvenanceRepository(db);
    expect(pRepo.getAllAsMap().size).toBe(0);
    db.close();
  });
});
