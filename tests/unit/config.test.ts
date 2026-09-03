import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { loadConfig, ConfigValidationError } from '../../src/config/loader.js';
import { SecretRedactor } from '../../src/security/redaction.js';

describe('Safe YAML Configuration Loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'livesync-config-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('successfully loads a valid YAML configuration with relative paths', async () => {
    const configPath = path.join(tempDir, 'valid.yaml');
    const vaultPath = path.join(tempDir, 'my-vault');
    const statePath = path.join(tempDir, 'my-state');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "obsidian-sync"
  username: "testuser"
vault:
  path: "${vaultPath}"
state:
  path: "${statePath}"
encryption:
  enabled: false
`
    );

    const config = await loadConfig(configPath, {});
    expect(config.remote.url).toBe('http://127.0.0.1:5984');
    expect(config.remote.database).toBe('obsidian-sync');
    expect(config.remote.username).toBe('testuser');
    expect(config.resolvedVaultPath).toBe(vaultPath);
    expect(config.resolvedStatePath).toBe(statePath);
    expect(config.encryption?.enabled).toBe(false);
  });

  it('resolves secrets via fromEnv and registers with redactor', async () => {
    const configPath = path.join(tempDir, 'env-secret.yaml');
    const vaultPath = path.join(tempDir, 'my-vault');
    const statePath = path.join(tempDir, 'my-state');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
  password:
    fromEnv: "CUSTOM_DB_PASS"
vault:
  path: "${vaultPath}"
state:
  path: "${statePath}"
encryption:
  enabled: true
  passphrase:
    fromEnv: "CUSTOM_PASSPHRASE"
`
    );

    const redactor = new SecretRedactor();
    const env = {
      CUSTOM_DB_PASS: 'top-secret-couch-pass',
      CUSTOM_PASSPHRASE: 'top-secret-encryption-phrase',
    };

    const config = await loadConfig(configPath, env, redactor);
    expect(config.resolvedSecrets.remotePassword).toBe('top-secret-couch-pass');
    expect(config.resolvedSecrets.encryptionPassphrase).toBe('top-secret-encryption-phrase');

    // Verify redactor registered these secrets
    expect(redactor.redactString('Error with top-secret-couch-pass')).toBe('Error with [REDACTED]');
    expect(redactor.redactString('Phrase: top-secret-encryption-phrase')).toBe('Phrase: [REDACTED]');
  });

  it('resolves secrets via fromFile and trims trailing whitespace', async () => {
    const secretFile = path.join(tempDir, 'password.txt');
    await fs.writeFile(secretFile, 'super-file-secret\n\n');

    const configPath = path.join(tempDir, 'file-secret.yaml');
    const vaultPath = path.join(tempDir, 'my-vault');
    const statePath = path.join(tempDir, 'my-state');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
  password:
    fromFile: "${secretFile}"
vault:
  path: "${vaultPath}"
state:
  path: "${statePath}"
`
    );

    const config = await loadConfig(configPath, {});
    expect(config.resolvedSecrets.remotePassword).toBe('super-file-secret');
  });

  it('resolves fallback environment variables COUCHDB_PASSWORD and LIVESYNC_PASSPHRASE', async () => {
    const configPath = path.join(tempDir, 'fallback-env.yaml');
    const vaultPath = path.join(tempDir, 'my-vault');
    const statePath = path.join(tempDir, 'my-state');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
vault:
  path: "${vaultPath}"
state:
  path: "${statePath}"
encryption:
  enabled: true
`
    );

    const env = {
      COUCHDB_PASSWORD: 'fallback-couch-pass',
      LIVESYNC_PASSPHRASE: 'fallback-livesync-pass',
    };

    const config = await loadConfig(configPath, env);
    expect(config.resolvedSecrets.remotePassword).toBe('fallback-couch-pass');
    expect(config.resolvedSecrets.encryptionPassphrase).toBe('fallback-livesync-pass');
  });

  it('throws ConfigValidationError if fromEnv variable is missing', async () => {
    const configPath = path.join(tempDir, 'missing-env.yaml');
    const vaultPath = path.join(tempDir, 'my-vault');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
  password:
    fromEnv: "NONEXISTENT_VAR"
vault:
  path: "${vaultPath}"
`
    );

    await expect(loadConfig(configPath, {})).rejects.toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError if fromFile is missing or unreadable', async () => {
    const configPath = path.join(tempDir, 'missing-file.yaml');
    const vaultPath = path.join(tempDir, 'my-vault');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
  password:
    fromFile: "/non/existent/secret/path"
vault:
  path: "${vaultPath}"
`
    );

    await expect(loadConfig(configPath, {})).rejects.toThrow(ConfigValidationError);
  });

  it('rejects embedded credentials in CouchDB URLs', async () => {
    const configPath = path.join(tempDir, 'embedded-creds.yaml');
    const vaultPath = path.join(tempDir, 'my-vault');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://admin:secret@127.0.0.1:5984"
  database: "vault-db"
vault:
  path: "${vaultPath}"
`
    );

    await expect(loadConfig(configPath, {})).rejects.toThrow(/CouchDB URL must not contain embedded username or password/);
  });

  it('rejects invalid CouchDB database names', async () => {
    const configPath = path.join(tempDir, 'bad-db.yaml');
    const vaultPath = path.join(tempDir, 'my-vault');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "UPPERCASE_INVALID"
vault:
  path: "${vaultPath}"
`
    );

    await expect(loadConfig(configPath, {})).rejects.toThrow(/Invalid CouchDB database name format/);
  });

  it('strictly rejects unknown top-level and nested configuration keys', async () => {
    const configPath = path.join(tempDir, 'unknown-keys.yaml');
    const vaultPath = path.join(tempDir, 'my-vault');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
  extraRemoteKey: true
vault:
  path: "${vaultPath}"
unknownRootKey: "danger"
`
    );

    await expect(loadConfig(configPath, {})).rejects.toThrow(/Configuration validation failed/);
  });

  it('rejects vault destination set to system root directory', async () => {
    const configPath = path.join(tempDir, 'root-vault.yaml');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
vault:
  path: "/"
`
    );

    await expect(loadConfig(configPath, {})).rejects.toThrow(/Vault path cannot be the root filesystem directory/);
  });

  it('rejects vault destination set to user home directory', async () => {
    const configPath = path.join(tempDir, 'home-vault.yaml');
    const fakeHome = path.join(tempDir, 'fakehome');
    await fs.mkdir(fakeHome, { recursive: true });

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
vault:
  path: "${fakeHome}"
`
    );

    await expect(loadConfig(configPath, { HOME: fakeHome })).rejects.toThrow(
      /Vault path cannot be the user home directory/
    );
  });

  it('rejects parent directory traversal escape that resolves to root', async () => {
    const configPath = path.join(tempDir, 'traversal-root.yaml');

    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
vault:
  path: "/../../../../../../"
`
    );

    await expect(loadConfig(configPath, {})).rejects.toThrow(/Vault path cannot be the root filesystem directory/);
  });

  it('rejects overlapping vault and state directories', async () => {
    const vaultPath = path.join(tempDir, 'vault');
    const statePathInsideVault = path.join(vaultPath, 'nested-state');

    const configPath = path.join(tempDir, 'overlap.yaml');
    await fs.writeFile(
      configPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "vault-db"
vault:
  path: "${vaultPath}"
state:
  path: "${statePathInsideVault}"
`
    );

    await expect(loadConfig(configPath, {})).rejects.toThrow(
      /Vault directory and state directory must not overlap/
    );
  });

  it('rejects invalid YAML syntax', async () => {
    const configPath = path.join(tempDir, 'malformed.yaml');
    await fs.writeFile(configPath, 'remote:\n  url: [unclosed list\n');

    await expect(loadConfig(configPath, {})).rejects.toThrow(/YAML syntax error/);
  });
});
