import { describe, it, expect } from 'vitest';
import { buildSyncPlan, serializeSyncPlan } from '../../src/domain/sync-plan.js';
import type { PullObservation } from '../../src/domain/pull-plan.js';
import type { VaultFileEntry } from '../../src/filesystem/vault-scanner.js';
import type { ProvenanceRecord } from '../../src/storage/provenance-repo.js';

describe('buildSyncPlan', () => {
  it('generates push-create for new local file and pull-create for new remote file', () => {
    const remoteObs: PullObservation[] = [
      {
        kind: 'note',
        path: 'RemoteOnly.md',
        sourceRevision: '1-rem',
        type: 'plain',
        deleted: false,
        bytes: new TextEncoder().encode('Remote content'),
      },
    ];

    const localFiles = new Map<string, VaultFileEntry>([
      [
        'LocalOnly.md',
        {
          path: 'LocalOnly.md',
          size: 50,
          mtime: 1000,
          contentSha256: 'sha-local',
        },
      ],
    ]);

    const provenanceMap = new Map<string, ProvenanceRecord>();

    const actions = buildSyncPlan(remoteObs, localFiles, provenanceMap);

    const pullCreate = actions.find((a) => a.kind === 'pull-create');
    expect(pullCreate).toBeDefined();
    expect(pullCreate?.path).toBe('RemoteOnly.md');

    const pushCreate = actions.find((a) => a.kind === 'push-create');
    expect(pushCreate).toBeDefined();
    expect(pushCreate?.path).toBe('LocalOnly.md');
  });

  it('generates push-update when local file is modified and remote is untouched (SYNC-02)', () => {
    const remoteObs: PullObservation[] = [
      {
        kind: 'note',
        path: 'Doc.md',
        sourceRevision: '1-base',
        type: 'plain',
        deleted: false,
        bytes: new TextEncoder().encode('Original content'),
      },
    ];

    const localFiles = new Map<string, VaultFileEntry>([
      [
        'Doc.md',
        {
          path: 'Doc.md',
          size: 100,
          mtime: 2000,
          contentSha256: 'sha-modified',
        },
      ],
    ]);

    const provenanceMap = new Map<string, ProvenanceRecord>([
      [
        'Doc.md',
        {
          path: 'Doc.md',
          remoteRevision: '1-base',
          contentSha256: 'sha-original',
          observedMtime: 1000,
          remoteFingerprint: 'fp',
          reflectedAt: '2026-09-06T00:00:00Z',
        },
      ],
    ]);

    const actions = buildSyncPlan(remoteObs, localFiles, provenanceMap);

    const pushUpdate = actions.find((a) => a.kind === 'push-update');
    expect(pushUpdate).toBeDefined();
    expect(pushUpdate).toMatchObject({
      kind: 'push-update',
      path: 'Doc.md',
      baseRev: '1-base',
      contentSha256: 'sha-modified',
    });
  });

  it('generates push-delete when local file is deleted and remote is untouched (SYNC-04)', () => {
    const remoteObs: PullObservation[] = [
      {
        kind: 'note',
        path: 'DeletedLocal.md',
        sourceRevision: '2-base',
        type: 'plain',
        deleted: false,
        bytes: new TextEncoder().encode('Content'),
      },
    ];

    const localFiles = new Map<string, VaultFileEntry>(); // Empty local files

    const provenanceMap = new Map<string, ProvenanceRecord>([
      [
        'DeletedLocal.md',
        {
          path: 'DeletedLocal.md',
          remoteRevision: '2-base',
          contentSha256: 'sha-prev',
          observedMtime: 1000,
          remoteFingerprint: 'fp',
          reflectedAt: '2026-09-06T00:00:00Z',
        },
      ],
    ]);

    const actions = buildSyncPlan(remoteObs, localFiles, provenanceMap);

    const pushDelete = actions.find((a) => a.kind === 'push-delete');
    expect(pushDelete).toBeDefined();
    expect(pushDelete).toMatchObject({
      kind: 'push-delete',
      path: 'DeletedLocal.md',
      baseRev: '2-base',
    });
  });

  it('serializes sync plan correctly for dry-run preview (SYNC-08)', () => {
    const remoteObs: PullObservation[] = [
      {
        kind: 'note',
        path: 'Note.md',
        sourceRevision: '1-base',
        type: 'plain',
        deleted: false,
        bytes: new TextEncoder().encode('Same'),
      },
    ];

    const sameContent = 'Same';
    const sameHash = '2a98b1deb68c7223d1367ad0671045f6835d960785aa24ebf18a69d64900cd42';

    const localFiles = new Map<string, VaultFileEntry>([
      [
        'Note.md',
        {
          path: 'Note.md',
          size: 4,
          mtime: 1000,
          contentSha256: sameHash,
        },
      ],
    ]);

    const provenanceMap = new Map<string, ProvenanceRecord>([
      [
        'Note.md',
        {
          path: 'Note.md',
          remoteRevision: '1-base',
          contentSha256: sameHash,
          observedMtime: 1000,
          remoteFingerprint: 'fp',
          reflectedAt: '2026-09-06T00:00:00Z',
        },
      ],
    ]);

    const actions = buildSyncPlan(remoteObs, localFiles, provenanceMap);
    const serialized = serializeSyncPlan(actions);

    expect(serialized.summary.noops).toBe(1);
    expect(serialized.summary.conflicts).toBe(0);
    expect(serialized.summary.totalActions).toBe(1);
    expect(serialized.actions[0].kind).toBe('noop');
  });
});
