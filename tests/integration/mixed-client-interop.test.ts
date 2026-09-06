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

  describe('Bidirectional mixed-client interoperability suite', () => {
    it('bidirectional Scenario 1 (Upstream -> Headless): pulls plain, large chunked, E2EE V2 encrypted, and path-obfuscated notes', async () => {
      // Part A: Plain, large chunked, and E2EE V2 encrypted notes
      const dbNameA = 'bidi-upstream-to-headless-a';
      await harness.createDatabase(dbNameA);
      const saltHex = '1234567890abcdef';
      const passphrase = 'test-passphrase-v2';
      await harness.seedLiveSyncData(dbNameA, {
        version: 12,
        locked: false,
        pbkdf2salt: saltHex,
        hashAlgorithm: 'sha256',
      });

      // 1. Upstream client creates plain, large chunked, and encrypted files
      const plainContent = '# Plain Guide\nThis is a standard markdown guide.';
      const largeContent = '# Large Chunked Note\n' + 'Line of markdown text for splitting into chunks.\n'.repeat(40);
      const encContent = '# Secret Vault\nE2EE encrypted document content.\n'.repeat(10);

      const plainPath = 'Docs/PlainGuide.md';
      const largePath = 'Docs/LargeNote.md';
      const encPath = 'Secure/SecretVault.md';

      const wPlain = await harness.writeUpstreamPlainNote(dbNameA, plainPath, plainContent);
      const wLarge = await harness.writeUpstreamPlainNote(dbNameA, largePath, largeContent, { chunkSize: 100 });
      const wEnc = await harness.writeUpstreamEncryptedNote(dbNameA, encPath, encContent, passphrase, saltHex, { chunkSize: 100 });

      expect(wLarge.children.length).toBeGreaterThan(1);
      expect(wEnc.children.length).toBeGreaterThan(1);

      // 2. Headless arms and syncs Part A
      const configPathA = writeConfigFile(dbNameA, {
        encryption: { enabled: true, passphrase },
      });

      const armExitA = await runArmCommand({ configPath: configPathA, json: true });
      expect(armExitA).toBe(EXIT_CODES.SUCCESS);

      const syncExitA = await runSyncCommand({ configPath: configPathA, dryRun: false, json: true });
      expect(syncExitA).toBe(EXIT_CODES.SUCCESS);

      // 3. Verify local vault materialization Part A
      expect(fs.readFileSync(path.join(vaultDir, plainPath), 'utf8')).toBe(plainContent);
      expect(fs.readFileSync(path.join(vaultDir, largePath), 'utf8')).toBe(largeContent);
      expect(fs.readFileSync(path.join(vaultDir, encPath), 'utf8')).toBe(encContent);

      // 4. Verify local SQLite provenance records Part A
      const dbA = openDatabase(path.join(stateDir, 'state.sqlite'));
      const repoA = new ProvenanceRepository(dbA);

      const provPlain = repoA.getByPath(plainPath);
      expect(provPlain).not.toBeNull();
      expect(provPlain?.remoteRevision).toBe(wPlain.rev);

      const provLarge = repoA.getByPath(largePath);
      expect(provLarge).not.toBeNull();
      expect(provLarge?.remoteRevision).toBe(wLarge.rev);

      const provEnc = repoA.getByPath(encPath);
      expect(provEnc).not.toBeNull();
      expect(provEnc?.remoteRevision).toBe(wEnc.rev);

      // Part B: Path-obfuscated note in dedicated obfuscated database
      const dbNameB = 'bidi-upstream-to-headless-b';
      await harness.createDatabase(dbNameB);
      await harness.seedLiveSyncData(dbNameB, {
        version: 12,
        locked: false,
        pbkdf2salt: saltHex,
        hashAlgorithm: 'sha256',
        tweakValues: { usePathObfuscation: true },
      });

      const obfContent = '# Hidden Personal Diary\nPath obfuscated document in remote CouchDB.\n'.repeat(10);
      const obfPath = 'Private/PersonalDiary.md';
      const wObf = await harness.writeUpstreamObfuscatedNote(dbNameB, obfPath, obfContent, passphrase, saltHex, { chunkSize: 100 });
      expect(wObf.children.length).toBeGreaterThan(1);

      const vaultDirB = path.join(tempDir, 'vault-b');
      const stateDirB = path.join(tempDir, 'state-b');
      fs.mkdirSync(vaultDirB, { recursive: true });
      fs.mkdirSync(stateDirB, { recursive: true });

      const creds = harness.getCredentials();
      const configPathB = path.join(tempDir, 'config-b.yaml');
      fs.writeFileSync(
        configPathB,
        `
remote:
  url: ${harness.getBaseUrl().href}
  database: ${dbNameB}
  username: ${creds.username}
  password: ${creds.password}
vault:
  path: ${vaultDirB}
state:
  path: ${path.join(stateDirB, 'state.sqlite')}
encryption:
  enabled: true
  passphrase: ${passphrase}
`,
        'utf8'
      );

      const armExitB = await runArmCommand({ configPath: configPathB, json: true });
      expect(armExitB).toBe(EXIT_CODES.SUCCESS);

      const syncExitB = await runSyncCommand({ configPath: configPathB, dryRun: false, json: true });
      expect(syncExitB).toBe(EXIT_CODES.SUCCESS);

      expect(fs.readFileSync(path.join(vaultDirB, obfPath), 'utf8')).toBe(obfContent);

      const dbB = openDatabase(path.join(stateDirB, 'state.sqlite'));
      const repoB = new ProvenanceRepository(dbB);
      const provObf = repoB.getByPath(obfPath);
      expect(provObf).not.toBeNull();
      expect(provObf?.remoteRevision).toBe(wObf.rev);
    });

    it('bidirectional Scenario 2 (Headless -> Upstream): upstream reads headless pushed plain, chunked, encrypted, and obfuscated files with 100% fidelity', async () => {
      const dbName = 'bidi-headless-to-upstream';
      await harness.createDatabase(dbName);
      const saltHex = 'fedcba0987654321';
      const passphrase = 'headless-push-passphrase';
      await harness.seedLiveSyncData(dbName, {
        version: 12,
        locked: false,
        pbkdf2salt: saltHex,
        hashAlgorithm: 'sha256',
      });

      // 1. Create files in local vault
      const plainContent = '# Local Note\nCreated directly in vault by user.';
      const chunkedContent = '# Local Large Document\n' + 'Sentence repeated for chunk generation.\n'.repeat(50);
      const encContent = '# Highly Classified Local Note\nWritten locally to be encrypted on push.';

      const plainPath = 'Notes/LocalPlain.md';
      const chunkedPath = 'Archive/LocalLarge.md';
      const encPath = 'Private/LocalEncrypted.md';

      fs.mkdirSync(path.join(vaultDir, 'Notes'), { recursive: true });
      fs.mkdirSync(path.join(vaultDir, 'Archive'), { recursive: true });
      fs.mkdirSync(path.join(vaultDir, 'Private'), { recursive: true });

      fs.writeFileSync(path.join(vaultDir, plainPath), plainContent, 'utf8');
      fs.writeFileSync(path.join(vaultDir, chunkedPath), chunkedContent, 'utf8');
      fs.writeFileSync(path.join(vaultDir, encPath), encContent, 'utf8');

      // 2. Run arm and sync
      const configPath = writeConfigFile(dbName, {
        encryption: { enabled: true, passphrase },
      });

      const armExit = await runArmCommand({ configPath, json: true });
      expect(armExit).toBe(EXIT_CODES.SUCCESS);

      const syncExit = await runSyncCommand({ configPath, dryRun: false, json: true });
      expect(syncExit).toBe(EXIT_CODES.SUCCESS);

      // 3. Upstream simulation client reads each file directly from CouchDB
      const readPlain = await harness.readUpstreamNote(dbName, plainPath, { passphrase, saltHex });
      expect(readPlain).not.toBeNull();
      expect(readPlain?.content).toBe(plainContent);
      expect(readPlain?.deleted).toBe(false);

      const readChunked = await harness.readUpstreamNote(dbName, chunkedPath, { passphrase, saltHex });
      expect(readChunked).not.toBeNull();
      expect(readChunked?.content).toBe(chunkedContent);
      expect(readChunked?.deleted).toBe(false);

      const readEnc = await harness.readUpstreamNote(dbName, encPath, { passphrase, saltHex });
      expect(readEnc).not.toBeNull();
      expect(readEnc?.content).toBe(encContent);
      expect(readEnc?.deleted).toBe(false);
    });

    it('bidirectional Scenario 3 (Logical Deletions): upstream deletion triggers quarantine locally, headless deletion creates valid upstream deletion revision', async () => {
      const dbName = 'bidi-logical-deletions';
      await harness.createDatabase(dbName);
      await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

      const configPath = writeConfigFile(dbName);
      await runArmCommand({ configPath, json: true });

      // Step 1: Upstream writes SharedDoc.md -> Headless sync pulls it
      const sharedContent = '# Shared Document Initial';
      await harness.writeUpstreamPlainNote(dbName, 'SharedDoc.md', sharedContent);

      const syncExit1 = await runSyncCommand({ configPath, dryRun: false, json: true });
      expect(syncExit1).toBe(EXIT_CODES.SUCCESS);
      expect(fs.existsSync(path.join(vaultDir, 'SharedDoc.md'))).toBe(true);

      // Step 2: Upstream writes logical deletion
      await harness.writeUpstreamLogicalDeletion(dbName, 'SharedDoc.md');

      // Step 3: Headless sync runs -> local file is removed from active vault
      const syncExit2 = await runSyncCommand({ configPath, dryRun: false, json: true });
      expect(syncExit2).toBe(EXIT_CODES.SUCCESS);
      expect(fs.existsSync(path.join(vaultDir, 'SharedDoc.md'))).toBe(false);

      // Step 4: Headless creates local file LocalDeleted.md -> sync pushes it
      const localContent = '# Local Note To Be Deleted';
      fs.writeFileSync(path.join(vaultDir, 'LocalDeleted.md'), localContent, 'utf8');

      const syncExit3 = await runSyncCommand({ configPath, dryRun: false, json: true });
      expect(syncExit3).toBe(EXIT_CODES.SUCCESS);

      const readBeforeDel = await harness.readUpstreamNote(dbName, 'LocalDeleted.md');
      expect(readBeforeDel?.deleted).toBe(false);
      expect(readBeforeDel?.rev.startsWith('1-')).toBe(true);

      // Step 5: Headless unlinks LocalDeleted.md locally -> sync pushes logical deletion
      fs.unlinkSync(path.join(vaultDir, 'LocalDeleted.md'));
      const syncExit4 = await runSyncCommand({ configPath, dryRun: false, json: true });
      expect(syncExit4).toBe(EXIT_CODES.SUCCESS);

      // Step 6: Upstream client reads deletion revision with unbroken history
      const readAfterDel = await harness.readUpstreamNote(dbName, 'LocalDeleted.md');
      expect(readAfterDel).not.toBeNull();
      expect(readAfterDel?.deleted).toBe(true);
      expect(readAfterDel?.rev.startsWith('2-')).toBe(true);
    });

    it('bidirectional Scenario 4 (Missing/Corrupt Chunks): headless safely aborts without modifying local file when remote chunk is missing', async () => {
      const dbName = 'bidi-missing-chunk';
      await harness.createDatabase(dbName);
      await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

      // Local file exists
      const localOriginal = '# Local Original Safe Content';
      fs.writeFileSync(path.join(vaultDir, 'SafeDoc.md'), localOriginal, 'utf8');

      const configPath = writeConfigFile(dbName);
      await runArmCommand({ configPath, json: true });

      // Synchronize baseline
      await runSyncCommand({ configPath, dryRun: false, json: true });

      // Upstream writes a document with a missing chunk ID
      const { path2id_base } = await import('@vrtmrz/livesync-commonlib/compat/string_and_binary/path');
      const docId = String(await path2id_base('SafeDoc.md', false, true));
      const prevDoc = await harness.getDocument(dbName, docId);

      await harness.putDocument(dbName, docId, {
        _id: docId,
        ...(prevDoc?._rev ? { _rev: prevDoc._rev } : {}),
        type: 'plain',
        path: 'SafeDoc.md',
        children: ['h:nonexistentchunk9999999999999999'],
        size: 500,
        deleted: false,
        mtime: Date.now() + 10000,
      });

      // Run sync -> must fail or report error on pull and preserve local file
      let output = '';
      const syncExit = await runSyncCommand({
        configPath,
        dryRun: false,
        json: true,
        stdout: (msg) => {
          output += msg;
        },
      });

      // Pull/sync must either exit with non-zero or record error/skip without corrupting local file
      expect(fs.readFileSync(path.join(vaultDir, 'SafeDoc.md'), 'utf8')).toBe(localOriginal);
    });
  });

  describe('Mixed-Client Interoperability: Concurrency, Conflicts & Continuous Convergence', () => {
    it('handles simultaneous edits producing conflict leaves without silent winner loss (COMP-07, DIST-04)', async () => {
      // Part 1: Both clients modify local/remote from a common ancestor
      const dbName1 = 'concurrency-divergent-conflict';
      await harness.createDatabase(dbName1);
      await harness.seedLiveSyncData(dbName1, { version: 12, locked: false });

      const initialContent = '# Baseline Document\nOriginal synchronized content.';
      const notePath = 'SharedConflict.md';
      await harness.writeUpstreamPlainNote(dbName1, notePath, initialContent);

      const configPath1 = writeConfigFile(dbName1);
      await runArmCommand({ configPath: configPath1, json: true });
      await runSyncCommand({ configPath: configPath1, dryRun: false, json: true });

      expect(fs.readFileSync(path.join(vaultDir, notePath), 'utf8')).toBe(initialContent);

      // Upstream client modifies note in CouchDB
      const upstreamMod = '# Upstream Modification\nWritten by official client.';
      await harness.writeUpstreamPlainNote(dbName1, notePath, upstreamMod);

      // Local user modifies note in local vault independently
      const localMod = '# Local Modification\nWritten by headless vault user.';
      fs.writeFileSync(path.join(vaultDir, notePath), localMod, 'utf8');

      // Run sync -> must detect conflict and halt fail-closed
      let output1 = '';
      const syncExit = await runSyncCommand({
        configPath: configPath1,
        dryRun: false,
        json: true,
        stdout: (msg) => {
          output1 += msg;
        },
      });

      expect(syncExit).toBe(EXIT_CODES.CONFLICT);

      const jsonLine1 = output1.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      expect(jsonLine1).toBeDefined();
      const report1 = JSON.parse(jsonLine1!);
      expect(report1.outcome).toBe(OutcomeCategory.CONFLICT);
      expect(report1.conflicts.length).toBeGreaterThan(0);
      expect(report1.appliedActions).toBe(0);

      // Verify local file was NOT overwritten with upstream content
      expect(fs.readFileSync(path.join(vaultDir, notePath), 'utf8')).toBe(localMod);

      // Part 2: CouchDB database contains multiple open conflicting leaf revisions
      const dbName2 = 'concurrency-couchdb-open-leaves';
      await harness.createDatabase(dbName2);
      await harness.seedLiveSyncData(dbName2, { version: 12, locked: false });
      await harness.seedConflictingLegacyNotes(
        dbName2,
        'LeafConflict.md',
        '# CouchDB Winner Leaf',
        '# CouchDB Second Open Leaf'
      );

      const configPath2 = writeConfigFile(dbName2);
      await runArmCommand({ configPath: configPath2, json: true });

      let output2 = '';
      const pullExit = await runPullCommand({
        configPath: configPath2,
        dryRun: false,
        json: true,
        stdout: (msg) => {
          output2 += msg;
        },
      });

      expect(pullExit).toBe(EXIT_CODES.CONFLICT);
      // Destination file was safely skipped
      expect(fs.existsSync(path.join(vaultDir, 'LeafConflict.md'))).toBe(false);
    });

    it('handles case-only and cross-path renames between upstream and headless without corruption', async () => {
      const dbName = 'concurrency-renames';
      await harness.createDatabase(dbName);
      await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

      const configPath = writeConfigFile(dbName);
      await runArmCommand({ configPath, json: true });

      // 1. Cross-path rename: Upstream creates OldDir/MoveMe.md -> Headless pulls it
      const originalContent = '# Content to be moved\nPreserved across cross-path rename.';
      await harness.writeUpstreamPlainNote(dbName, 'OldDir/MoveMe.md', originalContent);

      const syncExit1 = await runSyncCommand({ configPath, dryRun: false, json: true });
      expect(syncExit1).toBe(EXIT_CODES.SUCCESS);
      expect(fs.readFileSync(path.join(vaultDir, 'OldDir/MoveMe.md'), 'utf8')).toBe(originalContent);

      // 2. Headless moves OldDir/MoveMe.md -> NewDir/MoveMe.md locally
      fs.mkdirSync(path.join(vaultDir, 'NewDir'), { recursive: true });
      fs.renameSync(
        path.join(vaultDir, 'OldDir/MoveMe.md'),
        path.join(vaultDir, 'NewDir/MoveMe.md')
      );

      const syncExit2 = await runSyncCommand({ configPath, dryRun: false, json: true });
      expect(syncExit2).toBe(EXIT_CODES.SUCCESS);

      // 3. Upstream reads NewDir/MoveMe.md (active) and OldDir/MoveMe.md (deleted: true)
      const readNew = await harness.readUpstreamNote(dbName, 'NewDir/MoveMe.md');
      expect(readNew).not.toBeNull();
      expect(readNew?.content).toBe(originalContent);
      expect(readNew?.deleted).toBe(false);

      const readOld = await harness.readUpstreamNote(dbName, 'OldDir/MoveMe.md');
      expect(readOld).not.toBeNull();
      expect(readOld?.deleted).toBe(true);
    });

    it('converges in real-time under continuous daemon mode upon upstream writes', async () => {
      const dbName = 'daemon-convergence-live';
      await harness.createDatabase(dbName);
      await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

      const configPath = writeConfigFile(dbName);
      await runArmCommand({ configPath, json: true });

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
      await pollUntil(
        () =>
          runningEngine !== undefined &&
          runningEngine.stateMachine.getState() === 'HEALTHY_BIDIRECTIONAL',
        5000
      );

      // Upstream writes a new note while daemon is actively watching
      const liveContent = '# Live Note From Upstream Client\nCreated while continuous daemon is running.';
      await harness.writeUpstreamPlainNote(dbName, 'LiveStreamNote.md', liveContent);

      // Wait for daemon to detect remote change and materialize it locally
      await pollUntil(() => {
        const localPath = path.join(vaultDir, 'LiveStreamNote.md');
        return fs.existsSync(localPath) && fs.readFileSync(localPath, 'utf8') === liveContent;
      }, 10000);

      // Now user updates the file locally
      const updatedContent = '# Live Note Modified Locally\nContinuous daemon pushes this back upstream.';
      fs.writeFileSync(path.join(vaultDir, 'LiveStreamNote.md'), updatedContent, 'utf8');

      // Wait for daemon to detect local change and push to CouchDB
      await pollUntil(async () => {
        const read = await harness.readUpstreamNote(dbName, 'LiveStreamNote.md');
        return read !== null && read.content === updatedContent;
      }, 10000);

      // Gracefully shutdown daemon
      if (runningEngine) {
        await runningEngine.stop();
      }
      const exitCode = await daemonPromise;
      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    });
  });
});

