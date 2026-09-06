import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { runArmCommand } from '../../src/cli/commands/arm.js';
import { runPullCommand } from '../../src/cli/commands/pull.js';
import { runSyncCommand } from '../../src/cli/commands/sync.js';
import { runDaemonCommand } from '../../src/cli/commands/daemon.js';
import { EXIT_CODES, OutcomeCategory } from '../../src/diagnostics/outcomes.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { ProvenanceRepository } from '../../src/storage/provenance-repo.js';
import type { ContinuousEngine } from '../../src/daemon/continuous-engine.js';
import type { ShutdownHandler } from '../../src/daemon/shutdown-handler.js';

describe('Mixed-Client Interoperability Integration Tests (Real CouchDB 3.5.2)', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-client-interop-test-'));
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

  function writeConfigFile(
    dbName: string,
    options?: {
      encryption?: { enabled: boolean; passphrase: string };
      usePathObfuscation?: boolean;
    }
  ): string {
    const creds = harness.getCredentials();
    const configPath = path.join(tempDir, 'config.yaml');
    const statePath = path.join(stateDir, 'state.sqlite');

    const encryptionBlock = options?.encryption
      ? `
encryption:
  enabled: ${options.encryption.enabled}
  passphrase: ${options.encryption.passphrase}
`
      : '';

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
${encryptionBlock}
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

  describe('Upstream LiveSync simulation harness helpers', () => {
    it('harness can write and read plain chunked notes with byte fidelity', async () => {
      const dbName = 'harness-plain-notes';
      await harness.createDatabase(dbName);
      await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

      const content = 'This is a plain chunked note created by upstream client simulation.'.repeat(10);
      const notePath = 'Notes/HarnessTest.md';

      const writeResult = await harness.writeUpstreamPlainNote(dbName, notePath, content, {
        chunkSize: 50,
      });

      expect(writeResult.id).toBeDefined();
      expect(writeResult.rev).toBeDefined();
      expect(writeResult.children.length).toBeGreaterThan(1);

      const readResult = await harness.readUpstreamNote(dbName, notePath);
      expect(readResult).not.toBeNull();
      expect(readResult?.path).toBe(notePath);
      expect(readResult?.content).toBe(content);
      expect(readResult?.deleted).toBe(false);
      expect(readResult?.children?.length).toBe(writeResult.children.length);
    });

    it('harness can write and read encrypted chunked notes with E2EE V2 HKDF', async () => {
      const dbName = 'harness-encrypted-notes';
      await harness.createDatabase(dbName);
      const saltHex = 'a1b2c3d4e5f60718';
      const passphrase = 'test-secret-passphrase';
      await harness.seedLiveSyncData(dbName, {
        version: 12,
        locked: false,
        pbkdf2salt: saltHex,
        hashAlgorithm: 'sha256',
      });

      const content = 'Confidential sensitive content across multiple chunks.'.repeat(10);
      const notePath = 'Private/Secret.md';

      const writeResult = await harness.writeUpstreamEncryptedNote(
        dbName,
        notePath,
        content,
        passphrase,
        saltHex,
        { chunkSize: 50 }
      );

      expect(writeResult.id).toBeDefined();
      expect(writeResult.children.length).toBeGreaterThan(1);

      // Verify raw CouchDB document is encrypted
      const rawDoc = await harness.getDocument(dbName, writeResult.id);
      expect(rawDoc).not.toBeNull();
      expect(rawDoc?.e_).toBe(true);
      expect(String(rawDoc?.path).startsWith('/\\:')).toBe(true);

      // Read back with passphrase
      const readResult = await harness.readUpstreamNote(dbName, notePath, {
        passphrase,
        saltHex,
      });
      expect(readResult).not.toBeNull();
      expect(readResult?.path).toBe(notePath);
      expect(readResult?.content).toBe(content);
      expect(readResult?.deleted).toBe(false);
    });

    it('harness can write and read path-obfuscated notes', async () => {
      const dbName = 'harness-obfuscated-notes';
      await harness.createDatabase(dbName);
      const saltHex = '1122334455667788';
      const passphrase = 'obfuscate-passphrase';
      await harness.seedLiveSyncData(dbName, {
        version: 12,
        locked: false,
        pbkdf2salt: saltHex,
        hashAlgorithm: 'sha256',
      });

      const content = 'Hidden note with obfuscated document ID in CouchDB';
      const notePath = 'Sensitive/Personal.md';

      const writeResult = await harness.writeUpstreamObfuscatedNote(
        dbName,
        notePath,
        content,
        passphrase,
        saltHex
      );

      expect(writeResult.id.startsWith('f:')).toBe(true);

      const readResult = await harness.readUpstreamNote(dbName, notePath, {
        passphrase,
        saltHex,
        isObfuscated: true,
      });
      expect(readResult).not.toBeNull();
      expect(readResult?.path).toBe(notePath);
      expect(readResult?.content).toBe(content);
      expect(readResult?.deleted).toBe(false);
    });

    it('harness can write logical deletions and detect deleted state', async () => {
      const dbName = 'harness-deletion-notes';
      await harness.createDatabase(dbName);
      await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

      const notePath = 'Obsolescent.md';
      await harness.writeUpstreamPlainNote(dbName, notePath, 'Temporary document');

      const delResult = await harness.writeUpstreamLogicalDeletion(dbName, notePath);
      expect(delResult.rev.startsWith('2-')).toBe(true);

      const readResult = await harness.readUpstreamNote(dbName, notePath);
      expect(readResult).not.toBeNull();
      expect(readResult?.deleted).toBe(true);
    });
  });
});
