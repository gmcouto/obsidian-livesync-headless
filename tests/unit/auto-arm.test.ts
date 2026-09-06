import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { AutoArmCoordinator } from '../../src/domain/auto-arm.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { ProvenanceRepository } from '../../src/storage/provenance-repo.js';
import { WriteGrantRepo } from '../../src/storage/write-grant-repo.js';
import { AdmissionRepository } from '../../src/storage/admission-repo.js';
import { loadConfig } from '../../src/config/loader.js';
import { parseCliArgs } from '../../src/cli/index.js';

describe('AutoArmCoordinator & LIVESYNC_WRITE=auto-arm', () => {
  let tmpDir: string;
  let vaultRoot: string;
  let statePath: string;
  const remoteFingerprint = 'test-fingerprint-123';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-arm-test-'));
    vaultRoot = path.join(tmpDir, 'vault');
    statePath = path.join(tmpDir, 'state.db');
    await fs.mkdir(vaultRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('Trigger detection', () => {
    it('triggers EMPTY_VAULT when vault is empty', async () => {
      const coordinator = new AutoArmCoordinator();
      const res = await coordinator.checkTrigger({
        vaultRoot,
        statePath,
        remoteFingerprint,
      });

      expect(res.shouldAutoArm).toBe(true);
      expect(res.code).toBe('EMPTY_VAULT');
      expect(res.reason).toContain('empty');
    });

    it('triggers EMPTY_STATE when state database does not exist', async () => {
      // Create a file in vault so vault is not empty
      await fs.writeFile(path.join(vaultRoot, 'note.md'), 'hello world');

      const coordinator = new AutoArmCoordinator();
      const res = await coordinator.checkTrigger({
        vaultRoot,
        statePath,
        remoteFingerprint,
      });

      expect(res.shouldAutoArm).toBe(true);
      expect(res.code).toBe('EMPTY_STATE');
      expect(res.reason).toContain('does not exist');
    });

    it('triggers EMPTY_STATE when state database has no provenance records', async () => {
      await fs.writeFile(path.join(vaultRoot, 'note.md'), 'hello world');
      const db = openDatabase(statePath);
      db.close();

      const coordinator = new AutoArmCoordinator();
      const res = await coordinator.checkTrigger({
        vaultRoot,
        statePath,
        remoteFingerprint,
      });

      expect(res.shouldAutoArm).toBe(true);
      expect(res.code).toBe('EMPTY_STATE');
      expect(res.reason).toContain('no recorded file provenance');
    });

    it('triggers EXCESSIVE_LOCAL_CHANGES when >= 10 new local files exist', async () => {
      const db = openDatabase(statePath);
      const provRepo = new ProvenanceRepository(db);
      // Save 1 existing provenance record
      provRepo.saveProvenance({
        path: 'existing.md',
        remoteRevision: '1-abc',
        contentSha256: crypto.createHash('sha256').update('old').digest('hex'),
        observedMtime: Date.now(),
        remoteFingerprint,
        reflectedAt: new Date().toISOString(),
      });
      const grantRepo = new WriteGrantRepo(db);
      grantRepo.issueGrant({
        remoteFingerprint,
        vaultRoot,
        settingsHash: 'hash',
        commonlibVersion: '0.1.21',
        bootstrapGeneration: '1',
      });
      db.close();

      // Create existing.md + 10 new files in vault
      await fs.writeFile(path.join(vaultRoot, 'existing.md'), 'old');
      for (let i = 1; i <= 10; i++) {
        await fs.writeFile(path.join(vaultRoot, `new-note-${i}.md`), `content ${i}`);
      }

      const coordinator = new AutoArmCoordinator();
      const res = await coordinator.checkTrigger({
        vaultRoot,
        statePath,
        remoteFingerprint,
        threshold: 10,
      });

      expect(res.shouldAutoArm).toBe(true);
      expect(res.code).toBe('EXCESSIVE_LOCAL_CHANGES');
      expect(res.localNewCount).toBe(10);
      expect(res.reason).toContain('exceed threshold');
    });

    it('triggers EXCESSIVE_LOCAL_CHANGES when >= 10 deleted local files exist', async () => {
      const db = openDatabase(statePath);
      const provRepo = new ProvenanceRepository(db);
      for (let i = 1; i <= 10; i++) {
        provRepo.saveProvenance({
          path: `note-${i}.md`,
          remoteRevision: `1-rev-${i}`,
          contentSha256: crypto.createHash('sha256').update(`content ${i}`).digest('hex'),
          observedMtime: Date.now(),
          remoteFingerprint,
          reflectedAt: new Date().toISOString(),
        });
      }
      const grantRepo = new WriteGrantRepo(db);
      grantRepo.issueGrant({
        remoteFingerprint,
        vaultRoot,
        settingsHash: 'hash',
        commonlibVersion: '0.1.21',
        bootstrapGeneration: '1',
      });
      db.close();

      // Vault only has 1 file, 10 recorded in provenance are deleted
      await fs.writeFile(path.join(vaultRoot, 'extra.md'), 'extra');

      const coordinator = new AutoArmCoordinator();
      const res = await coordinator.checkTrigger({
        vaultRoot,
        statePath,
        remoteFingerprint,
        threshold: 10,
      });

      expect(res.shouldAutoArm).toBe(true);
      expect(res.code).toBe('EXCESSIVE_LOCAL_CHANGES');
      expect(res.localDeletedCount).toBe(10);
    });

    it('triggers MISSING_WRITE_GRANT when vault and state are valid but write grant is missing', async () => {
      const content = 'clean file';
      const sha = crypto.createHash('sha256').update(content).digest('hex');
      await fs.writeFile(path.join(vaultRoot, 'note.md'), content);

      const db = openDatabase(statePath);
      const provRepo = new ProvenanceRepository(db);
      provRepo.saveProvenance({
        path: 'note.md',
        remoteRevision: '1-abc',
        contentSha256: sha,
        observedMtime: Date.now(),
        remoteFingerprint,
        reflectedAt: new Date().toISOString(),
      });
      db.close();

      const coordinator = new AutoArmCoordinator();
      const res = await coordinator.checkTrigger({
        vaultRoot,
        statePath,
        remoteFingerprint,
      });

      expect(res.shouldAutoArm).toBe(true);
      expect(res.code).toBe('MISSING_WRITE_GRANT');
    });

    it('does not trigger when vault, state, and write grant are all valid with < 10 changes', async () => {
      const content = 'clean file';
      const sha = crypto.createHash('sha256').update(content).digest('hex');
      await fs.writeFile(path.join(vaultRoot, 'note.md'), content);
      await fs.writeFile(path.join(vaultRoot, 'new1.md'), 'new1'); // 1 new file (< 10)

      const db = openDatabase(statePath);
      const provRepo = new ProvenanceRepository(db);
      provRepo.saveProvenance({
        path: 'note.md',
        remoteRevision: '1-abc',
        contentSha256: sha,
        observedMtime: Date.now(),
        remoteFingerprint,
        reflectedAt: new Date().toISOString(),
      });
      const grantRepo = new WriteGrantRepo(db);
      grantRepo.issueGrant({
        remoteFingerprint,
        vaultRoot,
        settingsHash: 'hash',
        commonlibVersion: '0.1.21',
        bootstrapGeneration: '1',
      });
      db.close();

      const coordinator = new AutoArmCoordinator();
      const res = await coordinator.checkTrigger({
        vaultRoot,
        statePath,
        remoteFingerprint,
        threshold: 10,
      });

      expect(res.shouldAutoArm).toBe(false);
      expect(res.code).toBe('NONE');
    });
  });

  describe('Cleanup & Validation', () => {
    it('cleanupLocalVault removes user files and subfolders while leaving directory intact', async () => {
      const coordinator = new AutoArmCoordinator();
      await fs.mkdir(path.join(vaultRoot, 'subfolder'), { recursive: true });
      await fs.writeFile(path.join(vaultRoot, 'subfolder', 'test.md'), 'data');
      await fs.writeFile(path.join(vaultRoot, 'root.md'), 'data');

      await coordinator.cleanupLocalVault(vaultRoot);

      const entries = await fs.readdir(vaultRoot);
      expect(entries.length).toBe(0);
    });

    it('cleanupLocalState removes state database and WAL files', async () => {
      const coordinator = new AutoArmCoordinator();
      await fs.writeFile(statePath, 'mock db');
      await fs.writeFile(`${statePath}-wal`, 'mock wal');
      await fs.writeFile(`${statePath}-shm`, 'mock shm');

      await coordinator.cleanupLocalState(statePath);

      let exists = true;
      try {
        await fs.stat(statePath);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it('validateSynchronization succeeds when disk matches provenance exactly', async () => {
      const coordinator = new AutoArmCoordinator();
      const content = 'synchronized content';
      const sha = crypto.createHash('sha256').update(content).digest('hex');
      await fs.writeFile(path.join(vaultRoot, 'synced.md'), content);

      const db = openDatabase(statePath);
      const provRepo = new ProvenanceRepository(db);
      provRepo.saveProvenance({
        path: 'synced.md',
        remoteRevision: '1-xyz',
        contentSha256: sha,
        observedMtime: Date.now(),
        remoteFingerprint,
        reflectedAt: new Date().toISOString(),
      });
      db.close();

      const validation = await coordinator.validateSynchronization(
        vaultRoot,
        statePath,
        remoteFingerprint
      );

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('validateSynchronization fails when disk file is missing or hash mismatches', async () => {
      const coordinator = new AutoArmCoordinator();
      const db = openDatabase(statePath);
      const provRepo = new ProvenanceRepository(db);
      provRepo.saveProvenance({
        path: 'missing.md',
        remoteRevision: '1-xyz',
        contentSha256: 'expected-hash',
        observedMtime: Date.now(),
        remoteFingerprint,
        reflectedAt: new Date().toISOString(),
      });
      db.close();

      const validation = await coordinator.validateSynchronization(
        vaultRoot,
        statePath,
        remoteFingerprint
      );

      expect(validation.valid).toBe(false);
      expect(validation.errors[0]).toContain('missing from local vault');
    });
  });

  describe('Configuration and CLI Parsing for auto-arm', () => {
    it('parses LIVESYNC_MODE=auto-arm from environment variables', async () => {
      const config = await loadConfig(undefined, {
        LIVESYNC_COUCHDB_URL: 'http://127.0.0.1:5984',
        LIVESYNC_COUCHDB_DATABASE: 'testdb',
        LIVESYNC_VAULT_PATH: vaultRoot,
        LIVESYNC_STATE_PATH: statePath,
        LIVESYNC_MODE: 'auto-arm',
      });

      expect(config.cli?.write).toBe('auto-arm');
      expect(config.cli?.autoArm).toBe(true);
    });

    it('parses LIVESYNC_MODE=write and LIVESYNC_MODE=read-only', async () => {
      const writeConfig = await loadConfig(undefined, {
        LIVESYNC_COUCHDB_URL: 'http://127.0.0.1:5984',
        LIVESYNC_COUCHDB_DATABASE: 'testdb',
        LIVESYNC_VAULT_PATH: vaultRoot,
        LIVESYNC_STATE_PATH: statePath,
        LIVESYNC_MODE: 'write',
      });
      expect(writeConfig.cli?.write).toBe(true);
      expect(writeConfig.cli?.autoArm).toBe(false);

      const roConfig = await loadConfig(undefined, {
        LIVESYNC_COUCHDB_URL: 'http://127.0.0.1:5984',
        LIVESYNC_COUCHDB_DATABASE: 'testdb',
        LIVESYNC_VAULT_PATH: vaultRoot,
        LIVESYNC_STATE_PATH: statePath,
        LIVESYNC_MODE: 'read-only',
      });
      expect(roConfig.cli?.write).toBe(false);
      expect(roConfig.cli?.autoArm).toBe(false);
    });

    it('supports backward compatible LIVESYNC_WRITE=auto-arm', async () => {
      const config = await loadConfig(undefined, {
        LIVESYNC_COUCHDB_URL: 'http://127.0.0.1:5984',
        LIVESYNC_COUCHDB_DATABASE: 'testdb',
        LIVESYNC_VAULT_PATH: vaultRoot,
        LIVESYNC_STATE_PATH: statePath,
        LIVESYNC_WRITE: 'auto-arm',
      });

      expect(config.cli?.write).toBe('auto-arm');
    });

    it('parses --auto-arm from CLI arguments', () => {
      const parsed = parseCliArgs(['daemon', '--auto-arm']);
      expect(parsed.command).toBe('daemon');
      expect(parsed.options.autoArm).toBe(true);
    });
  });
});
