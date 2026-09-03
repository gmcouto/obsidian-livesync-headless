import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { runPullCommand } from '../../src/cli/commands/pull.js';
import { EXIT_CODES, OutcomeCategory } from '../../src/diagnostics/outcomes.js';

describe('CLI Pull Apply Conflict Integration', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-apply-test-'));
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

  it('two live leaves exit CONFLICT 8 and leave the destination missing', async () => {
    const dbName = 'pull-apply-conflict-leaves';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });
    await harness.seedConflictingLegacyNotes(
      dbName,
      'Welcome.md',
      '# CouchDB winner\n',
      '# Other live leaf\n'
    );

    const configPath = writeConfigFile(dbName);
    let output = '';
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
    expect(report.actions.some((action: { kind: string }) => action.kind === 'create')).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, 'Welcome.md'))).toBe(false);
    expect(fs.readdirSync(vaultDir)).toEqual([]);
  });
});
