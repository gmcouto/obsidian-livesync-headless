import { createHash } from 'node:crypto';
import type { VaultFileEntry } from '../filesystem/vault-scanner.js';
import type { ProvenanceRecord } from '../storage/provenance-repo.js';
import type { PullObservation } from './pull-plan.js';
import { RenameDetector } from './rename-detector.js';

export type SyncAction =
  | {
      readonly kind: 'pull-create';
      readonly path: string;
      readonly sourceRevision: string;
      readonly bytes: Uint8Array;
      readonly contentSha256: string;
    }
  | {
      readonly kind: 'pull-update';
      readonly path: string;
      readonly sourceRevision: string;
      readonly bytes: Uint8Array;
      readonly contentSha256: string;
    }
  | {
      readonly kind: 'pull-delete';
      readonly path: string;
      readonly sourceRevision: string;
    }
  | {
      readonly kind: 'push-create';
      readonly path: string;
      readonly contentSha256: string;
      readonly bytes: Uint8Array;
      readonly size: number;
      readonly mtime: number;
    }
  | {
      readonly kind: 'push-update';
      readonly path: string;
      readonly baseRev: string;
      readonly contentSha256: string;
      readonly bytes: Uint8Array;
      readonly size: number;
      readonly mtime: number;
    }
  | {
      readonly kind: 'push-delete';
      readonly path: string;
      readonly baseRev: string;
    }
  | {
      readonly kind: 'rename-case';
      readonly oldPath: string;
      readonly newPath: string;
      readonly baseRev: string;
      readonly contentSha256: string;
    }
  | {
      readonly kind: 'rename-cross';
      readonly oldPath: string;
      readonly newPath: string;
      readonly baseRev: string;
      readonly contentSha256: string;
      readonly bytes: Uint8Array;
      readonly size: number;
      readonly mtime: number;
    }
  | {
      readonly kind: 'noop';
      readonly path: string;
      readonly revision: string;
      readonly contentSha256: string;
    }
  | {
      readonly kind: 'conflict';
      readonly path: string;
      readonly reason: string;
      readonly localSha256?: string;
      readonly remoteRevs?: string[];
      readonly remoteSha256s?: string[];
    }
  | {
      readonly kind: 'skip-ignored';
      readonly path: string;
    };

export interface SyncPlanOptions {
  readonly localFileLoader?: (path: string) => Promise<Uint8Array>;
}

export interface SerializedSyncAction {
  readonly kind: SyncAction['kind'];
  readonly path: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly baseRev?: string;
  readonly sourceRevision?: string;
  readonly contentSha256?: string;
  readonly size?: number;
  readonly reason?: string;
}

export interface SerializedSyncPlan {
  readonly summary: {
    readonly totalActions: number;
    readonly pullCreates: number;
    readonly pullUpdates: number;
    readonly pullDeletes: number;
    readonly pushCreates: number;
    readonly pushUpdates: number;
    readonly pushDeletes: number;
    readonly renames: number;
    readonly noops: number;
    readonly conflicts: number;
  };
  readonly actions: SerializedSyncAction[];
}

interface ResolvedRemoteLeaf {
  readonly path: string;
  readonly sourceRevision: string;
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
  readonly deleted: boolean;
  readonly hasConflictLeaves?: boolean;
}

function resolveRemoteLeaves(observations: readonly PullObservation[]): Map<string, ResolvedRemoteLeaf | { conflict: true; path: string; leaves: Extract<PullObservation, { kind: 'note' }>[] }> {
  const byPath = new Map<string, Extract<PullObservation, { kind: 'note' }>[]>();

  for (const obs of observations) {
    if (obs.kind === 'note') {
      const existing = byPath.get(obs.path) ?? [];
      existing.push(obs);
      byPath.set(obs.path, existing);
    }
  }

  const result = new Map<string, ResolvedRemoteLeaf | { conflict: true; path: string; leaves: Extract<PullObservation, { kind: 'note' }>[] }>();

  for (const [path, group] of byPath.entries()) {
    const live = group.filter((g) => !g.deleted);

    if (live.length === 0) {
      // Logical deletion on remote
      result.set(path, {
        path,
        sourceRevision: group[0]?.sourceRevision ?? '',
        bytes: new Uint8Array(),
        contentSha256: '',
        deleted: true,
      });
      continue;
    }

    if (live.length === 1) {
      const leaf = live[0];
      const hash = createHash('sha256').update(leaf.bytes).digest('hex');
      result.set(path, {
        path,
        sourceRevision: leaf.sourceRevision,
        bytes: leaf.bytes,
        contentSha256: hash,
        deleted: false,
      });
      continue;
    }

    // Multiple live leaves (CouchDB conflict)
    // Check for byte-identical conflict leaves (SYNC-06)
    const hashes = live.map((l) => createHash('sha256').update(l.bytes).digest('hex'));
    const allIdentical = hashes.every((h) => h === hashes[0]);

    if (allIdentical) {
      // Safe collapse of byte-identical conflict leaves (SYNC-06)
      // Pick highest revision or first sorted
      const sorted = [...live].sort((a, b) => b.sourceRevision.localeCompare(a.sourceRevision));
      result.set(path, {
        path,
        sourceRevision: sorted[0].sourceRevision,
        bytes: sorted[0].bytes,
        contentSha256: hashes[0],
        deleted: false,
        hasConflictLeaves: true,
      });
    } else {
      // Divergent conflict leaves (SYNC-06, SYNC-07)
      result.set(path, {
        conflict: true,
        path,
        leaves: live,
      });
    }
  }

  return result;
}

export function buildSyncPlan(
  remoteObservations: readonly PullObservation[],
  localFiles: Map<string, VaultFileEntry>,
  provenanceMap: Map<string, ProvenanceRecord>,
  localFileBytesMap?: Map<string, Uint8Array>
): SyncAction[] {
  const actions: SyncAction[] = [];
  const remoteLeaves = resolveRemoteLeaves(remoteObservations);

  // 1. Detect renames (SYNC-05)
  const renameDetector = new RenameDetector();
  const renameResult = renameDetector.detectRenames(localFiles, provenanceMap);

  for (const caseRename of renameResult.caseRenames) {
    actions.push({
      kind: 'rename-case',
      oldPath: caseRename.oldPath,
      newPath: caseRename.newPath,
      baseRev: caseRename.baseRev,
      contentSha256: caseRename.contentSha256,
    });
  }

  for (const crossRename of renameResult.crossPathRenames) {
    const localEntry = localFiles.get(crossRename.newPath)!;
    const bytes = localFileBytesMap?.get(crossRename.newPath) ?? new Uint8Array();
    actions.push({
      kind: 'rename-cross',
      oldPath: crossRename.oldPath,
      newPath: crossRename.newPath,
      baseRev: crossRename.baseRev,
      contentSha256: crossRename.contentSha256,
      bytes,
      size: localEntry.size,
      mtime: localEntry.mtime,
    });
  }

  // 2. Collect all distinct non-consumed paths
  const allPaths = new Set<string>();
  for (const p of remoteLeaves.keys()) allPaths.add(p);
  for (const p of localFiles.keys()) {
    if (!renameResult.consumedCreatedPaths.has(p)) {
      allPaths.add(p);
    }
  }
  for (const p of provenanceMap.keys()) {
    if (!renameResult.consumedDeletedPaths.has(p)) {
      allPaths.add(p);
    }
  }

  for (const path of allPaths) {
    const remoteResolved = remoteLeaves.get(path);
    const localEntry = localFiles.get(path);
    const prov = provenanceMap.get(path);

    // If remote has divergent conflict leaves
    if (remoteResolved && 'conflict' in remoteResolved) {
      actions.push({
        kind: 'conflict',
        path,
        reason: `Remote has ${remoteResolved.leaves.length} divergent live conflict leaves.`,
        localSha256: localEntry?.contentSha256,
        remoteRevs: remoteResolved.leaves.map((l) => l.sourceRevision),
      });
      continue;
    }

    const remote = remoteResolved as ResolvedRemoteLeaf | undefined;

    // Case A: File exists in Local, Remote, and Provenance
    if (localEntry && remote && !remote.deleted && prov) {
      const localMatchesRemote = localEntry.contentSha256 === remote.contentSha256;
      const remoteMatchesProv = remote.sourceRevision === prov.remoteRevision;
      const localMatchesProv = localEntry.contentSha256 === prov.contentSha256;

      if (localMatchesRemote) {
        actions.push({
          kind: 'noop',
          path,
          revision: remote.sourceRevision,
          contentSha256: remote.contentSha256,
        });
      } else if (remoteMatchesProv && !localMatchesProv) {
        // Local modified, remote untouched -> push-update (SYNC-02)
        const bytes = localFileBytesMap?.get(path) ?? new Uint8Array();
        actions.push({
          kind: 'push-update',
          path,
          baseRev: prov.remoteRevision,
          contentSha256: localEntry.contentSha256,
          bytes,
          size: localEntry.size,
          mtime: localEntry.mtime,
        });
      } else if (!remoteMatchesProv && localMatchesProv) {
        // Remote modified, local untouched -> pull-update
        actions.push({
          kind: 'pull-update',
          path,
          sourceRevision: remote.sourceRevision,
          bytes: remote.bytes,
          contentSha256: remote.contentSha256,
        });
      } else {
        // Both modified independently -> conflict (SYNC-06, SYNC-07)
        actions.push({
          kind: 'conflict',
          path,
          reason: 'Both local file and remote document were modified independently.',
          localSha256: localEntry.contentSha256,
          remoteRevs: [remote.sourceRevision],
          remoteSha256s: [remote.contentSha256],
        });
      }
      continue;
    }

    // Case B: File exists in Local only (New local file)
    if (localEntry && (!remote || remote.deleted) && !prov) {
      const bytes = localFileBytesMap?.get(path) ?? new Uint8Array();
      actions.push({
        kind: 'push-create',
        path,
        contentSha256: localEntry.contentSha256,
        bytes,
        size: localEntry.size,
        mtime: localEntry.mtime,
      });
      continue;
    }

    // Case C: File exists in Remote only (New remote file)
    if (!localEntry && remote && !remote.deleted && !prov) {
      actions.push({
        kind: 'pull-create',
        path,
        sourceRevision: remote.sourceRevision,
        bytes: remote.bytes,
        contentSha256: remote.contentSha256,
      });
      continue;
    }

    // Case D: File deleted locally, exists on Remote and in Provenance
    if (!localEntry && remote && !remote.deleted && prov) {
      if (remote.sourceRevision === prov.remoteRevision) {
        // Local deletion, remote untouched -> push-delete (SYNC-04)
        actions.push({
          kind: 'push-delete',
          path,
          baseRev: prov.remoteRevision,
        });
      } else {
        // Remote modified while local deleted -> conflict (SYNC-06)
        actions.push({
          kind: 'conflict',
          path,
          reason: 'File was deleted locally but modified remotely.',
          remoteRevs: [remote.sourceRevision],
          remoteSha256s: [remote.contentSha256],
        });
      }
      continue;
    }

    // Case E: File deleted remotely, exists in Local and Provenance
    if (localEntry && remote && remote.deleted && prov) {
      if (localEntry.contentSha256 === prov.contentSha256) {
        // Remote deletion, local untouched -> pull-delete
        actions.push({
          kind: 'pull-delete',
          path,
          sourceRevision: remote.sourceRevision,
        });
      } else {
        // Local modified while remote deleted -> conflict (SYNC-07)
        actions.push({
          kind: 'conflict',
          path,
          reason: 'File was deleted remotely but modified locally.',
          localSha256: localEntry.contentSha256,
          remoteRevs: [remote.sourceRevision],
        });
      }
      continue;
    }

    // Case F: File already deleted on both sides or already clean
    if (!localEntry && remote && remote.deleted && !prov) {
      // Both sides recognize deletion
      continue;
    }
  }

  return actions;
}

export function serializeSyncPlan(actions: readonly SyncAction[]): SerializedSyncPlan {
  let pullCreates = 0;
  let pullUpdates = 0;
  let pullDeletes = 0;
  let pushCreates = 0;
  let pushUpdates = 0;
  let pushDeletes = 0;
  let renames = 0;
  let noops = 0;
  let conflicts = 0;

  const serializedActions: SerializedSyncAction[] = [];

  for (const action of actions) {
    switch (action.kind) {
      case 'pull-create':
        pullCreates++;
        serializedActions.push({
          kind: action.kind,
          path: action.path,
          sourceRevision: action.sourceRevision,
          contentSha256: action.contentSha256,
          size: action.bytes.byteLength,
        });
        break;
      case 'pull-update':
        pullUpdates++;
        serializedActions.push({
          kind: action.kind,
          path: action.path,
          sourceRevision: action.sourceRevision,
          contentSha256: action.contentSha256,
          size: action.bytes.byteLength,
        });
        break;
      case 'pull-delete':
        pullDeletes++;
        serializedActions.push({
          kind: action.kind,
          path: action.path,
          sourceRevision: action.sourceRevision,
        });
        break;
      case 'push-create':
        pushCreates++;
        serializedActions.push({
          kind: action.kind,
          path: action.path,
          contentSha256: action.contentSha256,
          size: action.size,
        });
        break;
      case 'push-update':
        pushUpdates++;
        serializedActions.push({
          kind: action.kind,
          path: action.path,
          baseRev: action.baseRev,
          contentSha256: action.contentSha256,
          size: action.size,
        });
        break;
      case 'push-delete':
        pushDeletes++;
        serializedActions.push({
          kind: action.kind,
          path: action.path,
          baseRev: action.baseRev,
        });
        break;
      case 'rename-case':
        renames++;
        serializedActions.push({
          kind: action.kind,
          path: action.newPath,
          oldPath: action.oldPath,
          newPath: action.newPath,
          baseRev: action.baseRev,
          contentSha256: action.contentSha256,
        });
        break;
      case 'rename-cross':
        renames++;
        serializedActions.push({
          kind: action.kind,
          path: action.newPath,
          oldPath: action.oldPath,
          newPath: action.newPath,
          baseRev: action.baseRev,
          contentSha256: action.contentSha256,
          size: action.size,
        });
        break;
      case 'noop':
        noops++;
        serializedActions.push({
          kind: action.kind,
          path: action.path,
          sourceRevision: action.revision,
          contentSha256: action.contentSha256,
        });
        break;
      case 'conflict':
        conflicts++;
        serializedActions.push({
          kind: action.kind,
          path: action.path,
          reason: action.reason,
          contentSha256: action.localSha256,
        });
        break;
      case 'skip-ignored':
        serializedActions.push({
          kind: action.kind,
          path: action.path,
        });
        break;
    }
  }

  return {
    summary: {
      totalActions: actions.length,
      pullCreates,
      pullUpdates,
      pullDeletes,
      pushCreates,
      pushUpdates,
      pushDeletes,
      renames,
      noops,
      conflicts,
    },
    actions: serializedActions,
  };
}
