import { describe, it, expect } from 'vitest';
import {
  negotiateCompatibility,
  IncompatibleChanges,
  CompatibleButLossyChanges,
  RECOGNIZED_TWEAK_KEYS,
} from '../../src/livesync/negotiation.js';
import type { RemoteProbeResult } from '../../src/livesync/inspector.js';
import type { LiveSyncConfig } from '../../src/config/schema.js';

describe('LiveSync Compatibility Negotiation', () => {
  const localConfig: LiveSyncConfig = {
    remote: {
      url: 'http://127.0.0.1:5984',
      database: 'my-vault',
    },
    vault: {
      path: '/tmp/vault',
    },
    state: {},
    encryption: {
      enabled: false,
    },
  };

  const baseProbeResult: RemoteProbeResult = {
    databaseInfo: {
      docCount: 10,
      updateSeq: '10-abc',
      couchdbVersion: '3.5.2',
    },
    versionDoc: {
      _id: 'obsydian_livesync_version',
      _rev: '1-v',
      version: 12,
    },
    milestoneDoc: {
      _id: '_local/obsydian_livesync_milestone',
      _rev: '1-m',
      locked: false,
      tweak_values: {
        PREFERRED: {
          hashAlg: 'sha256',
          customChunkSize: 200,
        },
      },
    },
    syncParamsDoc: null,
    syncinfoDoc: null,
    sampleDocs: [],
  };

  it('accepts compatible database and adopts compatible tweaks', () => {
    const result = negotiateCompatibility(baseProbeResult, localConfig);

    expect(result.admitted).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.adoptedTweaks).toEqual({
      hashAlg: 'sha256',
      customChunkSize: 200,
    });
    expect(result.admittedCapabilities).toContain('read_only_admission');
    expect(result.unsupportedCapabilities).toContain('write_sync');
    expect(result.remoteFingerprint).toHaveLength(64);
    expect(result.negotiatedSettingsHash).toHaveLength(64);
  });

  it('rejects version > 12 with UNSUPPORTED_REMOTE_VERSION blocker', () => {
    const probe: RemoteProbeResult = {
      ...baseProbeResult,
      versionDoc: {
        _id: 'obsydian_livesync_version',
        _rev: '1-v',
        version: 13,
      },
    };

    const result = negotiateCompatibility(probe, localConfig);
    expect(result.admitted).toBe(false);
    expect(result.blockers.some((b) => b.code === 'UNSUPPORTED_REMOTE_VERSION')).toBe(true);
  });

  it('rejects missing version document with VERSION_DOC_MISSING blocker', () => {
    const probe: RemoteProbeResult = {
      ...baseProbeResult,
      versionDoc: null,
    };

    const result = negotiateCompatibility(probe, localConfig);
    expect(result.admitted).toBe(false);
    expect(result.blockers.some((b) => b.code === 'VERSION_DOC_MISSING')).toBe(true);
  });

  it('rejects locked database with DATABASE_LOCKED blocker', () => {
    const probe: RemoteProbeResult = {
      ...baseProbeResult,
      milestoneDoc: {
        ...baseProbeResult.milestoneDoc!,
        locked: true,
      },
    };

    const result = negotiateCompatibility(probe, localConfig);
    expect(result.admitted).toBe(false);
    expect(result.blockers.some((b) => b.code === 'DATABASE_LOCKED')).toBe(true);
  });

  it('rejects missing milestone document with MILESTONE_MISSING blocker', () => {
    const probe: RemoteProbeResult = {
      ...baseProbeResult,
      milestoneDoc: null,
    };

    const result = negotiateCompatibility(probe, localConfig);
    expect(result.admitted).toBe(false);
    expect(result.blockers.some((b) => b.code === 'MILESTONE_MISSING')).toBe(true);
  });

  it('fails closed when unrecognized remote preferred tweaks are found', () => {
    const probe: RemoteProbeResult = {
      ...baseProbeResult,
      milestoneDoc: {
        ...baseProbeResult.milestoneDoc!,
        tweak_values: {
          PREFERRED: {
            hashAlg: 'sha256',
            futureExperimentalSetting: true,
          },
        },
      },
    };

    const result = negotiateCompatibility(probe, localConfig);
    expect(result.admitted).toBe(false);
    expect(result.blockers.some((b) => b.code === 'UNKNOWN_REMOTE_SETTING')).toBe(true);
  });

  it('adopts remote path, case, and dynamic-iteration tweaks for pull', () => {
    const probe: RemoteProbeResult = {
      ...baseProbeResult,
      milestoneDoc: {
        ...baseProbeResult.milestoneDoc!,
        tweak_values: {
          PREFERRED: {
            ...baseProbeResult.milestoneDoc!.tweak_values!.PREFERRED,
            usePathObfuscation: true,
            useDynamicIterationCount: true,
            handleFilenameCaseSensitive: true,
          },
        },
      },
    };

    const result = negotiateCompatibility(probe, localConfig);
    expect(result.admitted).toBe(true);
    expect(result.adoptedTweaks.usePathObfuscation).toBe(true);
    expect(result.adoptedTweaks.useDynamicIterationCount).toBe(true);
    expect(result.adoptedTweaks.handleFilenameCaseSensitive).toBe(true);
    expect(result.negotiatedSettings.usePathObfuscation).toBe(true);
    expect(result.negotiatedSettings.useDynamicIterationCount).toBe(true);
    expect(result.negotiatedSettings.handleFilenameCaseSensitive).toBe(true);
    expect(result.blockers.some((b) => b.code === 'INCOMPATIBLE_TWEAK')).toBe(false);
  });

  it('detects incompatible difference in encryption setting', () => {
    const probe: RemoteProbeResult = {
      ...baseProbeResult,
      milestoneDoc: {
        ...baseProbeResult.milestoneDoc!,
        tweak_values: {
          PREFERRED: {
            encrypt: true,
          },
        },
      },
    };

    const result = negotiateCompatibility(probe, localConfig);
    expect(result.admitted).toBe(false);
    expect(result.blockers.some((b) => b.code === 'INCOMPATIBLE_TWEAK')).toBe(true);
  });

  it('records AUTHENTICATION_ERROR blocker when encrypted database fails passphrase authentication', () => {
    const encryptedConfig: LiveSyncConfig = {
      ...localConfig,
      encryption: { enabled: true },
    };
    const probe: RemoteProbeResult = {
      ...baseProbeResult,
      milestoneDoc: {
        ...baseProbeResult.milestoneDoc!,
        tweak_values: {
          PREFERRED: {
            encrypt: true,
          },
        },
      },
      syncinfoDoc: {
        _id: 'syncinfo',
        _rev: '1-s',
        data: '%=encrypted-data',
      },
    };

    const result = negotiateCompatibility(probe, encryptedConfig, false);
    expect(result.admitted).toBe(false);
    expect(result.blockers.some((b) => b.code === 'AUTHENTICATION_ERROR')).toBe(true);
  });

  it('correctly sets unsupportedCapabilities on both admitted and rejected results', () => {
    const admittedResult = negotiateCompatibility(baseProbeResult, localConfig);
    expect(admittedResult.unsupportedCapabilities).toEqual([
      'write_sync',
      'bidirectional_replication',
    ]);

    const rejectedProbe: RemoteProbeResult = {
      ...baseProbeResult,
      versionDoc: null,
    };
    const rejectedResult = negotiateCompatibility(rejectedProbe, localConfig);
    expect(rejectedResult.admittedCapabilities).toHaveLength(0);
    expect(rejectedResult.unsupportedCapabilities).toContain('read_only_admission');
    expect(rejectedResult.unsupportedCapabilities).toContain('write_sync');
  });
});
