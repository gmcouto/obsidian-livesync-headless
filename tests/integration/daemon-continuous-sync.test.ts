import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { runArmCommand } from '../../src/cli/commands/arm.js';
import { runInspectCommand } from '../../src/cli/commands/inspect.js';
import { runDaemonCommand } from '../../src/cli/commands/daemon.js';
import { EXIT_CODES } from '../../src/diagnostics/outcomes.js';
import type { ContinuousEngine } from '../../daemon/continuous-engine.js';
import type { ShutdownHandler } from '../../daemon/shutdown-handler.js';

describe('Daemon Continuous Sync Integration Tests (Real CouchDB 3.5.2)', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-sync-test-'));
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

  async function pollUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
    intervalMs = 100
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) {
        return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
  }

  it('performs live bidirectional sync: local push, remote pull, deletion, and zero ping-pong loop (DAEM-01, DAEM-03, DAEM-04)', async () => {
    const dbName = 'daemon-bidi-live';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    const configPath = writeConfigFile(dbName);

    // 1. Arm write grant
    const armExit = await runArmCommand({ configPath, json: true });
    expect(armExit).toBe(EXIT_CODES.SUCCESS);

    let runningEngine: ContinuousEngine | undefined;
    let runningShutdown: ShutdownHandler | undefined;

    const daemonPromise = runDaemonCommand({
      configPath,
      write: true,
      debounceMs: 100,
      periodicScanSec: 300,
      registerSignalHandlers: false,
      onEngineReady: (engine, shutdown) => {
        runningEngine = engine;
        runningShutdown = shutdown;
      },
    });

    // Wait for engine to start
    await pollUntil(() => runningEngine !== undefined && runningEngine.stateMachine.getState() === 'HEALTHY_BIDIRECTIONAL');

    try {
      // Step A: Local Push -> CouchDB receives chunk-first note
      const localContent = '# Live Local Creation\nContinuous sync works!';
      fs.writeFileSync(path.join(vaultDir, 'LiveLocal.md'), localContent, 'utf8');

      // Poll CouchDB for LiveLocal.md doc
      const creds = harness.getCredentials();
      const authHeader = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
      const docUrl = new URL(`/${dbName}/livelocal.md`, harness.getBaseUrl()).toString();

      await pollUntil(async () => {
        const res = await fetch(docUrl, { headers: { Authorization: authHeader } });
        return res.status === 200;
      }, 5000);

      const docRes = await fetch(docUrl, { headers: { Authorization: authHeader } });
      const localDoc = (await docRes.json()) as any;
      expect(localDoc.path).toBe('LiveLocal.md');
      expect(localDoc.deleted).toBe(false);

      // Step B: Remote Push -> Vault receives note
      const remoteBody = '# Live Remote Note\nCreated directly in CouchDB';
      await harness.seedLegacyNote(dbName, 'LiveRemote.md', remoteBody);

      await pollUntil(() => {
        return fs.existsSync(path.join(vaultDir, 'LiveRemote.md'));
      }, 5000);

      expect(fs.readFileSync(path.join(vaultDir, 'LiveRemote.md'), 'utf8')).toBe(remoteBody);

      // Step C: Verify Loop Suppression (Zero Ping-Pong)
      // Capture initial revision
      const revBefore = localDoc._rev;
      // Wait 1.5 seconds and ensure no new revisions generated for LiveLocal.md
      await new Promise((r) => setTimeout(r, 1500));
      const stableRes = await fetch(docUrl, { headers: { Authorization: authHeader } });
      const stableDoc = (await stableRes.json()) as any;
      expect(stableDoc._rev).toBe(revBefore);

      // Step D: Local Deletion -> Logical Deletion on CouchDB
      fs.unlinkSync(path.join(vaultDir, 'LiveLocal.md'));

      await pollUntil(async () => {
        const res = await fetch(docUrl, { headers: { Authorization: authHeader } });
        if (!res.ok) return false;
        const body = (await res.json()) as any;
        return body.deleted === true;
      }, 5000);

      const delRes = await fetch(docUrl, { headers: { Authorization: authHeader } });
      const delDoc = (await delRes.json()) as any;
      expect(delDoc.deleted).toBe(true);
      expect(delDoc._rev.startsWith('2-') || delDoc._rev.startsWith('3-')).toBe(true);
    } finally {
      if (runningEngine) {
        await runningEngine.stop();
      }
      await daemonPromise;
    }
  }, 20000);

  it('runs cleanly in read-only mode (pull-only) without requiring arming grant (DAEM-01, DAEM-07)', async () => {
    const dbName = 'daemon-readonly-live';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    // Seed a note
    await harness.seedLegacyNote(dbName, 'ReadOnlyNote.md', '# Read Only Content');

    const configPath = writeConfigFile(dbName);

    // Admit database first via inspect (DAEM-01)
    const inspectExit = await runInspectCommand({ configPath, json: true });
    expect(inspectExit).toBe(EXIT_CODES.SUCCESS);

    let runningEngine: ContinuousEngine | undefined;

    const daemonPromise = runDaemonCommand({
      configPath,
      write: false,
      debounceMs: 100,
      periodicScanSec: 300,
      registerSignalHandlers: false,
      onEngineReady: (engine) => {
        runningEngine = engine;
      },
    });

    await pollUntil(() => runningEngine !== undefined && runningEngine.stateMachine.getState() === 'DEGRADED_READ_ONLY');

    try {
      // Note should be pulled down
      await pollUntil(() => fs.existsSync(path.join(vaultDir, 'ReadOnlyNote.md')), 5000);
      expect(fs.readFileSync(path.join(vaultDir, 'ReadOnlyNote.md'), 'utf8')).toBe('# Read Only Content');

      // Local writes should NOT be pushed
      fs.writeFileSync(path.join(vaultDir, 'LocalIgnored.md'), '# Should not push', 'utf8');
      await new Promise((r) => setTimeout(r, 1000));

      const creds = harness.getCredentials();
      const authHeader = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
      const docUrl = new URL(`/${dbName}/localignored.md`, harness.getBaseUrl()).toString();
      const res = await fetch(docUrl, { headers: { Authorization: authHeader } });
      expect(res.status).toBe(404);
    } finally {
      if (runningEngine) {
        await runningEngine.stop();
      }
      await daemonPromise;
    }
  }, 20000);
});
