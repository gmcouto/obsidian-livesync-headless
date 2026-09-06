import { loadConfig } from '../../config/loader.js';
import { SecretRedactor, defaultRedactor } from '../../security/redaction.js';
import { createWriteCapability, type WriteCapability } from '../../security/capabilities.js';
import { computeFingerprint } from '../../livesync/negotiation.js';
import { openDatabase } from '../../storage/sqlite.js';
import { AdmissionRepository } from '../../storage/admission-repo.js';
import { WriteGrantRepo } from '../../storage/write-grant-repo.js';
import { ContinuousEngine } from '../../daemon/continuous-engine.js';
import { ShutdownHandler } from '../../daemon/shutdown-handler.js';
import { OutcomeCategory, EXIT_CODES } from '../../diagnostics/outcomes.js';

export interface DaemonCommandOptions {
  configPath: string;
  write?: boolean;
  periodicScanSec?: number;
  concurrency?: number;
  debounceMs?: number;
  json?: boolean;
  redactor?: SecretRedactor;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  registerSignalHandlers?: boolean;
  drainTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  onEngineReady?: (engine: ContinuousEngine, shutdownHandler: ShutdownHandler) => void;
}

export function emitDaemonBanner(stdout: (msg: string) => void, writeMode: boolean): void {
  stdout(
    `\n================================================================================\n` +
      `🔄  Obsidian LiveSync Continuous Convergence Daemon\n` +
      `   Mode: ${writeMode ? 'Bidirectional (Write Armed)' : 'Read-Only (Pull Monitoring)'}\n` +
      `   Press Ctrl+C (SIGINT) to initiate graceful shutdown.\n` +
      `================================================================================\n\n`
  );
}

export async function runDaemonCommand(options: DaemonCommandOptions): Promise<number> {
  const redactor = options.redactor ?? defaultRedactor;
  const writeStdout = options.stdout ?? ((msg: string) => process.stdout.write(msg));
  const writeStderr = options.stderr ?? ((msg: string) => process.stderr.write(msg));

  emitDaemonBanner(writeStdout, Boolean(options.write));

  let config;
  try {
    config = await loadConfig(options.configPath, process.env, redactor);
  } catch (err) {
    writeStdout(
      JSON.stringify({
        type: 'daemon_report',
        outcome: OutcomeCategory.CONFIG_ERROR,
        message: (err as Error).message,
      }) + '\n'
    );
    return EXIT_CODES.CONFIG_ERROR;
  }

  const rawUrl = new URL(config.remote.url);
  const allowedBaseUrl = new URL(`${rawUrl.protocol}//${rawUrl.host}`);
  const databaseName = config.remote.database;
  const vaultRoot = config.resolvedVaultPath;
  const statePath = config.resolvedStatePath;
  const credentials =
    config.remote.username || config.resolvedSecrets.remotePassword
      ? { username: config.remote.username, password: config.resolvedSecrets.remotePassword }
      : undefined;

  const fingerprint = computeFingerprint(allowedBaseUrl.href, databaseName);

  // Check write grant if write mode is requested (DAEM-01)
  let capability: WriteCapability | null = null;
  if (options.write) {
    const db = openDatabase(statePath);
    try {
      const grantRepo = new WriteGrantRepo(db);
      const activeGrant = grantRepo.getActiveGrant(fingerprint, vaultRoot);

      if (!activeGrant) {
        writeStderr(
          `ERROR: No active write grant found for vault '${vaultRoot}' and remote '${fingerprint}'.\n` +
            `Run 'obsidian-livesync-headless arm -c <config>' first to arm write access (DAEM-01).\n`
        );
        return EXIT_CODES.CONFIG_ERROR;
      }

      capability = createWriteCapability(
        allowedBaseUrl,
        databaseName,
        activeGrant.grantId,
        activeGrant.remoteFingerprint,
        activeGrant.vaultRoot
      );
    } finally {
      db.close();
    }
  }

  const engine = new ContinuousEngine({
    vaultRoot,
    statePath,
    baseUrl: allowedBaseUrl,
    databaseName,
    credentials,
    encryptionPassphrase: config.resolvedSecrets.encryptionPassphrase,
    algorithm: config.encryption?.algorithm,
    useDynamicIterationCount: config.encryption?.useDynamicIterationCount,
    usePathObfuscation: config.encryption?.usePathObfuscation,
    pbkdf2salt: config.encryption?.pbkdf2salt,
    handleFilenameCaseSensitive: config.vault.caseSensitive,
    customChunkSize: config.chunking?.chunkSize,
    minimumChunkSize: config.chunking?.minimumChunkSize,
    periodicScanIntervalMs: (options.periodicScanSec ?? 300) * 1000,
    debounceMs: options.debounceMs ?? 300,
    workerConcurrency: options.concurrency ?? 4,
    capability: capability ?? undefined,
    readOnly: !options.write,
    fetch: options.fetch,
  });

  let shutdownExitCode = EXIT_CODES.SUCCESS;
  let resolveExit: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const shutdownHandler = new ShutdownHandler({
    engine,
    drainTimeoutMs: options.drainTimeoutMs ?? 10000,
    logger: (msg) => writeStderr(`${msg}\n`),
    onShutdownComplete: (code) => {
      shutdownExitCode = code;
      resolveExit?.(code);
    },
  });

  if (options.registerSignalHandlers !== false) {
    shutdownHandler.registerSignalHandlers();
  }

  engine.on('reconciled', (res) => {
    if (res.action !== 'noop' && res.action !== 'skipped') {
      writeStdout(`[reconciled] ${res.action} -> ${res.path} (${res.success ? 'ok' : res.error})\n`);
    }
  });

  engine.on('warning', (msg) => {
    writeStderr(`[warning] ${msg}\n`);
  });

  engine.on('conflicts', (conflicts: string[]) => {
    for (const c of conflicts) {
      writeStderr(`[conflict] ${c}\n`);
    }
  });

  engine.stateMachine.on('transition', (e) => {
    if (e.newState === 'STOPPED') {
      resolveExit?.(shutdownExitCode);
    }
  });

  try {
    await engine.start();
    writeStdout(`Daemon initialized and running (${engine.stateMachine.getState()}).\n`);

    options.onEngineReady?.(engine, shutdownHandler);

    if (options.registerSignalHandlers === false && !options.onEngineReady) {
      // If signal handlers disabled and no custom handler, stop immediately for tests
      await engine.stop();
      return EXIT_CODES.SUCCESS;
    }

    return await exitPromise;
  } catch (err: unknown) {
    writeStderr(`Daemon fatal error: ${(err as Error).message}\n`);
    await engine.stop().catch(() => {});
    return EXIT_CODES.SYNC_CONFLICT;
  }
}
