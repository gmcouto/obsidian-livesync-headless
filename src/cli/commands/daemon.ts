import { loadConfig } from '../../config/loader.js';
import { SecretRedactor, defaultRedactor } from '../../security/redaction.js';
import { createWriteCapability, type WriteCapability } from '../../security/capabilities.js';
import { computeFingerprint, negotiateCompatibility } from '../../livesync/negotiation.js';
import { probeRemoteDatabase, type RemoteProbeResult } from '../../livesync/inspector.js';
import { verifySyncinfo } from '../../livesync/syncinfo.js';
import { createGuardedFetch } from '../../security/transport-guard.js';
import { openDatabase } from '../../storage/sqlite.js';
import { AdmissionRepository, type AdmissionRecord } from '../../storage/admission-repo.js';
import { WriteGrantRepo } from '../../storage/write-grant-repo.js';
import { ContinuousEngine } from '../../daemon/continuous-engine.js';
import { ShutdownHandler } from '../../daemon/shutdown-handler.js';
import { OutcomeCategory, EXIT_CODES } from '../../diagnostics/outcomes.js';

export interface DaemonCommandOptions {
  configPath?: string;
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

  const guardedFetch = createGuardedFetch(
    { allowedBaseUrl, databaseName },
    options.fetch ?? globalThis.fetch
  );

  let probeResult: RemoteProbeResult | undefined;
  let negotiation: ReturnType<typeof negotiateCompatibility> | undefined;

  try {
    probeResult = await probeRemoteDatabase(
      guardedFetch,
      allowedBaseUrl,
      databaseName,
      credentials
    );

    const syncinfoResult = await verifySyncinfo(
      probeResult.syncinfoDoc,
      probeResult.syncParamsDoc,
      config.resolvedSecrets.encryptionPassphrase
    );

    negotiation = negotiateCompatibility(
      probeResult,
      config,
      syncinfoResult.verified
    );

    if (!negotiation.admitted) {
      writeStdout(
        JSON.stringify({
          type: 'daemon_report',
          outcome: OutcomeCategory.INCOMPATIBLE,
          message: 'Remote database failed admission negotiation.',
          blockers: negotiation.blockers,
        }) + '\n'
      );
      return EXIT_CODES.INCOMPATIBLE;
    }

    const db = openDatabase(statePath);
    try {
      const admissionRepo = new AdmissionRepository(db);
      admissionRepo.saveAdmission({
        remoteFingerprint: negotiation.remoteFingerprint,
        couchdbUrl: allowedBaseUrl.href,
        databaseName,
        couchdbVersion: probeResult.databaseInfo.couchdbVersion ?? '3.5.2',
        versionInfoRev: probeResult.versionDoc?._rev ?? '1',
        milestoneRev: probeResult.milestoneDoc?._rev ?? '1',
        syncParamsRev: probeResult.syncParamsDoc?._rev ?? null,
        negotiatedSettingsHash: negotiation.negotiatedSettingsHash,
        negotiatedSettingsJson: JSON.stringify(negotiation.negotiatedSettings),
        updateSeq: probeResult.databaseInfo.updateSeq,
        admittedAt: new Date().toISOString(),
      });
    } finally {
      db.close();
    }
  } catch (err) {
    // If probing fails on startup (e.g. offline / network hiccup), fall back to stored admission
    const db = openDatabase(statePath);
    try {
      const admissionRepo = new AdmissionRepository(db);
      const existing = admissionRepo.getAdmissionByFingerprint(fingerprint);
      if (!existing) {
        writeStderr(`Failed to probe remote database and no prior admission found: ${(err as Error).message}\n`);
        return EXIT_CODES.CONFIG_ERROR;
      }
    } finally {
      db.close();
    }
  }

  const db = openDatabase(statePath);
  let admissionRec: AdmissionRecord | null = null;
  try {
    const admissionRepo = new AdmissionRepository(db);
    admissionRec = admissionRepo.getAdmissionByFingerprint(fingerprint) ?? admissionRepo.getLatest();
  } finally {
    db.close();
  }

  let negotiatedSettings: Record<string, unknown> = {};
  if (admissionRec?.negotiatedSettingsJson) {
    try {
      negotiatedSettings = JSON.parse(admissionRec.negotiatedSettingsJson);
    } catch {}
  }

  const preferredTweaks = probeResult?.milestoneDoc?.tweak_values?.PREFERRED ?? {};
  const encrypt = Boolean(
    config.encryption?.enabled ??
    negotiatedSettings.encrypt ??
    preferredTweaks.encrypt
  );
  const algorithm =
    typeof negotiatedSettings.E2EEAlgorithm === 'string'
      ? (negotiatedSettings.E2EEAlgorithm as string)
      : typeof preferredTweaks.E2EEAlgorithm === 'string'
        ? (preferredTweaks.E2EEAlgorithm as string)
        : encrypt
          ? 'v2'
          : undefined;

  const pbkdf2salt =
    typeof probeResult?.syncParamsDoc?.pbkdf2salt === 'string'
      ? probeResult.syncParamsDoc.pbkdf2salt
      : typeof negotiatedSettings.pbkdf2salt === 'string'
        ? (negotiatedSettings.pbkdf2salt as string)
        : undefined;

  const useDynamicIterationCount = Boolean(
    negotiatedSettings.useDynamicIterationCount ?? preferredTweaks.useDynamicIterationCount
  );

  const usePathObfuscation = Boolean(
    negotiatedSettings.usePathObfuscation ?? preferredTweaks.usePathObfuscation
  );

  const handleFilenameCaseSensitive = Boolean(
    negotiatedSettings.handleFilenameCaseSensitive ?? preferredTweaks.handleFilenameCaseSensitive
  );

  const customChunkSize =
    typeof negotiatedSettings.customChunkSize === 'number'
      ? (negotiatedSettings.customChunkSize as number)
      : undefined;

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
    algorithm,
    useDynamicIterationCount,
    usePathObfuscation,
    pbkdf2salt,
    handleFilenameCaseSensitive,
    customChunkSize,
    minimumChunkSize: 20,
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
    return EXIT_CODES.CONFLICT;
  }
}
