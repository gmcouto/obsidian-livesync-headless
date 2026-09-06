import { loadConfig, ConfigValidationError } from '../../config/loader.js';
import { SecretRedactor, defaultRedactor } from '../../security/redaction.js';
import { createGuardedFetch } from '../../security/transport-guard.js';
import { probeRemoteDatabase } from '../../livesync/inspector.js';
import { verifySyncinfo } from '../../livesync/syncinfo.js';
import { negotiateCompatibility, computeFingerprint } from '../../livesync/negotiation.js';
import { openDatabase } from '../../storage/sqlite.js';
import { WriteGrantRepo } from '../../storage/write-grant-repo.js';
import { AdmissionRepository } from '../../storage/admission-repo.js';
import { OutcomeCategory, EXIT_CODES } from '../../diagnostics/outcomes.js';

export interface ArmCommandOptions {
  configPath?: string;
  json?: boolean;
  redactor?: SecretRedactor;
  stdout?: (msg: string) => void;
  revoke?: boolean;
}

export async function runArmCommand(options: ArmCommandOptions): Promise<number> {
  const redactor = options.redactor ?? defaultRedactor;
  const writeStdout = options.stdout ?? ((msg: string) => process.stdout.write(msg));

  let config;
  try {
    config = await loadConfig(options.configPath, process.env, redactor);
  } catch (err) {
    writeStdout(
      JSON.stringify({
        type: 'arm_report',
        outcome: OutcomeCategory.CONFIG_ERROR,
        message: (err as Error).message,
      }) + '\n'
    );
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
  const db = openDatabase(config.resolvedStatePath);

  try {
    const grantRepo = new WriteGrantRepo(db);

    if (options.revoke) {
      grantRepo.revokeActiveGrantsForVault(config.resolvedVaultPath, 'Explicitly revoked by user');
      writeStdout(
        options.json
          ? JSON.stringify({ type: 'arm_report', outcome: 'REVOKED', vaultRoot: config.resolvedVaultPath }) + '\n'
          : `Revoked active write grants for vault: ${config.resolvedVaultPath}\n`
      );
      return EXIT_CODES.SUCCESS;
    }

    const probeResult = await probeRemoteDatabase(
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

    const negotiation = negotiateCompatibility(
      probeResult,
      config,
      syncinfoResult.verified
    );

    if (!negotiation.admitted) {
      writeStdout(
        JSON.stringify({
          type: 'arm_report',
          outcome: OutcomeCategory.INCOMPATIBLE,
          message: 'Cannot arm write grant: remote database failed admission negotiation.',
          blockers: negotiation.blockers,
        }) + '\n'
      );
      return EXIT_CODES.INCOMPATIBLE;
    }

    const binding = {
      remoteFingerprint: negotiation.remoteFingerprint,
      vaultRoot: config.resolvedVaultPath,
      settingsHash: negotiation.negotiatedSettingsHash,
      commonlibVersion: '0.1.21',
      bootstrapGeneration: probeResult.versionDoc?._rev || '1',
    };

    const admissionRepo = new AdmissionRepository(db);
    admissionRepo.saveAdmission({
      remoteFingerprint: negotiation.remoteFingerprint,
      couchdbUrl: allowedBaseUrl.href,
      databaseName,
      couchdbVersion: probeResult.databaseInfo.couchdbVersion ?? '3.5.2',
      versionInfoRev: probeResult.versionDoc?._rev || '1',
      milestoneRev: probeResult.milestoneDoc?._rev || '1',
      syncParamsRev: probeResult.syncParamsDoc?._rev ?? null,
      negotiatedSettingsHash: negotiation.negotiatedSettingsHash,
      negotiatedSettingsJson: JSON.stringify(negotiation.negotiatedSettings),
      updateSeq: '0',
      admittedAt: new Date().toISOString(),
    });

    const grant = grantRepo.issueGrant(binding);

    const report = {
      type: 'arm_report',
      outcome: OutcomeCategory.SUCCESS,
      grantId: grant.grantId,
      remoteFingerprint: grant.remoteFingerprint,
      vaultRoot: grant.vaultRoot,
      settingsHash: grant.settingsHash,
      commonlibVersion: grant.commonlibVersion,
      bootstrapGeneration: grant.bootstrapGeneration,
      issuedAt: grant.issuedAt,
    };

    if (options.json) {
      writeStdout(JSON.stringify(report) + '\n');
    } else {
      writeStdout(
        `\n✓ Write grant successfully issued and stored in SQLite.\n` +
          `  Grant ID:             ${grant.grantId}\n` +
          `  Remote Fingerprint:   ${grant.remoteFingerprint}\n` +
          `  Vault Root:           ${grant.vaultRoot}\n` +
          `  Settings Hash:        ${grant.settingsHash}\n` +
          `  Commonlib Version:    ${grant.commonlibVersion}\n` +
          `  Bootstrap Generation: ${grant.bootstrapGeneration}\n` +
          `  Issued At:            ${grant.issuedAt}\n\n`
      );
    }

    return EXIT_CODES.SUCCESS;
  } catch (err) {
    writeStdout(
      JSON.stringify({
        type: 'arm_report',
        outcome: OutcomeCategory.CORRUPTION,
        message: (err as Error).message,
      }) + '\n'
    );
    return EXIT_CODES.CORRUPTION;
  } finally {
    db.close();
  }
}
