import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { runPullCommand } from '../../src/cli/commands/pull.js';
import { EXIT_CODES, OutcomeCategory } from '../../src/diagnostics/outcomes.js';
import { openDatabase } from '../../src/storage/sqlite.js';

describe('CLI Pull Coordinator Integration Tests', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-cmd-test-'));
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
    const statePath = path.join(stateDir, 'admission.sqlite');

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

  it('dry-run previews one legacy notes file without mutating CouchDB, vault, or provenance', async () => {
    const dbName = 'pull-dry-run-vault';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });
    const body = '# Welcome\nThis is a recovered note.\n';
    await harness.seedLegacyNote(dbName, 'Welcome.md', body);

    const configPath = writeConfigFile(dbName);
    const preJson = await snapshotRemote(dbName);
    let output = '';

    const exitCode = await runPullCommand({
      configPath,
      dryRun: true,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    const report = JSON.parse(output.trim());
    expect(report.type).toBe('pull_report');
    expect(report.outcome).toBe(OutcomeCategory.SUCCESS);
    expect(report.dryRun).toBe(true);
    expect(report.actions.filter((action: { kind: string }) => action.kind === 'create')).toHaveLength(1);
    expect(report.actions.some((action: { kind: string; path?: string }) => action.kind === 'create' && action.path === 'Welcome.md')).toBe(true);

    const vaultEntries = fs.readdirSync(vaultDir);
    expect(vaultEntries).not.toContain('Welcome.md');

    const postJson = await snapshotRemote(dbName);
    expect(preJson.update_seq).toBe(postJson.update_seq);
    expect(preJson.doc_count).toBe(postJson.doc_count);

    const statePath = path.join(stateDir, 'admission.sqlite');
    if (fs.existsSync(statePath)) {
      const db = openDatabase(statePath);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_provenance'")
        .all() as { name: string }[];
      if (tables.length > 0) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM file_provenance').get() as { n: number };
        expect(count.n).toBe(0);
      }
      db.close();
    }
  });

  it('applies a valid all-create plan to an empty vault and records provenance without mutating CouchDB', async () => {
    const dbName = 'pull-apply-vault';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });
    const body = '# Welcome\nApplied from remote.\n';
    const seeded = await harness.seedLegacyNote(dbName, 'Welcome.md', body);

    const configPath = writeConfigFile(dbName);
    const preJson = await snapshotRemote(dbName);
    let output = '';

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
    expect(report.type).toBe('pull_report');
    expect(fs.readFileSync(path.join(vaultDir, 'Welcome.md'), 'utf8')).toBe(body);

    const statePath = path.join(stateDir, 'admission.sqlite');
    const db = openDatabase(statePath);
    const row = db
      .prepare('SELECT remote_revision FROM file_provenance WHERE path = ?')
      .get('Welcome.md') as { remote_revision: string } | undefined;
    expect(row?.remote_revision).toBe(seeded.rev);
    db.close();

    const postJson = await snapshotRemote(dbName);
    expect(preJson.update_seq).toBe(postJson.update_seq);
    expect(preJson.doc_count).toBe(postJson.doc_count);
  });
});
