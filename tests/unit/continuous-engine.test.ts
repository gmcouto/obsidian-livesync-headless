import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase } from '../../src/storage/sqlite.js';
import { AdmissionRepository } from '../../src/storage/admission-repo.js';
import { WriteGrantRepo } from '../../src/storage/write-grant-repo.js';
import { CheckpointRepository } from '../../src/storage/checkpoint-repo.js';
import { ContinuousEngine } from '../../src/daemon/continuous-engine.js';
import type { WriteCapability } from '../../src/security/capabilities.js';

describe('ContinuousEngine', () => {
  let tmpVault: string;
  let tmpStateDir: string;
  let statePath: string;
  const remoteFingerprint = 'fp-test-engine-123';

  beforeEach(async () => {
    tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'ols-engine-vault-'));
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ols-engine-state-'));
    statePath = path.join(tmpStateDir, 'state.sqlite');

    // Setup initial admission record in DB
    const db = openDatabase(statePath);
    const admissionRepo = new AdmissionRepository(db);
    admissionRepo.saveAdmission({
      remoteFingerprint,
      couchdbUrl: 'http://127.0.0.1:5984',
      databaseName: 'testdb',
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-v',
      milestoneRev: '1-m',
      negotiatedSettingsHash: 'shash-123',
      negotiatedSettingsJson: '{}',
      updateSeq: '0',
      admittedAt: new Date().toISOString(),
    });
    db.close();
  });

  afterEach(async () => {
    await fs.rm(tmpVault, { recursive: true, force: true });
    await fs.rm(tmpStateDir, { recursive: true, force: true });
  });

  it('fails preflight if no admission record exists', async () => {
    const freshDbPath = path.join(tmpStateDir, 'fresh.sqlite');
    const db = openDatabase(freshDbPath);
    db.close();

    const engine = new ContinuousEngine({
      vaultRoot: tmpVault,
      statePath: freshDbPath,
      baseUrl: new URL('http://127.0.0.1:5984'),
      databaseName: 'testdb',
      readOnly: true,
    });

    await expect(engine.start()).rejects.toThrow('No remote admission record found');
  });

  it('transitions to DEGRADED_READ_ONLY if active grant is invalid or revoked', async () => {
    // Setup mock fetch for one-shot sync catch-up pass
    const mockFetch: typeof globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
    } as unknown as Response);

    const capability: WriteCapability = {
      grantId: 'invalid-grant-id',
      remoteFingerprint,
      vaultRoot: tmpVault,
      settingsHash: 'shash-123',
      commonlibVersion: '0.1.21',
      bootstrapGeneration: 'gen-1',
      issuedAt: new Date().toISOString(),
    };

    const engine = new ContinuousEngine({
      vaultRoot: tmpVault,
      statePath,
      baseUrl: new URL('http://127.0.0.1:5984'),
      databaseName: 'testdb',
      capability,
      fetch: mockFetch,
    });

    await engine.start();

    // Grant was not recorded in SQLite write_grants table, so it degrades to read-only
    expect(engine.stateMachine.getState()).toBe('DEGRADED_READ_ONLY');
    expect(engine.stateMachine.isWritePermitted()).toBe(false);

    await engine.stop();
    expect(engine.stateMachine.getState()).toBe('STOPPED');
  });

  it('runs complete startup lifecycle and reaches HEALTHY_BIDIRECTIONAL with valid grant', async () => {
    const db = openDatabase(statePath);
    const grantRepo = new WriteGrantRepo(db);
    const grant = grantRepo.issueGrant({
      remoteFingerprint,
      vaultRoot: tmpVault,
      settingsHash: 'shash-123',
      commonlibVersion: '0.1.21',
      bootstrapGeneration: 'gen-1',
    });
    db.close();

    const mockFetch: typeof globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/_changes')) {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ rows: [] }),
      } as unknown as Response;
    });

    const capability: WriteCapability = {
      grantId: grant.grantId,
      remoteFingerprint,
      vaultRoot: tmpVault,
      settingsHash: 'shash-123',
      commonlibVersion: '0.1.21',
      bootstrapGeneration: 'gen-1',
      issuedAt: grant.issuedAt,
    };

    const engine = new ContinuousEngine({
      vaultRoot: tmpVault,
      statePath,
      baseUrl: new URL('http://127.0.0.1:5984'),
      databaseName: 'testdb',
      capability,
      fetch: mockFetch,
    });

    await engine.start();

    expect(engine.stateMachine.getState()).toBe('HEALTHY_BIDIRECTIONAL');
    expect(engine.stateMachine.isWritePermitted()).toBe(true);

    await engine.stop();
    expect(engine.stateMachine.getState()).toBe('STOPPED');
  });
});
