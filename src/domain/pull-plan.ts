import { createHash } from 'node:crypto';

const NOTE_TYPES = new Set(['notes', 'newnote', 'plain']);
const SPECIAL_NOTE_TYPES = new Set(['leaf', 'versioninfo']);

export type PullAction =
  | { kind: 'create'; path: string; sourceRevision: string; bytes: Uint8Array }
  | { kind: 'skip-logical-delete'; path: string; sourceRevision: string }
  | { kind: 'skip-special'; id: string; type: string }
  | { kind: 'skip-ignored'; path: string }
  | { kind: 'block'; path?: string; id: string; code: string; message: string };

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
  | { kind: 'block'; id: string; path?: string; code: string; message: string };

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
}

export function isSupportedNoteType(type: string): boolean {
  return NOTE_TYPES.has(type);
}

export function buildPullPlan(observations: readonly PullObservation[]): PullAction[] {
  const actions: PullAction[] = [];

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
      });
      continue;
    }

    if (observation.deleted) {
      actions.push({
        kind: 'skip-logical-delete',
        path: observation.path,
        sourceRevision: observation.sourceRevision,
      });
      continue;
    }

    if (!isSupportedNoteType(observation.type) || SPECIAL_NOTE_TYPES.has(observation.type)) {
      actions.push({
        kind: 'skip-special',
        id: observation.path,
        type: observation.type,
      });
      continue;
    }

    actions.push({
      kind: 'create',
      path: observation.path,
      sourceRevision: observation.sourceRevision,
      bytes: observation.bytes,
    });
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
    };
  });
}
