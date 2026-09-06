import { loadConfig, ConfigValidationError } from '../../config/loader.js';
import { SecretRedactor, defaultRedactor } from '../../security/redaction.js';
import {
  createGuardedFetch,
  MutationAttemptBlockedError,
} from '../../security/transport-guard.js';
import {
  probeRemoteDatabase,
  AuthenticationRequiredError,
  DatabaseNotFoundError,
  type RemoteProbeResult,
} from '../../livesync/inspector.js';
import {
  ZeroMutationVerifier,
  MutationDetectedError,
  type DatabaseSnapshot,
} from '../../livesync/zero-mutation.js';
import { verifySyncinfo } from '../../livesync/syncinfo.js';
import {
  negotiateCompatibility,
  computeFingerprint,
} from '../../livesync/negotiation.js';
import { openDatabase } from '../../storage/sqlite.js';
import { AdmissionRepository } from '../../storage/admission-repo.js';
import {
  formatHumanReport,
  formatJsonLinesReport,
  type CompatibilityReport,
} from '../../diagnostics/formatters.js';
import { OutcomeCategory, EXIT_CODES } from '../../diagnostics/outcomes.js';

export interface InspectCommandOptions {
  configPath?: string;
  json?: boolean;
  redactor?: SecretRedactor;
  stdout?: (msg: string) => void;
}

export async function runInspectCommand(options: InspectCommandOptions): Promise<number> {
  const redactor = options.redactor ?? defaultRedactor;
  const writeStdout = options.stdout ?? ((msg: string) => process.stdout.write(msg));

  function emitReport(report: CompatibilityReport): void {
    const text = options.json ? formatJsonLinesReport(report) : formatHumanReport(report);
    writeStdout(text);
  }

  // 1. Load configuration
  let config;
  try {
    config = await loadConfig(options.configPath, process.env, redactor);
  } catch (err) {
    emitReport({
      outcome: OutcomeCategory.CONFIG_ERROR,
      remoteFingerprint: '',
      negotiatedSettingsHash: '',
      admittedCapabilities: [],
      unsupportedCapabilities: [
        'read_only_admission',
        'chunk_v2',
        'compatible_tweaks',
        'write_sync',
        'bidirectional_replication',
      ],
      adoptedTweaks: {},
      blockers: [
        {
          code: err instanceof ConfigValidationError ? 'CONFIG_VALIDATION_ERROR' : 'CONFIG_LOAD_ERROR',
          message: (err as Error).message,
        },
      ],
      zeroMutationVerified: false,
    });
    return EXIT_CODES.CONFIG_ERROR;
  }

  const rawUrl = new URL(config.remote.url);
  const allowedBaseUrl = new URL(`${rawUrl.protocol}//${rawUrl.host}`);
  const databaseName = config.remote.database;
  const credentials =
    config.remote.username || config.resolvedSecrets.remotePassword
      ? { username: config.remote.username, password: config.resolvedSecrets.remotePassword }
      : undefined;

  const guardedFetch = createGuardedFetch({
    allowedBaseUrl,
    databaseName,
  });

  const fingerprint = computeFingerprint(allowedBaseUrl.href, databaseName);

  // 2. Perform zero-mutation verification & CouchDB probe
  let preSnapshot: DatabaseSnapshot;
  let postSnapshot: DatabaseSnapshot;
  let probeResult: RemoteProbeResult;

  try {
    preSnapshot = await ZeroMutationVerifier.captureSnapshot(
      guardedFetch,
      allowedBaseUrl,
      databaseName,
      credentials
    );

    probeResult = await probeRemoteDatabase(
      guardedFetch,
      allowedBaseUrl,
      databaseName,
      credentials
    );

    postSnapshot = await ZeroMutationVerifier.captureSnapshot(
      guardedFetch,
      allowedBaseUrl,
      databaseName,
      credentials
    );

    ZeroMutationVerifier.assertNoMutation(preSnapshot, postSnapshot);
  } catch (err) {
    if (err instanceof AuthenticationRequiredError) {
      emitReport({
        outcome: OutcomeCategory.AUTHENTICATION_ERROR,
        remoteFingerprint: fingerprint,
        negotiatedSettingsHash: '',
        admittedCapabilities: [],
        unsupportedCapabilities: [
          'read_only_admission',
          'chunk_v2',
          'compatible_tweaks',
          'write_sync',
          'bidirectional_replication',
        ],
        adoptedTweaks: {},
        blockers: [
          {
            code: 'AUTHENTICATION_REQUIRED',
            message: err.message,
            suggestion: 'Verify remote.username and remote.password in your configuration',
          },
        ],
        zeroMutationVerified: true,
      });
      return EXIT_CODES.AUTHENTICATION_ERROR;
    }

    if (err instanceof DatabaseNotFoundError) {
      emitReport({
        outcome: OutcomeCategory.NOT_FOUND,
        remoteFingerprint: fingerprint,
        negotiatedSettingsHash: '',
        admittedCapabilities: [],
        unsupportedCapabilities: [
          'read_only_admission',
          'chunk_v2',
          'compatible_tweaks',
          'write_sync',
          'bidirectional_replication',
        ],
        adoptedTweaks: {},
        blockers: [
          {
            code: 'DATABASE_NOT_FOUND',
            message: err.message,
            suggestion: 'Verify remote.database exists in CouchDB',
          },
        ],
        zeroMutationVerified: true,
      });
      return EXIT_CODES.NOT_FOUND;
    }

    if (
      err instanceof MutationDetectedError ||
      err instanceof MutationAttemptBlockedError
    ) {
      emitReport({
        outcome: OutcomeCategory.MUTATION_VIOLATION,
        remoteFingerprint: fingerprint,
        negotiatedSettingsHash: '',
        admittedCapabilities: [],
        unsupportedCapabilities: [
          'read_only_admission',
          'chunk_v2',
          'compatible_tweaks',
          'write_sync',
          'bidirectional_replication',
        ],
        adoptedTweaks: {},
        blockers: [
          {
            code: 'MUTATION_VIOLATION',
            message: err.message,
            suggestion: 'First-contact admission strictly forbids modifying remote state',
          },
        ],
        zeroMutationVerified: false,
      });
      return EXIT_CODES.MUTATION_VIOLATION;
    }

    const errorMsg = (err as Error).message || String(err);
    const isNetworkOutage =
      errorMsg.includes('ECONNREFUSED') ||
      errorMsg.includes('ENOTFOUND') ||
      errorMsg.includes('fetch failed');

    if (isNetworkOutage) {
      emitReport({
        outcome: OutcomeCategory.TRANSIENT_OUTAGE,
        remoteFingerprint: fingerprint,
        negotiatedSettingsHash: '',
        admittedCapabilities: [],
        unsupportedCapabilities: [
          'read_only_admission',
          'chunk_v2',
          'compatible_tweaks',
          'write_sync',
          'bidirectional_replication',
        ],
        adoptedTweaks: {},
        blockers: [
          {
            code: 'NETWORK_OUTAGE',
            message: `Could not connect to CouchDB server at ${allowedBaseUrl.origin}: ${errorMsg}`,
            suggestion: 'Check CouchDB server status, network connectivity, and URL',
          },
        ],
        zeroMutationVerified: false,
      });
      return EXIT_CODES.TRANSIENT_OUTAGE;
    }

    // Otherwise treat as corruption or unhandled probe error
    emitReport({
      outcome: OutcomeCategory.CORRUPTION,
      remoteFingerprint: fingerprint,
      negotiatedSettingsHash: '',
      admittedCapabilities: [],
      unsupportedCapabilities: [
        'read_only_admission',
        'chunk_v2',
        'compatible_tweaks',
        'write_sync',
        'bidirectional_replication',
      ],
      adoptedTweaks: {},
      blockers: [
        {
          code: 'DATA_CORRUPTION',
          message: `Unexpected error during remote inspection: ${errorMsg}`,
        },
      ],
      zeroMutationVerified: false,
    });
    return EXIT_CODES.CORRUPTION;
  }

  // 3. Cryptographic syncinfo authentication
  const syncinfoResult = await verifySyncinfo(
    probeResult.syncinfoDoc,
    probeResult.syncParamsDoc,
    config.resolvedSecrets.encryptionPassphrase
  );

  // 4. LiveSync compatibility negotiation
  const negotiation = negotiateCompatibility(
    probeResult,
    config,
    syncinfoResult.verified
  );

  if (!negotiation.admitted) {
    const hasAuthBlocker = negotiation.blockers.some(
      (b) => b.code === 'AUTHENTICATION_ERROR'
    );
    const outcome = hasAuthBlocker
      ? OutcomeCategory.AUTHENTICATION_ERROR
      : OutcomeCategory.INCOMPATIBLE;
    const exitCode = hasAuthBlocker
      ? EXIT_CODES.AUTHENTICATION_ERROR
      : EXIT_CODES.INCOMPATIBLE;

    emitReport({
      outcome,
      remoteFingerprint: negotiation.remoteFingerprint,
      negotiatedSettingsHash: negotiation.negotiatedSettingsHash,
      admittedCapabilities: negotiation.admittedCapabilities,
      unsupportedCapabilities: negotiation.unsupportedCapabilities,
      adoptedTweaks: negotiation.adoptedTweaks,
      blockers: negotiation.blockers,
      zeroMutationVerified: true,
      preUpdateSeq: preSnapshot.updateSeq,
      postUpdateSeq: postSnapshot.updateSeq,
      databaseInfo: probeResult.databaseInfo,
    });
    return exitCode;
  }

  // 5. Durably persist admission record in SQLite
  try {
    const db = openDatabase(config.resolvedStatePath);
    const repo = new AdmissionRepository(db);
    repo.saveAdmission({
      remoteFingerprint: negotiation.remoteFingerprint,
      couchdbUrl: allowedBaseUrl.origin,
      databaseName: config.remote.database,
      couchdbVersion: probeResult.databaseInfo.couchdbVersion ?? 'unknown',
      versionInfoRev: probeResult.versionDoc!._rev,
      milestoneRev: probeResult.milestoneDoc!._rev,
      syncParamsRev: probeResult.syncParamsDoc?._rev ?? null,
      negotiatedSettingsHash: negotiation.negotiatedSettingsHash,
      negotiatedSettingsJson: JSON.stringify(negotiation.negotiatedSettings),
      updateSeq: preSnapshot.updateSeq,
      admittedAt: new Date().toISOString(),
    });
    db.close();
  } catch (err) {
    emitReport({
      outcome: OutcomeCategory.CORRUPTION,
      remoteFingerprint: negotiation.remoteFingerprint,
      negotiatedSettingsHash: negotiation.negotiatedSettingsHash,
      admittedCapabilities: [],
      unsupportedCapabilities: negotiation.unsupportedCapabilities,
      adoptedTweaks: negotiation.adoptedTweaks,
      blockers: [
        {
          code: 'ADMISSION_PERSISTENCE_FAILED',
          message: `Failed to persist admission in SQLite state: ${(err as Error).message}`,
        },
      ],
      zeroMutationVerified: true,
      preUpdateSeq: preSnapshot.updateSeq,
      postUpdateSeq: postSnapshot.updateSeq,
      databaseInfo: probeResult.databaseInfo,
    });
    return EXIT_CODES.CORRUPTION;
  }

  // 6. Output success report
  emitReport({
    outcome: OutcomeCategory.SUCCESS,
    remoteFingerprint: negotiation.remoteFingerprint,
    negotiatedSettingsHash: negotiation.negotiatedSettingsHash,
    admittedCapabilities: negotiation.admittedCapabilities,
    unsupportedCapabilities: negotiation.unsupportedCapabilities,
    adoptedTweaks: negotiation.adoptedTweaks,
    blockers: [],
    zeroMutationVerified: true,
    preUpdateSeq: preSnapshot.updateSeq,
    postUpdateSeq: postSnapshot.updateSeq,
    databaseInfo: probeResult.databaseInfo,
  });

  return EXIT_CODES.SUCCESS;
}
