import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, ConfigValidationError } from '../../config/loader.js';
import { SecretRedactor, defaultRedactor } from '../../security/redaction.js';
import {
  createGuardedFetch,
  MutationAttemptBlockedError,
} from '../../security/transport-guard.js';
import { createReadCapability } from '../../security/capabilities.js';
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
  type NegotiationResult,
} from '../../livesync/negotiation.js';
import { inventoryRemoteDocuments } from '../../livesync/inventory.js';
import {
  decodeNoteLeaf,
  isNoteType,
  isReservedChunkId,
} from '../../livesync/decode-adapter.js';
import {
  buildPullPlan,
  serializePullActions,
  type PullAction,
  type PullObservation,
} from '../../domain/pull-plan.js';
import { installAtomically } from '../../filesystem/atomic-reflector.js';
import { openDatabase } from '../../storage/sqlite.js';
import { ProvenanceRepository } from '../../storage/provenance-repo.js';
import {
  formatPullHumanReport,
  formatPullJsonLinesReport,
  type PullReport,
} from '../../diagnostics/formatters.js';
import { OutcomeCategory, EXIT_CODES } from '../../diagnostics/outcomes.js';

export interface PullCommandOptions {
  configPath: string;
  dryRun: boolean;
  json?: boolean;
  redactor?: SecretRedactor;
  stdout?: (msg: string) => void;
}

export async function applyVerifiedPull(options: {
  vaultRoot: string;
  actions: readonly PullAction[];
  remoteFingerprint: string;
  statePath: string;
}): Promise<void> {
  const db = openDatabase(options.statePath);
  try {
    const repo = new ProvenanceRepository(db);
    for (const action of options.actions) {
      if (action.kind !== 'create') {
        continue;
      }

      await installAtomically(options.vaultRoot, action.path, action.bytes);
      const dest = join(options.vaultRoot, action.path);
      const fileStat = await stat(dest);
      repo.saveProvenance({
        path: action.path,
        remoteRevision: action.sourceRevision,
        contentSha256: createHash('sha256').update(action.bytes).digest('hex'),
        observedMtime: fileStat.mtimeMs,
        remoteFingerprint: options.remoteFingerprint,
        reflectedAt: new Date().toISOString(),
      });
    }
  } finally {
    db.close();
  }
}

function exitForBlockActions(actions: readonly PullAction[]): number {
  const hasConflict = actions.some(
    (action) =>
      action.kind === 'block' &&
      (action.code === 'CONFLICT' ||
        action.code === 'UNRESOLVED_LEAVES' ||
        action.code.startsWith('CONFLICT'))
  );
  return hasConflict ? EXIT_CODES.CONFLICT : EXIT_CODES.CORRUPTION;
}

function outcomeForExit(exitCode: number): OutcomeCategory {
  const match = (Object.entries(EXIT_CODES) as [OutcomeCategory, number][]).find(
    ([, code]) => code === exitCode
  );
  return match?.[0] ?? OutcomeCategory.CORRUPTION;
}

async function vaultIsEmpty(vaultRoot: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    const entries = await readdir(vaultRoot);
    if (entries.length > 0) {
      return {
        ok: false,
        code: 'VAULT_NOT_EMPTY',
        message: `Vault '${vaultRoot}' is not empty; apply requires an empty or dedicated vault`,
      };
    }
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        code: 'VAULT_NOT_EMPTY',
        message: `Vault '${vaultRoot}' does not exist`,
      };
    }
    return {
      ok: false,
      code: 'VAULT_NOT_EMPTY',
      message: `Failed to inspect vault '${vaultRoot}': ${(err as Error).message}`,
    };
  }
}

async function observationsFromInventory(
  inventory: Awaited<ReturnType<typeof inventoryRemoteDocuments>>,
  handleFilenameCaseSensitive: boolean
): Promise<PullObservation[]> {
  const observations: PullObservation[] = [];

  for (const item of inventory) {
    if (item.kind === 'chunk' || isReservedChunkId(item.id)) {
      observations.push({ kind: 'special', id: item.id, type: 'leaf' });
      continue;
    }

    if (item.kind === 'tombstone') {
      observations.push({
        kind: 'note',
        path: item.id,
        sourceRevision: item.rev,
        type: 'unknown',
        deleted: true,
        bytes: new Uint8Array(),
      });
      continue;
    }

    const doc = item.document;
    const type = typeof doc.type === 'string' ? doc.type : 'unknown';

    if (doc._deleted === true || doc.deleted === true) {
      observations.push({
        kind: 'note',
        path: typeof doc.path === 'string' ? doc.path : doc._id,
        sourceRevision: doc._rev,
        type,
        deleted: true,
        bytes: new Uint8Array(),
      });
      continue;
    }

    if (!isNoteType(type)) {
      observations.push({ kind: 'special', id: doc._id, type });
      continue;
    }

    const decoded = await decodeNoteLeaf(doc, { handleFilenameCaseSensitive });
    if (!decoded.ok) {
      if (decoded.code === 'IGNORED') {
        observations.push({ kind: 'ignored', path: decoded.path ?? doc._id });
        continue;
      }
      observations.push({
        kind: 'block',
        id: decoded.id,
        path: decoded.path,
        code: decoded.code,
        message: decoded.message,
      });
      continue;
    }

    observations.push({
      kind: 'note',
      path: decoded.path,
      sourceRevision: decoded.sourceRevision,
      type: decoded.type,
      deleted: decoded.deleted,
      bytes: decoded.bytes,
    });
  }

  return observations;
}

export async function runPullCommand(options: PullCommandOptions): Promise<number> {
  const redactor = options.redactor ?? defaultRedactor;
  const writeStdout = options.stdout ?? ((msg: string) => process.stdout.write(msg));

  function emitReport(report: PullReport): void {
    const text = options.json ? formatPullJsonLinesReport(report) : formatPullHumanReport(report);
    writeStdout(text);
  }

  let config;
  try {
    config = await loadConfig(options.configPath, process.env, redactor);
  } catch (err) {
    emitReport({
      type: 'pull_report',
      outcome: OutcomeCategory.CONFIG_ERROR,
      dryRun: options.dryRun,
      remoteFingerprint: '',
      negotiatedSettingsHash: '',
      adoptedTweaks: {},
      actions: [],
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
  const readCapability = createReadCapability(allowedBaseUrl, databaseName);
  void readCapability;

  const fingerprint = computeFingerprint(allowedBaseUrl.href, databaseName);

  let preSnapshot: DatabaseSnapshot | undefined;
  let postSnapshot: DatabaseSnapshot | undefined;
  let probeResult: RemoteProbeResult | undefined;
  let actions: PullAction[] = [];
  let adoptedTweaks: Record<string, unknown> = {};
  let negotiatedSettingsHash = '';
  let remoteFingerprint = fingerprint;
  let negotiation: NegotiationResult | undefined;

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
    adoptedTweaks = negotiation.adoptedTweaks;
    negotiatedSettingsHash = negotiation.negotiatedSettingsHash;
    remoteFingerprint = negotiation.remoteFingerprint;

    if (negotiation.admitted) {
      const inventory = await inventoryRemoteDocuments(
        guardedFetch,
        allowedBaseUrl,
        databaseName,
        credentials
      );
      const handleFilenameCaseSensitive = Boolean(
        negotiation.negotiatedSettings.handleFilenameCaseSensitive
      );
      const observations = await observationsFromInventory(
        inventory,
        handleFilenameCaseSensitive
      );
      actions = buildPullPlan(observations);

      const blockActions = actions.filter((action) => action.kind === 'block');
      if (!options.dryRun && blockActions.length === 0) {
        const vaultCheck = await vaultIsEmpty(config.resolvedVaultPath);
        if (!vaultCheck.ok) {
          postSnapshot = await ZeroMutationVerifier.captureSnapshot(
            guardedFetch,
            allowedBaseUrl,
            databaseName,
            credentials
          );
          ZeroMutationVerifier.assertNoMutation(preSnapshot, postSnapshot);
          emitReport({
            type: 'pull_report',
            outcome: OutcomeCategory.CONFIG_ERROR,
            dryRun: options.dryRun,
            remoteFingerprint,
            negotiatedSettingsHash,
            adoptedTweaks,
            actions: serializePullActions(actions),
            blockers: [{ code: vaultCheck.code, message: vaultCheck.message }],
            zeroMutationVerified: true,
            preUpdateSeq: preSnapshot.updateSeq,
            postUpdateSeq: postSnapshot.updateSeq,
          });
          return EXIT_CODES.CONFIG_ERROR;
        }

        await applyVerifiedPull({
          vaultRoot: config.resolvedVaultPath,
          actions,
          remoteFingerprint,
          statePath: config.resolvedStatePath,
        });
      }
    }

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
        type: 'pull_report',
        outcome: OutcomeCategory.AUTHENTICATION_ERROR,
        dryRun: options.dryRun,
        remoteFingerprint,
        negotiatedSettingsHash,
        adoptedTweaks,
        actions: serializePullActions(actions),
        blockers: [
          {
            code: 'AUTHENTICATION_REQUIRED',
            message: err.message,
            suggestion: 'Verify remote.username and remote.password in your configuration',
          },
        ],
        zeroMutationVerified: true,
        preUpdateSeq: preSnapshot?.updateSeq,
        postUpdateSeq: postSnapshot?.updateSeq,
      });
      return EXIT_CODES.AUTHENTICATION_ERROR;
    }

    if (err instanceof DatabaseNotFoundError) {
      emitReport({
        type: 'pull_report',
        outcome: OutcomeCategory.NOT_FOUND,
        dryRun: options.dryRun,
        remoteFingerprint,
        negotiatedSettingsHash,
        adoptedTweaks,
        actions: serializePullActions(actions),
        blockers: [
          {
            code: 'DATABASE_NOT_FOUND',
            message: err.message,
            suggestion: 'Verify remote.database exists in CouchDB',
          },
        ],
        zeroMutationVerified: true,
        preUpdateSeq: preSnapshot?.updateSeq,
        postUpdateSeq: postSnapshot?.updateSeq,
      });
      return EXIT_CODES.NOT_FOUND;
    }

    if (err instanceof MutationDetectedError || err instanceof MutationAttemptBlockedError) {
      emitReport({
        type: 'pull_report',
        outcome: OutcomeCategory.MUTATION_VIOLATION,
        dryRun: options.dryRun,
        remoteFingerprint,
        negotiatedSettingsHash,
        adoptedTweaks,
        actions: serializePullActions(actions),
        blockers: [
          {
            code: 'MUTATION_VIOLATION',
            message: err.message,
            suggestion: 'Pull strictly forbids modifying remote state',
          },
        ],
        zeroMutationVerified: false,
        preUpdateSeq: preSnapshot?.updateSeq,
        postUpdateSeq: postSnapshot?.updateSeq,
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
        type: 'pull_report',
        outcome: OutcomeCategory.TRANSIENT_OUTAGE,
        dryRun: options.dryRun,
        remoteFingerprint,
        negotiatedSettingsHash,
        adoptedTweaks,
        actions: serializePullActions(actions),
        blockers: [
          {
            code: 'NETWORK_OUTAGE',
            message: `Could not connect to CouchDB server at ${allowedBaseUrl.origin}: ${errorMsg}`,
            suggestion: 'Check CouchDB server status, network connectivity, and URL',
          },
        ],
        zeroMutationVerified: false,
        preUpdateSeq: preSnapshot?.updateSeq,
        postUpdateSeq: postSnapshot?.updateSeq,
      });
      return EXIT_CODES.TRANSIENT_OUTAGE;
    }

    emitReport({
      type: 'pull_report',
      outcome: OutcomeCategory.CORRUPTION,
      dryRun: options.dryRun,
      remoteFingerprint,
      negotiatedSettingsHash,
      adoptedTweaks,
      actions: serializePullActions(actions),
      blockers: [
        {
          code: 'DATA_CORRUPTION',
          message: `Unexpected error during pull: ${errorMsg}`,
        },
      ],
      zeroMutationVerified: false,
      preUpdateSeq: preSnapshot?.updateSeq,
      postUpdateSeq: postSnapshot?.updateSeq,
    });
    return EXIT_CODES.CORRUPTION;
  }

  if (negotiation && !negotiation.admitted) {
    const hasAuthBlocker = negotiation.blockers.some((b) => b.code === 'AUTHENTICATION_ERROR');
    emitReport({
      type: 'pull_report',
      outcome: hasAuthBlocker ? OutcomeCategory.AUTHENTICATION_ERROR : OutcomeCategory.INCOMPATIBLE,
      dryRun: options.dryRun,
      remoteFingerprint,
      negotiatedSettingsHash,
      adoptedTweaks,
      actions: [],
      blockers: negotiation.blockers,
      zeroMutationVerified: true,
      preUpdateSeq: preSnapshot?.updateSeq,
      postUpdateSeq: postSnapshot?.updateSeq,
    });
    return hasAuthBlocker ? EXIT_CODES.AUTHENTICATION_ERROR : EXIT_CODES.INCOMPATIBLE;
  }

  const blockActions = actions.filter((action) => action.kind === 'block');
  if (blockActions.length > 0) {
    const exitCode = exitForBlockActions(actions);
    emitReport({
      type: 'pull_report',
      outcome: outcomeForExit(exitCode),
      dryRun: options.dryRun,
      remoteFingerprint,
      negotiatedSettingsHash,
      adoptedTweaks,
      actions: serializePullActions(actions),
      blockers: blockActions.map((action) => ({
        code: action.code,
        message: action.message,
      })),
      zeroMutationVerified: true,
      preUpdateSeq: preSnapshot?.updateSeq,
      postUpdateSeq: postSnapshot?.updateSeq,
    });
    return exitCode;
  }

  emitReport({
    type: 'pull_report',
    outcome: OutcomeCategory.SUCCESS,
    dryRun: options.dryRun,
    remoteFingerprint,
    negotiatedSettingsHash,
    adoptedTweaks,
    actions: serializePullActions(actions),
    blockers: [],
    zeroMutationVerified: true,
    preUpdateSeq: preSnapshot?.updateSeq,
    postUpdateSeq: postSnapshot?.updateSeq,
  });
  return EXIT_CODES.SUCCESS;
}
