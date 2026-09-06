import { createHash } from 'node:crypto';

const NOTE_TYPES = new Set(['notes', 'newnote', 'plain']);
const SPECIAL_NOTE_TYPES = new Set(['leaf', 'versioninfo']);

export type PullAction =
  | { kind: 'create'; path: string; sourceRevision: string; bytes: Uint8Array }
  | { kind: 'noop'; path: string; sourceRevision: string; contentSha256: string }
  | { kind: 'quarantine-delete'; path: string; sourceRevision?: string }
  | { kind: 'skip-logical-delete'; path: string; sourceRevision: string }
  | { kind: 'skip-special'; id: string; type: string }
  | { kind: 'skip-ignored'; path: string }
  | {
      kind: 'block';
      path?: string;
      id: string;
      code: string;
      message: string;
      suggestion?: string;
    };

export interface LocalFileInspection {
  readonly exists: boolean;
  readonly contentSha256?: string;
}

export type PullObservation =
  | {
      kind: 'note';
      path: string;
      sourceRevision: string;
      type: string;
      deleted: boolean;
      bytes: Uint8Array;
    }
  | { kind: 'special'; id: string; type: string }
  | { kind: 'ignored'; path: string }
  | { kind: 'block'; id: string; path?: string; code: string; message: string; suggestion?: string };

export interface DecodeFailureObservation {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly id: string;
  readonly path?: string;
}

export interface SerializedPullAction {
  readonly kind: PullAction['kind'];
  readonly path?: string;
  readonly id?: string;
  readonly sourceRevision?: string;
  readonly type?: string;
  readonly byteLength?: number;
  readonly contentSha256?: string;
  readonly code?: string;
  readonly message?: string;
  readonly suggestion?: string;
}

export function suggestionForBlock(code: string): string {
  switch (code) {
    case 'DECRYPT_FAILED':
    case 'AUTHENTICATION':
      return 'Verify encryption.passphrase matches the remote LiveSync passphrase';
    case 'MISSING_CHUNK':
      return 'Wait for every children chunk id to exist on the remote, then retry pull';
    case 'SIZE_MISMATCH':
      return 'Do not materialize the path; the assembled payload does not match metadata size';
    case 'PATH_ID_MISMATCH':
      return 'Use the decrypted document path; never guess a vault name from an f: document id';
    case 'UNSUPPORTED_NOTE_SHAPE':
      return 'Skip or block unsupported document shapes; never PUT them back to CouchDB';
    case 'CONFLICT_LEAVES':
      return 'Resolve every live non-deleted leaf before applying pull; the CouchDB winner is not materialized';
    default:
      return 'Resolve the validation failure before applying pull; no remote writes are issued';
  }
}

export function observationFromDecodeFailure(failure: DecodeFailureObservation): PullObservation {
  return {
    kind: 'block',
    id: failure.id,
    path: failure.path,
    code: failure.code,
    message: failure.message,
    suggestion: suggestionForBlock(failure.code),
  };
}

export function isSupportedNoteType(type: string): boolean {
  return NOTE_TYPES.has(type);
}

function noteGroupKey(observation: Extract<PullObservation, { kind: 'note' }>): string {
  return observation.path;
}

function actionFromLiveNote(observation: Extract<PullObservation, { kind: 'note' }>): PullAction {
  if (!isSupportedNoteType(observation.type) || SPECIAL_NOTE_TYPES.has(observation.type)) {
    return {
      kind: 'skip-special',
      id: observation.path,
      type: observation.type,
    };
  }

  return {
    kind: 'create',
    path: observation.path,
    sourceRevision: observation.sourceRevision,
    bytes: observation.bytes,
  };
}

export function buildPullPlan(observations: readonly PullObservation[]): PullAction[] {
  const actions: PullAction[] = [];
  const consumedNoteKeys = new Set<string>();

  for (const observation of observations) {
    if (observation.kind === 'special') {
      actions.push({ kind: 'skip-special', id: observation.id, type: observation.type });
      continue;
    }

    if (observation.kind === 'ignored') {
      actions.push({ kind: 'skip-ignored', path: observation.path });
      continue;
    }

    if (observation.kind === 'block') {
      actions.push({
        kind: 'block',
        id: observation.id,
        path: observation.path,
        code: observation.code,
        message: observation.message,
        suggestion: observation.suggestion ?? suggestionForBlock(observation.code),
      });
      continue;
    }

    const key = noteGroupKey(observation);
    if (consumedNoteKeys.has(key)) {
      continue;
    }
    consumedNoteKeys.add(key);

    const group = observations.filter(
      (candidate): candidate is Extract<PullObservation, { kind: 'note' }> =>
        candidate.kind === 'note' && noteGroupKey(candidate) === key
    );
    const live = group.filter((candidate) => !candidate.deleted);

    if (live.length >= 2) {
      actions.push({
        kind: 'block',
        id: key,
        path: observation.path,
        code: 'CONFLICT_LEAVES',
        message: `Path '${observation.path}' has ${live.length} live non-deleted revision leaves; the CouchDB winner is not materialized`,
        suggestion: suggestionForBlock('CONFLICT_LEAVES'),
      });
      continue;
    }

    if (live.length === 0) {
      actions.push({
        kind: 'skip-logical-delete',
        path: observation.path,
        sourceRevision: observation.sourceRevision,
      });
      continue;
    }

    actions.push(actionFromLiveNote(live[0]));
  }

  return actions;
}

export interface ProvenanceLookup {
  readonly remoteRevision: string;
  readonly contentSha256: string;
}

export function buildRecoverablePullPlan(
  observations: readonly PullObservation[],
  existingProvenance: ReadonlyMap<string, ProvenanceLookup>,
  localFiles: ReadonlyMap<string, LocalFileInspection>
): PullAction[] {
  const actions: PullAction[] = [];
  const consumedNoteKeys = new Set<string>();

  for (const observation of observations) {
    if (observation.kind === 'special') {
      actions.push({ kind: 'skip-special', id: observation.id, type: observation.type });
      continue;
    }

    if (observation.kind === 'ignored') {
      actions.push({ kind: 'skip-ignored', path: observation.path });
      continue;
    }

    if (observation.kind === 'block') {
      actions.push({
        kind: 'block',
        id: observation.id,
        path: observation.path,
        code: observation.code,
        message: observation.message,
        suggestion: observation.suggestion ?? suggestionForBlock(observation.code),
      });
      continue;
    }

    const key = noteGroupKey(observation);
    if (consumedNoteKeys.has(key)) {
      continue;
    }
    consumedNoteKeys.add(key);

    const group = observations.filter(
      (candidate): candidate is Extract<PullObservation, { kind: 'note' }> =>
        candidate.kind === 'note' && noteGroupKey(candidate) === key
    );
    const live = group.filter((candidate) => !candidate.deleted);

    if (live.length >= 2) {
      actions.push({
        kind: 'block',
        id: key,
        path: observation.path,
        code: 'CONFLICT_LEAVES',
        message: `Path '${observation.path}' has ${live.length} live non-deleted revision leaves; the CouchDB winner is not materialized`,
        suggestion: suggestionForBlock('CONFLICT_LEAVES'),
      });
      continue;
    }

    if (live.length === 0) {
      const localInfo = localFiles.get(observation.path);
      if (localInfo?.exists) {
        actions.push({
          kind: 'quarantine-delete',
          path: observation.path,
          sourceRevision: group[0]?.sourceRevision,
        });
      } else {
        actions.push({
          kind: 'skip-logical-delete',
          path: observation.path,
          sourceRevision: group[0]?.sourceRevision ?? '',
        });
      }
      continue;
    }

    const leaf = live[0];
    if (!isSupportedNoteType(leaf.type) || SPECIAL_NOTE_TYPES.has(leaf.type)) {
      actions.push({
        kind: 'skip-special',
        id: leaf.path,
        type: leaf.type,
      });
      continue;
    }

    const computedSha256 = createHash('sha256').update(leaf.bytes).digest('hex');
    const prov = existingProvenance.get(leaf.path);
    const localInfo = localFiles.get(leaf.path);

    if (
      localInfo?.exists &&
      prov &&
      prov.remoteRevision === leaf.sourceRevision &&
      prov.contentSha256 === computedSha256 &&
      localInfo.contentSha256 === computedSha256
    ) {
      actions.push({
        kind: 'noop',
        path: leaf.path,
        sourceRevision: leaf.sourceRevision,
        contentSha256: computedSha256,
      });
    } else {
      actions.push({
        kind: 'create',
        path: leaf.path,
        sourceRevision: leaf.sourceRevision,
        bytes: leaf.bytes,
      });
    }
  }

  return actions;
}

export function serializePullActions(actions: readonly PullAction[]): SerializedPullAction[] {
  return actions.map((action) => {
    if (action.kind === 'create') {
      return {
        kind: action.kind,
        path: action.path,
        sourceRevision: action.sourceRevision,
        byteLength: action.bytes.byteLength,
        contentSha256: createHash('sha256').update(action.bytes).digest('hex'),
      };
    }

    if (action.kind === 'noop') {
      return {
        kind: action.kind,
        path: action.path,
        sourceRevision: action.sourceRevision,
        contentSha256: action.contentSha256,
      };
    }

    if (action.kind === 'quarantine-delete') {
      return {
        kind: action.kind,
        path: action.path,
        sourceRevision: action.sourceRevision,
      };
    }

    if (action.kind === 'skip-logical-delete') {
      return {
        kind: action.kind,
        path: action.path,
        sourceRevision: action.sourceRevision,
      };
    }

    if (action.kind === 'skip-special') {
      return {
        kind: action.kind,
        id: action.id,
        type: action.type,
      };
    }

    if (action.kind === 'skip-ignored') {
      return {
        kind: action.kind,
        path: action.path,
      };
    }

    return {
      kind: action.kind,
      path: action.path,
      id: action.id,
      code: action.code,
      message: action.message,
      suggestion: action.suggestion,
    };
  });
}

