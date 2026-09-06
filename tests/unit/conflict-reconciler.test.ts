import { describe, it, expect } from 'vitest';
import { buildSyncPlan } from '../../src/domain/sync-plan.js';
import type { PullObservation } from '../../src/domain/pull-plan.js';
import type { VaultFileEntry } from '../../src/filesystem/vault-scanner.js';
import type { ProvenanceRecord } from '../../src/storage/provenance-repo.js';

describe('Conflict Reconciler', () => {
  it('safely collapses byte-identical remote conflict leaves into single leaf (SYNC-06)', () => {
    const identicalBytes = new TextEncoder().encode('Identical content across two conflict branches');

    // Two remote leaves with different revisions but identical content
    const remoteObs: PullObservation[] = [
      {
        kind: 'note',
        path: 'ConflictNote.md',
        sourceRevision: '2-branchA',
        type: 'plain',
        deleted: false,
        bytes: identicalBytes,
      },
      {
        kind: 'note',
        path: 'ConflictNote.md',
        sourceRevision: '2-branchB',
        type: 'plain',
        deleted: false,
        bytes: identicalBytes,
      },
    ];

    const localFiles = new Map<string, VaultFileEntry>();
    const provenanceMap = new Map<string, ProvenanceRecord>();

    const actions = buildSyncPlan(remoteObs, localFiles, provenanceMap);

    // Collapsed successfully into pull-create rather than conflict
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('pull-create');
    expect(actions[0].path).toBe('ConflictNote.md');
  });

  it('preserves divergent conflict leaves and reports conflict without clobbering (SYNC-06, SYNC-07)', () => {
    const branchABytes = new TextEncoder().encode('Content from Device A');
    const branchBBytes = new TextEncoder().encode('Content from Device B');

    const remoteObs: PullObservation[] = [
      {
        kind: 'note',
        path: 'Divergent.md',
        sourceRevision: '2-devA',
        type: 'plain',
        deleted: false,
        bytes: branchABytes,
      },
      {
        kind: 'note',
        path: 'Divergent.md',
        sourceRevision: '2-devB',
        type: 'plain',
        deleted: false,
        bytes: branchBBytes,
      },
    ];

    const localFiles = new Map<string, VaultFileEntry>();
    const provenanceMap = new Map<string, ProvenanceRecord>();

    const actions = buildSyncPlan(remoteObs, localFiles, provenanceMap);

    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('conflict');
    expect(actions[0].path).toBe('Divergent.md');
  });

  it('reports conflict when local and remote are modified independently', () => {
    const remoteObs: PullObservation[] = [
      {
        kind: 'note',
        path: 'BothModified.md',
        sourceRevision: '2-remoteEdit',
        type: 'plain',
        deleted: false,
        bytes: new TextEncoder().encode('Remote edit'),
      },
    ];

    const localFiles = new Map<string, VaultFileEntry>([
      [
        'BothModified.md',
        {
          path: 'BothModified.md',
          size: 10,
          mtime: 2000,
          contentSha256: 'sha-local-edit',
        },
      ],
    ]);

    const provenanceMap = new Map<string, ProvenanceRecord>([
      [
        'BothModified.md',
        {
          path: 'BothModified.md',
          remoteRevision: '1-original',
          contentSha256: 'sha-original',
          observedMtime: 1000,
          remoteFingerprint: 'fp',
          reflectedAt: '2026-09-06T00:00:00Z',
        },
      ],
    ]);

    const actions = buildSyncPlan(remoteObs, localFiles, provenanceMap);

    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('conflict');
    expect(actions[0].path).toBe('BothModified.md');
  });

  it('reports conflict when remote is deleted but local was modified (SYNC-07)', () => {
    const remoteObs: PullObservation[] = [
      {
        kind: 'note',
        path: 'DelRemoteLocalEdit.md',
        sourceRevision: '2-delRev',
        type: 'notes',
        deleted: true,
        bytes: new Uint8Array(),
      },
    ];

    const localFiles = new Map<string, VaultFileEntry>([
      [
        'DelRemoteLocalEdit.md',
        {
          path: 'DelRemoteLocalEdit.md',
          size: 20,
          mtime: 2000,
          contentSha256: 'sha-modified-local',
        },
      ],
    ]);

    const provenanceMap = new Map<string, ProvenanceRecord>([
      [
        'DelRemoteLocalEdit.md',
        {
          path: 'DelRemoteLocalEdit.md',
          remoteRevision: '1-orig',
          contentSha256: 'sha-orig',
          observedMtime: 1000,
          remoteFingerprint: 'fp',
          reflectedAt: '2026-09-06T00:00:00Z',
        },
      ],
    ]);

    const actions = buildSyncPlan(remoteObs, localFiles, provenanceMap);

    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('conflict');
    expect(actions[0].path).toBe('DelRemoteLocalEdit.md');
  });
});
