import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { ContinuousEngine } from '../../src/daemon/continuous-engine.js';
import { ShutdownHandler } from '../../src/daemon/shutdown-handler.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { CheckpointRepository } from '../../src/storage/checkpoint-repo.js';
import { AdmissionRepository } from '../../src/storage/admission-repo.js';
import { computeFingerprint } from '../../src/livesync/negotiation.js';

describe('Daemon Shutdown Integration Tests', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-shut-test-'));
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

  it('drains tasks, commits state, and completes graceful shutdown on signal (DAEM-08)', async () => {
    const dbName = 'daemon-shut-graceful';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    // Seed notes
    await harness.seedLegacyNote(dbName, 'NoteA.md', '# Note A Content');
    await harness.seedLegacyNote(dbName, 'NoteB.md', '# Note B Content');

    const statePath = path.join(stateDir, 'state.sqlite');
    const fingerprint = computeFingerprint(harness.getBaseUrl().href, dbName);

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

    const engine = new ContinuousEngine({
      vaultRoot: vaultDir,
      statePath,
      baseUrl: harness.getBaseUrl(),
      databaseName: dbName,
      credentials: harness.getCredentials(),
      readOnly: true,
      periodicScanIntervalMs: 60000,
      debounceMs: 50,
    });

    await engine.start();

    let exitCodeReported: number | undefined;
    const logs: string[] = [];

    const shutdownHandler = new ShutdownHandler({
      engine,
      drainTimeoutMs: 5000,
      logger: (msg) => logs.push(msg),
      onShutdownComplete: (code) => {
        exitCodeReported = code;
      },
    });

    // Initiate shutdown via SIGTERM simulation
    await shutdownHandler.initiateShutdown('SIGTERM');

    expect(exitCodeReported).toBe(0);
    expect(engine.stateMachine.getState()).toBe('STOPPED');
    expect(logs.some((l) => l.includes('SIGTERM'))).toBe(true);
    expect(logs.some((l) => l.includes('Graceful shutdown completed'))).toBe(true);

    // Verify checkpoint is stored in SQLite
    const db = openDatabase(statePath);
    const checkpointRepo = new CheckpointRepository(db);
    const seq = checkpointRepo.getCheckpoint(fingerprint);
    expect(seq).not.toBeNull();
    db.close();
  }, 20000);

  it('forces immediate termination when double signal is received during draining (DAEM-08)', async () => {
    const dbName = 'daemon-shut-double';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    const statePath = path.join(stateDir, 'state.sqlite');
    const fingerprint = computeFingerprint(harness.getBaseUrl().href, dbName);

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

    const engine = new ContinuousEngine({
      vaultRoot: vaultDir,
      statePath,
      baseUrl: harness.getBaseUrl(),
      databaseName: dbName,
      credentials: harness.getCredentials(),
      readOnly: true,
      periodicScanIntervalMs: 60000,
    });

    await engine.start();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const shutdownHandler = new ShutdownHandler({
      engine,
      drainTimeoutMs: 5000,
      logger: () => {},
    });

    // First signal
    const p1 = shutdownHandler.initiateShutdown('SIGINT');
    // Second signal immediately
    await shutdownHandler.initiateShutdown('SIGINT');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();

    await p1.catch(() => {});
    await engine.stop().catch(() => {});
  }, 20000);
});
