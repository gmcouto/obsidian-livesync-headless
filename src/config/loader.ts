import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import {
  LiveSyncConfigSchema,
  type LiveSyncConfig,
  type LoadedConfig,
  type ResolvedSecrets,
} from './schema.js';
import { resolveSecret } from './secrets.js';
import type { SecretRedactor } from '../security/redaction.js';

export class ConfigValidationError extends Error {
  readonly issues?: readonly string[];

  constructor(message: string, issues?: readonly string[]) {
    super(message);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export async function loadConfig(
  configFilePath: string,
  env: NodeJS.ProcessEnv = process.env,
  redactor?: SecretRedactor
): Promise<LoadedConfig> {
  const resolvedConfigPath = path.resolve(configFilePath);
  let fileContent: string;

  try {
    fileContent = await fs.readFile(resolvedConfigPath, 'utf-8');
  } catch (err) {
    throw new ConfigValidationError(
      `Failed to read configuration file '${configFilePath}': ${(err as Error).message}`
    );
  }

  // Parse YAML strictly
  const doc = yaml.parseDocument(fileContent, { prettyErrors: true });
  if (doc.errors && doc.errors.length > 0) {
    const errorMessages = doc.errors.map((e) => e.message);
    throw new ConfigValidationError(
      `YAML syntax error in '${configFilePath}': ${errorMessages.join('; ')}`,
      errorMessages
    );
  }

  const rawObj = doc.toJS();
  if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
    throw new ConfigValidationError('Configuration must be a YAML mapping');
  }

  const rawConfig = rawObj as Record<string, any>;
  const configDir = path.dirname(resolvedConfigPath);

  // Validate strict schema structure before resolving or path checking
  const parseResult = LiveSyncConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((issue) => {
      const fieldPath = issue.path.join('.');
      return fieldPath ? `${fieldPath}: ${issue.message}` : issue.message;
    });
    throw new ConfigValidationError(
      `Configuration validation failed:\n- ${issues.join('\n- ')}`,
      issues
    );
  }

  const config: LiveSyncConfig = parseResult.data;

  // Resolve secrets
  let remotePassword: string | undefined;
  try {
    remotePassword = await resolveSecret(
      config.remote.password,
      env,
      'COUCHDB_PASSWORD',
      configDir
    );
  } catch (err) {
    throw new ConfigValidationError((err as Error).message);
  }

  let encryptionPassphrase: string | undefined;
  try {
    encryptionPassphrase = await resolveSecret(
      config.encryption?.passphrase,
      env,
      'LIVESYNC_PASSPHRASE',
      configDir
    );
  } catch (err) {
    throw new ConfigValidationError((err as Error).message);
  }

  // Register plaintext secrets with redactor if provided
  if (redactor) {
    if (remotePassword) {
      redactor.registerSecret(remotePassword);
    }
    if (encryptionPassphrase) {
      redactor.registerSecret(encryptionPassphrase);
    }
  }

  // Path Safety Verification (CONF-03)
  const vaultPath = path.resolve(config.vault.path);
  const defaultStateBase = env.HOME ? path.resolve(env.HOME) : os.homedir();
  const defaultStateDir = path.resolve(
    path.join(defaultStateBase, '.local/share/obsidian-livesync-headless')
  );
  const statePath = config.state?.path ? path.resolve(config.state.path) : defaultStateDir;

  // Reject system root: "/" or filesystem root (e.g. "/" on POSIX, "C:\\" on Windows)
  const rootDir = path.parse(vaultPath).root;
  if (vaultPath === '/' || vaultPath === rootDir) {
    throw new ConfigValidationError('Vault path cannot be the root filesystem directory');
  }

  // Reject user home directory
  const homeDirs = new Set<string>();
  homeDirs.add(path.resolve(os.homedir()));
  if (env.HOME) {
    homeDirs.add(path.resolve(env.HOME));
  }
  if (homeDirs.has(vaultPath)) {
    throw new ConfigValidationError('Vault path cannot be the user home directory');
  }

  // Reject parent directory traversal escapes that reach root
  if (vaultPath === path.parse(vaultPath).root) {
    throw new ConfigValidationError('Vault path cannot be the root filesystem directory');
  }

  // Reject overlapping directories (identical, or one is ancestor/descendant of the other)
  if (vaultPath === statePath) {
    throw new ConfigValidationError('Vault directory and state directory must not overlap');
  }
  if (statePath.startsWith(vaultPath + path.sep)) {
    throw new ConfigValidationError('Vault directory and state directory must not overlap');
  }
  if (vaultPath.startsWith(statePath + path.sep)) {
    throw new ConfigValidationError('Vault directory and state directory must not overlap');
  }

  const resolvedSecrets: ResolvedSecrets = {
    remotePassword,
    encryptionPassphrase,
  };

  return {
    ...config,
    resolvedVaultPath: vaultPath,
    resolvedStatePath: statePath,
    resolvedSecrets,
  };
}
