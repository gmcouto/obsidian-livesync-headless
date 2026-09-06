import { createHash } from 'node:crypto';
import type { RemoteProbeResult } from './inspector.js';
import type { LiveSyncConfig } from '../config/schema.js';

export const IncompatibleChanges = [
  'encrypt',
  'usePathObfuscation',
  'useDynamicIterationCount',
  'handleFilenameCaseSensitive',
] as const;

export const CompatibleButLossyChanges = [
  'hashAlg',
  'customChunkSize',
  'chunkSplitterVersion',
] as const;

export const SupportedOptionalTweaks = [
  'useIgnoreFiles',
  'useCustomRequestHandler',
  'batch_size',
  'batches_limit',
  'useTimeouts',
  'readChunksOnline',
  'hashCacheMaxCount',
  'hashCacheMaxAmount',
  'concurrencyOfReadChunksOnline',
  'minimumIntervalOfReadChunksOnline',
  'ignoreFiles',
  'syncMaxSizeInMB',
  'enableChunkSplitterV2',
  'usePluginSyncV2',
  'doNotUseFixedRevisionForChunks',
  'E2EEAlgorithm',
  'minimumChunkSize',
  'longLineThreshold',
  'enableCompression',
  'useEden',
  'maxChunksInEden',
  'maxTotalLengthInEden',
  'maxAgeInEden',
  'useSegmenter',
  'tweakModified',
] as const;

export const RECOGNIZED_TWEAK_KEYS = new Set<string>([
  ...IncompatibleChanges,
  ...CompatibleButLossyChanges,
  ...SupportedOptionalTweaks,
]);

export interface Blocker {
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
}

export interface NegotiationResult {
  readonly admitted: boolean;
  readonly remoteFingerprint: string;
  readonly negotiatedSettingsHash: string;
  readonly negotiatedSettings: Record<string, unknown>;
  readonly adoptedTweaks: Record<string, unknown>;
  readonly blockers: readonly Blocker[];
  readonly admittedCapabilities: readonly string[];
  readonly unsupportedCapabilities: readonly string[];
}

export function computeFingerprint(couchdbUrl: string, databaseName: string): string {
  const normalized = `${couchdbUrl.replace(/\/+$/, '')}/${databaseName}`;
  return createHash('sha256').update(normalized).digest('hex');
}

export function computeSettingsHash(settings: Record<string, unknown>): string {
  const sortedKeys = Object.keys(settings).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    canonical[k] = settings[k];
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function negotiateCompatibility(
  probeResult: RemoteProbeResult,
  localConfig: LiveSyncConfig,
  passphraseVerified = true
): NegotiationResult {
  const blockers: Blocker[] = [];
  const adoptedTweaks: Record<string, unknown> = {};
  const negotiatedSettings: Record<string, unknown> = {
    databaseName: localConfig.remote.database,
    version: probeResult.versionDoc?.version ?? 0,
  };

  // 1. Version Gate (CONF-05)
  if (!probeResult.versionDoc) {
    blockers.push({
      code: 'VERSION_DOC_MISSING',
      message: 'Database missing obsydian_livesync_version marker',
      suggestion: 'Verify the database was created and initialized by an Obsidian Self-hosted LiveSync client',
    });
  } else if (probeResult.versionDoc.version > 12) {
    blockers.push({
      code: 'UNSUPPORTED_REMOTE_VERSION',
      message: `Remote database version ${probeResult.versionDoc.version} exceeds supported version 12`,
      suggestion: 'Upgrade obsidian-livesync-headless to a release supporting this LiveSync protocol version',
    });
  }

  // 2. Milestone Gate (CONF-05)
  if (!probeResult.milestoneDoc) {
    blockers.push({
      code: 'MILESTONE_MISSING',
      message: 'Database missing _local/obsydian_livesync_milestone marker',
      suggestion: 'Ensure an Obsidian LiveSync client has performed initial synchronization on this database',
    });
  } else if (probeResult.milestoneDoc.locked) {
    blockers.push({
      code: 'DATABASE_LOCKED',
      message: 'Remote database is locked by another client or administrator',
      suggestion: 'Unlock the database in Obsidian LiveSync settings before proceeding with admission',
    });
  }

  // 3. Tweak Classification and Unknown Key Gate (CONF-05)
  const preferredTweaks = probeResult.milestoneDoc?.tweak_values?.PREFERRED ?? {};
  for (const [key, remoteVal] of Object.entries(preferredTweaks)) {
    if (!RECOGNIZED_TWEAK_KEYS.has(key)) {
      blockers.push({
        code: 'UNKNOWN_REMOTE_SETTING',
        message: `Unrecognized remote preferred setting '${key}' cannot be safely negotiated`,
        suggestion: 'Update client to support this LiveSync setting or remove it from the remote milestone',
      });
      continue;
    }

    if (IncompatibleChanges.includes(key as any)) {
      if (key === 'encrypt') {
        const localEncrypt = Boolean(localConfig.encryption?.enabled);
        const remoteEncrypt = Boolean(remoteVal);
        if (localEncrypt !== remoteEncrypt) {
          blockers.push({
            code: 'INCOMPATIBLE_TWEAK',
            message: `Incompatible difference for 'encrypt': remote=${remoteEncrypt}, local=${localEncrypt}`,
            suggestion: 'Match encryption configuration in your YAML config with remote database settings',
          });
        }
      } else {
        // Adopt remote-incompatible tweaks for pull decode (path/case/dynamic-iteration).
        adoptedTweaks[key] = remoteVal;
        negotiatedSettings[key] = remoteVal;
      }
    } else if (CompatibleButLossyChanges.includes(key as any) || SupportedOptionalTweaks.includes(key as any)) {
      adoptedTweaks[key] = remoteVal;
      negotiatedSettings[key] = remoteVal;
    }
  }

  // 4. Encryption & Passphrase Gate
  const isEncrypted =
    preferredTweaks.encrypt === true ||
    Boolean(probeResult.syncParamsDoc?.pbkdf2salt) ||
    Boolean(probeResult.syncinfoDoc?.data && String(probeResult.syncinfoDoc.data).startsWith('%'));

  if (isEncrypted && !passphraseVerified) {
    blockers.push({
      code: 'AUTHENTICATION_ERROR',
      message: 'Decryption failed: supplied passphrase does not match remote encryption',
      suggestion: 'Check encryption.passphrase in your YAML configuration or LIVESYNC_PASSPHRASE env var',
    });
  }

  // 5. Capabilities resolution (CONF-06)
  const admitted = blockers.length === 0;
  const admittedCapabilities = admitted
    ? (['read_only_admission', 'chunk_v2', 'compatible_tweaks'] as const)
    : [];
  const unsupportedCapabilities = admitted
    ? (['write_sync', 'bidirectional_replication'] as const)
    : (['read_only_admission', 'chunk_v2', 'compatible_tweaks', 'write_sync', 'bidirectional_replication'] as const);

  const remoteFingerprint = computeFingerprint(
    localConfig.remote.url,
    localConfig.remote.database
  );
  const negotiatedSettingsHash = computeSettingsHash(negotiatedSettings);

  return {
    admitted,
    remoteFingerprint,
    negotiatedSettingsHash,
    negotiatedSettings,
    adoptedTweaks,
    blockers,
    admittedCapabilities,
    unsupportedCapabilities,
  };
}
