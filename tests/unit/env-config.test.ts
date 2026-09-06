import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { main } from '../../src/cli/index.js';
import { computeFingerprint } from '../../src/livesync/negotiation.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { AdmissionRepository } from '../../src/storage/admission-repo.js';
import { WriteGrantRepo } from '../../src/storage/write-grant-repo.js';
import { EXIT_CODES } from '../../src/diagnostics/outcomes.js';

describe('CLI Environment Variable Dispatch Tests (ENV-01)', () => {
  let tempDir: string;
  let vaultDir: string;
  let stateDbPath: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'livesync-env-cli-test-'));
    vaultDir = path.join(tempDir, 'vault');
    stateDbPath = path.join(tempDir, 'state.sqlite');
    await fs.mkdir(vaultDir, { recursive: true });

    // Set standard environment variables
    process.env.LIVESYNC_COUCHDB_URL = 'http://127.0.0.1:5984';
    process.env.LIVESYNC_COUCHDB_DATABASE = 'testdb';
    process.env.LIVESYNC_COUCHDB_USER = 'admin';
    process.env.LIVESYNC_COUCHDB_PASSWORD = 'password';
    process.env.LIVESYNC_VAULT_PATH = vaultDir;
    process.env.LIVESYNC_DATABASE_PATH = stateDbPath;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs "status" command purely through environment variables without --config', async () => {
    const fingerprint = computeFingerprint('http://127.0.0.1:5984/', 'testdb');

    // Seed SQLite admission and grant
    const db = openDatabase(stateDbPath);
    const admissionRepo = new AdmissionRepository(db);
    admissionRepo.saveAdmission({
      remoteFingerprint: fingerprint,
      couchdbUrl: 'http://127.0.0.1:5984',
      databaseName: 'testdb',
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-v',
      milestoneRev: '1-m',
      negotiatedSettingsHash: 'settings-hash-1',
      negotiatedSettingsJson: '{}',
      updateSeq: '10',
      admittedAt: new Date().toISOString(),
    });

    const grantRepo = new WriteGrantRepo(db);
    grantRepo.issueGrant({
      vaultRoot: vaultDir,
      remoteFingerprint: fingerprint,
      settingsHash: 'settings-hash-1',
      commonlibVersion: '0.1.21',
      bootstrapGeneration: '1-v:1-m',
    });
    db.close();

    let stdout = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout += String(chunk);
      return true;
    });

    const exitCode = await main(['status', '--json']);
    stdoutSpy.mockRestore();

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(stdout).toContain('"outcome":"SUCCESS"');
    expect(stdout).toContain(fingerprint);
  });

  it('runs "daemon" command purely through environment variables without --config', async () => {
    // Seed admission in SQLite
    const fingerprint = computeFingerprint('http://127.0.0.1:5984/', 'testdb');
    const db = openDatabase(stateDbPath);
    const admissionRepo = new AdmissionRepository(db);
    admissionRepo.saveAdmission({
      remoteFingerprint: fingerprint,
      couchdbUrl: 'http://127.0.0.1:5984',
      databaseName: 'testdb',
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-v',
      milestoneRev: '1-m',
      negotiatedSettingsHash: 'settings-hash-1',
      negotiatedSettingsJson: '{}',
      updateSeq: '10',
      admittedAt: new Date().toISOString(),
    });
    db.close();

    let stdout = '';
    let stderr = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout += String(chunk);
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderr += String(chunk);
      return true;
    });

    const exitCode = await main(['daemon', '--write']);
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    // With admission present and --write specified without a write grant, it rejects with CONFIG_ERROR
    expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(stderr).toContain('No active write grant found');
  });

  it('runs "pull --dry-run" purely through environment variables without --config', async () => {
    const exitCode = await main(['pull', '--dry-run', '--json']);
    // Since CouchDB mock/server is not running, we expect a network/transient outage or probe response, NOT a CONFIG_ERROR
    expect(exitCode).not.toBe(EXIT_CODES.CONFIG_ERROR);
  });

  it('runs "sync --dry-run" purely through environment variables without --config', async () => {
    const exitCode = await main(['sync', '--dry-run', '--json']);
    expect(exitCode).not.toBe(EXIT_CODES.CONFIG_ERROR);
  });

  it('runs "inspect" (default command) purely through environment variables without --config', async () => {
    const exitCode = await main(['--json']);
    expect(exitCode).not.toBe(EXIT_CODES.CONFIG_ERROR);
  });

  it('runs "arm" purely through environment variables without --config', async () => {
    const exitCode = await main(['arm', '--json']);
    expect(exitCode).not.toBe(EXIT_CODES.CONFIG_ERROR);
  });
});
