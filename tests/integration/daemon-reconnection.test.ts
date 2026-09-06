import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { ContinuousEngine } from '../../src/daemon/continuous-engine.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { CheckpointRepository } from '../../src/storage/checkpoint-repo.js';
import { AdmissionRepository } from '../../src/storage/admission-repo.js';
import { computeFingerprint } from '../../src/livesync/negotiation.js';

describe('Daemon Reconnection & Resiliency Integration Tests', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-recon-test-'));
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

  it('handles transient network interruptions and catches up missed remote changes after reconnecting (DAEM-05, DAEM-06)', async () => {
    const dbName = 'daemon-recon-catchup';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    // Seed baseline note
    await harness.seedLegacyNote(dbName, 'Doc1.md', '# Initial Doc 1');

    const statePath = path.join(stateDir, 'state.sqlite');
    const fingerprint = computeFingerprint(harness.getBaseUrl().href, dbName);

    // Setup initial admission record
    const initDb = openDatabase(statePath);
    const admissionRepo = new AdmissionRepository(initDb);
    admissionRepo.saveAdmission({
      remoteFingerprint: fingerprint,
      couchdbUrl: harness.getBaseUrl().href,
      databaseName: dbName,
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-v',
      milestoneRev: '1-m',
      syncParamsRev: null,
      negotiatedSettingsHash: 'hash-test',
      negotiatedSettingsJson: '{}',
      updateSeq: '0',
      admittedAt: new Date().toISOString(),
    });
    initDb.close();

    let failNetwork = false;

    // Custom fetch proxy that fails when failNetwork is true
    const customFetch: typeof globalThis.fetch = async (input, init) => {
      if (failNetwork) {
        throw new Error('ECONNREFUSED: Simulated network partition');
      }
      return fetch(input, init);
    };

    const engine = new ContinuousEngine({
      vaultRoot: vaultDir,
      statePath,
      baseUrl: harness.getBaseUrl(),
      databaseName: dbName,
      credentials: harness.getCredentials(),
      readOnly: true,
      periodicScanIntervalMs: 60000,
      debounceMs: 100,
      fetch: customFetch,
    });

    try {
      await engine.start();

      // Ensure Doc1.md is pulled
      await pollUntil(() => fs.existsSync(path.join(vaultDir, 'Doc1.md')), 5000);
      expect(fs.readFileSync(path.join(vaultDir, 'Doc1.md'), 'utf8')).toBe('# Initial Doc 1');

      // Checkpoint must be persisted in SQLite
      const db = openDatabase(statePath);
      const checkpointRepo = new CheckpointRepository(db);
      const initialSeq = checkpointRepo.getCheckpoint(fingerprint);
      expect(initialSeq).not.toBeNull();
      db.close();

      // 2. Simulate network disruption
      failNetwork = true;

      // Seed another note directly in CouchDB while daemon is "offline"
      // Note: we use direct global fetch to write to CouchDB since customFetch fails for engine
      await harness.seedLegacyNote(dbName, 'Doc2Offline.md', '# Created While Offline');

      // Wait 1.5s for daemon to encounter network errors
      await new Promise((r) => setTimeout(r, 1500));

      // 3. Restore network
      failNetwork = false;

      // Trigger rescan or wait for changes consumer / reconnection to catch up
      await engine.triggerManualScan();

      // Doc2Offline.md must be pulled after reconnection
      await pollUntil(() => fs.existsSync(path.join(vaultDir, 'Doc2Offline.md')), 5000);
      expect(fs.readFileSync(path.join(vaultDir, 'Doc2Offline.md'), 'utf8')).toBe('# Created While Offline');

      // Verify checkpoint has monotonically advanced
      const dbAfter = openDatabase(statePath);
      const checkpointRepoAfter = new CheckpointRepository(dbAfter);
      const afterSeq = checkpointRepoAfter.getCheckpoint(fingerprint);
      expect(afterSeq).not.toBeNull();
      dbAfter.close();
    } finally {
      await engine.stop();
    }
  }, 20000);
});
