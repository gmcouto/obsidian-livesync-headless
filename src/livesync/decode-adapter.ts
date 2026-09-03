// Compatibility adapter targeting @vrtmrz/livesync-commonlib 0.1.21.
// This is the only new Commonlib import site for Phase 2 pull decode.
import { EntryTypes, NoteTypes } from '@vrtmrz/livesync-commonlib/compat/common/types';
import {
  path2id_base,
  id2path_base,
  shouldBeIgnored,
} from '@vrtmrz/livesync-commonlib/compat/string_and_binary/path';
import type { CouchDbDocument } from './inspector.js';

export { EntryTypes, NoteTypes, path2id_base, id2path_base, shouldBeIgnored };

const CHUNK_ID_PREFIX = 'h:';
const OBFUSCATED_NOTE_ID_PREFIX = 'f:';

export interface DecodeSuccess {
  readonly ok: true;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sourceRevision: string;
  readonly type: string;
  readonly deleted: boolean;
}

export interface DecodeFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly id: string;
  readonly path?: string;
}

export type DecodeResult = DecodeSuccess | DecodeFailure;

export function isReservedChunkId(id: string): boolean {
  return id.startsWith(CHUNK_ID_PREFIX);
}

export function isObfuscatedNoteId(id: string): boolean {
  return id.startsWith(OBFUSCATED_NOTE_ID_PREFIX);
}

export function isNoteType(type: string): boolean {
  return (NoteTypes as readonly string[]).includes(type);
}

export async function decodeNoteLeaf(
  doc: CouchDbDocument,
  options?: { handleFilenameCaseSensitive?: boolean }
): Promise<DecodeResult> {
  const type = typeof doc.type === 'string' ? doc.type : '';
  const path = typeof doc.path === 'string' ? doc.path : undefined;

  if (!path) {
    return {
      ok: false,
      code: 'MISSING_PATH',
      message: `Document '${doc._id}' is missing a vault path`,
      id: doc._id,
    };
  }

  if (shouldBeIgnored(path)) {
    return {
      ok: false,
      code: 'IGNORED',
      message: `Path '${path}' is reserved or ignored by LiveSync`,
      id: doc._id,
      path,
    };
  }

  const caseInsensitive = !Boolean(options?.handleFilenameCaseSensitive);
  const expectedId = String(
    await path2id_base(path as Parameters<typeof path2id_base>[0], false, caseInsensitive)
  );
  if (expectedId !== doc._id) {
    return {
      ok: false,
      code: 'PATH_ID_MISMATCH',
      message: `path2id for '${path}' is '${expectedId}', not document id '${doc._id}'`,
      id: doc._id,
      path,
    };
  }

  if (type !== EntryTypes.NOTE_LEGACY) {
    return {
      ok: false,
      code: 'UNSUPPORTED_NOTE_SHAPE',
      message: `Tracer decode supports unencrypted '${EntryTypes.NOTE_LEGACY}' documents only (got '${type || 'unknown'}')`,
      id: doc._id,
      path,
    };
  }

  if (typeof doc.data !== 'string') {
    return {
      ok: false,
      code: 'UNSUPPORTED_NOTE_SHAPE',
      message: `Legacy notes document '${doc._id}' is missing an inline string data field`,
      id: doc._id,
      path,
    };
  }

  const bytes = new TextEncoder().encode(doc.data);
  if (typeof doc.size === 'number' && doc.size !== bytes.byteLength) {
    return {
      ok: false,
      code: 'SIZE_MISMATCH',
      message: `Assembled size ${bytes.byteLength} does not match metadata size ${doc.size} for '${path}'`,
      id: doc._id,
      path,
    };
  }

  return {
    ok: true,
    path,
    bytes,
    sourceRevision: doc._rev,
    type,
    deleted: doc.deleted === true || doc._deleted === true,
  };
}
