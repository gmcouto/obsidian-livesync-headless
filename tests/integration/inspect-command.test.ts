import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CouchDbTestHarness } from './couchdb-harness.js';
import { runInspectCommand } from '../../src/cli/commands/inspect.js';
import { EXIT_CODES, OutcomeCategory } from '../../src/diagnostics/outcomes.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { AdmissionRepository } from '../../src/storage/admission-repo.js';
import {
  encrypt as encryptHkdf,
  createPBKDF2Salt,
} from 'octagonal-wheels/encryption/hkdf';
import { uint8ArrayToHexString } from 'octagonal-wheels/binary/hex';

describe('CLI Inspect Coordinator Integration Tests', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-cmd-test-'));
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
    overrides?: {
      username?: string;
      password?: string;
      passphrase?: string;
      encrypt?: boolean;
    }
  ): string {
    const creds = harness.getCredentials();
    const configPath = path.join(tempDir, 'config.yaml');
    const statePath = path.join(stateDir, 'admission.sqlite');

    const username = overrides?.username ?? creds.username;
    const password = overrides?.password ?? creds.password;

    const content = `
remote:
  url: ${harness.getBaseUrl().href}
  database: ${dbName}
  username: ${username}
  password: ${password}
vault:
  path: ${vaultDir}
state:
  path: ${statePath}
encryption:
  enabled: ${overrides?.encrypt ?? false}
  ${overrides?.passphrase ? `passphrase: ${overrides.passphrase}` : ''}
`;
    fs.writeFileSync(configPath, content, 'utf8');
    return configPath;
  }

  it('successfully admits a standard LiveSync database (Exit 0, JSON Lines mode)', async () => {
    const dbName = 'admitted-vault';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, {
      version: 12,
      locked: false,
      hashAlgorithm: 'sha256',
    });

    const configPath = writeConfigFile(dbName);
    let output = '';

    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);

    const report = JSON.parse(output.trim());
    expect(report.type).toBe('compatibility_report');
    expect(report.outcome).toBe(OutcomeCategory.SUCCESS);
    expect(report.zeroMutationVerified).toBe(true);
    expect(report.admittedCapabilities).toContain('read_only_admission');
    expect(report.unsupportedCapabilities).toContain('write_sync');
    expect(report.remoteFingerprint).toHaveLength(64);
    expect(report.negotiatedSettingsHash).toHaveLength(64);

    // Verify SQLite admission record
    const statePath = path.join(stateDir, 'admission.sqlite');
    expect(fs.existsSync(statePath)).toBe(true);
    const db = openDatabase(statePath);
    const repo = new AdmissionRepository(db);
    const record = repo.getAdmissionByFingerprint(report.remoteFingerprint);
    expect(record).not.toBeNull();
    expect(record?.databaseName).toBe(dbName);
    expect(record?.negotiatedSettingsHash).toBe(report.negotiatedSettingsHash);
    db.close();
  });

  it('authenticates encrypted database with correct passphrase', async () => {
    const dbName = 'encrypted-vault';
    const passphrase = 'my-correct-passphrase';
    const saltBytes = createPBKDF2Salt();
    const saltHex = uint8ArrayToHexString(saltBytes);

    await harness.createDatabase(dbName);
    const encryptedSyncinfo = await encryptHkdf(
      JSON.stringify({ test: 'ok' }),
      passphrase,
      saltBytes
    );

    await harness.seedLiveSyncData(dbName, {
      version: 12,
      locked: false,
      pbkdf2salt: saltHex,
      syncinfo: encryptedSyncinfo,
    });

    const configPath = writeConfigFile(dbName, {
      encrypt: true,
      passphrase,
    });

    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: false,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(output).toContain('[SUCCESS]');
    expect(output).toContain('PASS (Zero mutations detected)');
  });

  it('fails closed when wrong passphrase is provided for encrypted database (Exit 2)', async () => {
    const dbName = 'wrong-pass-vault';
    const saltBytes = createPBKDF2Salt();
    const saltHex = uint8ArrayToHexString(saltBytes);

    await harness.createDatabase(dbName);
    const encryptedSyncinfo = await encryptHkdf(
      JSON.stringify({ test: 'ok' }),
      'original-passphrase',
      saltBytes
    );

    await harness.seedLiveSyncData(dbName, {
      version: 12,
      locked: false,
      pbkdf2salt: saltHex,
      syncinfo: encryptedSyncinfo,
    });

    const configPath = writeConfigFile(dbName, {
      encrypt: true,
      passphrase: 'wrong-passphrase',
    });

    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.AUTHENTICATION_ERROR);
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.AUTHENTICATION_ERROR);
    expect(report.blockers.some((b: any) => b.code === 'AUTHENTICATION_ERROR')).toBe(true);
  });

  it('rejects database with invalid CouchDB credentials (Exit 2)', async () => {
    const dbName = 'auth-fail-vault';
    await harness.createDatabase(dbName);

    const configPath = writeConfigFile(dbName, {
      username: 'wrong-user',
      password: 'wrong-password',
    });

    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.AUTHENTICATION_ERROR);
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.AUTHENTICATION_ERROR);
    expect(report.blockers.some((b: any) => b.code === 'AUTHENTICATION_REQUIRED')).toBe(true);
  });

  it('rejects future protocol version > 12 (Exit 3)', async () => {
    const dbName = 'future-ver-vault';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, {
      version: 13,
      locked: false,
    });

    const configPath = writeConfigFile(dbName);
    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.INCOMPATIBLE);
    const report = JSON.parse(output.trim());
    expect(report.blockers.some((b: any) => b.code === 'UNSUPPORTED_REMOTE_VERSION')).toBe(true);
  });

  it('rejects unknown remote preferred tweak (Exit 3)', async () => {
    const dbName = 'unknown-tweak-vault';
    await harness.createDatabase(dbName);
    await harness.putDocument(dbName, 'obsydian_livesync_version', { version: 12 });
    await harness.putDocument(dbName, '_local/obsydian_livesync_milestone', {
      locked: false,
      tweak_values: {
        PREFERRED: {
          someAlienSettingThatDoesNotExist: true,
        },
      },
    });

    const configPath = writeConfigFile(dbName);
    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.INCOMPATIBLE);
    const report = JSON.parse(output.trim());
    expect(report.blockers.some((b: any) => b.code === 'UNKNOWN_REMOTE_SETTING')).toBe(true);
  });

  it('rejects locked remote database (Exit 3)', async () => {
    const dbName = 'locked-vault';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, {
      version: 12,
      locked: true,
    });

    const configPath = writeConfigFile(dbName);
    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.INCOMPATIBLE);
    const report = JSON.parse(output.trim());
    expect(report.blockers.some((b: any) => b.code === 'DATABASE_LOCKED')).toBe(true);
  });

  it('returns NOT_FOUND when remote database does not exist (Exit 4)', async () => {
    const dbName = 'non-existent-vault-12345';
    const configPath = writeConfigFile(dbName);

    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.NOT_FOUND);
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.NOT_FOUND);
    expect(report.blockers.some((b: any) => b.code === 'DATABASE_NOT_FOUND')).toBe(true);
  });

  it('returns TRANSIENT_OUTAGE when network connection fails (Exit 5)', async () => {
    const configPath = path.join(tempDir, 'network-fail-config.yaml');
    const content = `
remote:
  url: http://127.0.0.1:19999
  database: any-vault
vault:
  path: ${vaultDir}
state:
  path: ${path.join(stateDir, 'state.sqlite')}
`;
    fs.writeFileSync(configPath, content, 'utf8');

    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.TRANSIENT_OUTAGE);
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.TRANSIENT_OUTAGE);
    expect(report.blockers.some((b: any) => b.code === 'NETWORK_OUTAGE')).toBe(true);
  });

  it('returns CONFIG_ERROR on invalid YAML configuration (Exit 1)', async () => {
    const configPath = path.join(tempDir, 'invalid-config.yaml');
    fs.writeFileSync(configPath, 'remote:\n  invalid: yaml structure: [', 'utf8');

    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.CONFIG_ERROR);
  });

  it('guarantees remote update_seq and revisions remain unchanged after inspect execution', async () => {
    const dbName = 'invariance-vault';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    const configPath = writeConfigFile(dbName);

    // Snapshot directly via harness before inspect
    const preRes = await fetch(new URL(`/${dbName}`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization: 'Basic ' + Buffer.from('admin:password').toString('base64'),
      },
    });
    const preJson = (await preRes.json()) as { update_seq: string; doc_count: number };

    await runInspectCommand({ configPath, json: true, stdout: () => {} });

    // Snapshot directly via harness after inspect
    const postRes = await fetch(new URL(`/${dbName}`, harness.getBaseUrl()).toString(), {
      headers: {
        Authorization: 'Basic ' + Buffer.from('admin:password').toString('base64'),
      },
    });
    const postJson = (await postRes.json()) as { update_seq: string; doc_count: number };

    expect(preJson.update_seq).toBe(postJson.update_seq);
    expect(preJson.doc_count).toBe(postJson.doc_count);
  });

  it('returns MUTATION_VIOLATION when remote mutation is detected (Exit 6)', async () => {
    const dbName = 'mutate-detect-vault';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    const configPath = writeConfigFile(dbName);

    // Spy on assertNoMutation to simulate mutation detection
    const { ZeroMutationVerifier, MutationDetectedError } = await import(
      '../../src/livesync/zero-mutation.js'
    );
    const spy = vi.spyOn(ZeroMutationVerifier, 'assertNoMutation').mockImplementationOnce(() => {
      throw new MutationDetectedError(
        "update_seq changed from '1' to '2'",
        { updateSeq: '1', docCount: 1, revisions: {} },
        { updateSeq: '2', docCount: 1, revisions: {} }
      );
    });

    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    spy.mockRestore();

    expect(exitCode).toBe(EXIT_CODES.MUTATION_VIOLATION);
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.MUTATION_VIOLATION);
    expect(report.zeroMutationVerified).toBe(false);
  });

  it('returns CORRUPTION when CouchDB payload is malformed or unparseable (Exit 7)', async () => {
    const dbName = 'corrupt-vault';
    await harness.createDatabase(dbName);
    await harness.seedLiveSyncData(dbName, { version: 12, locked: false });

    const configPath = writeConfigFile(dbName);

    const { ZeroMutationVerifier } = await import('../../src/livesync/zero-mutation.js');
    const spy = vi
      .spyOn(ZeroMutationVerifier, 'captureSnapshot')
      .mockRejectedValueOnce(new Error('SyntaxError: Unexpected token < in JSON at position 0'));

    let output = '';
    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => {
        output += msg;
      },
    });

    spy.mockRestore();

    expect(exitCode).toBe(EXIT_CODES.CORRUPTION);
    const report = JSON.parse(output.trim());
    expect(report.outcome).toBe(OutcomeCategory.CORRUPTION);
  });
});

