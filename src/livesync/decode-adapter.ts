// Compatibility adapter targeting @vrtmrz/livesync-commonlib 0.1.21.
// This is the only new Commonlib and octagonal-wheels codec import site
// for Phase 2 pull decode besides src/livesync/syncinfo.ts.
import {
  EntryTypes,
  NoteTypes,
  E2EEAlgorithms,
  PREFIX_CHUNK,
  PREFIX_ENCRYPTED_CHUNK,
  PREFIX_OBFUSCATED,
  FlagFilesOriginal,
  FlagFilesHumanReadable,
} from '@vrtmrz/livesync-commonlib/compat/common/types';
import {
  path2id_base,
  id2path_base,
  shouldBeIgnored,
} from '@vrtmrz/livesync-commonlib/compat/string_and_binary/path';
import { validateStoragePath } from '@vrtmrz/livesync-commonlib/node';
import {
  decrypt as decryptHkdf,
  HKDF_ENCRYPTED_PREFIX,
} from 'octagonal-wheels/encryption/hkdf';
import { decrypt as decryptV1 } from 'octagonal-wheels/encryption';
import { hexStringToUint8Array } from 'octagonal-wheels/binary/hex';
import type { CouchDbDocument } from './inspector.js';

export { EntryTypes, NoteTypes, E2EEAlgorithms, path2id_base, id2path_base };

// Named re-exports from @vrtmrz/livesync-commonlib 0.1.21. Domain path-policy must import only these names.
export { validateStoragePath, shouldBeIgnored, FlagFilesOriginal, FlagFilesHumanReadable };

const ENCRYPTED_META_PREFIX = '/\\:';
const ENCRYPT_OLD_HEADER = '%';

export type DocumentIdClass = 'chunk' | 'obfuscated-note' | 'note';

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

export interface DecodeOptions {
  readonly handleFilenameCaseSensitive?: boolean;
  readonly encryptionPassphrase?: string;
  readonly algorithm?: string;
  readonly useDynamicIterationCount?: boolean;
  readonly usePathObfuscation?: boolean;
  readonly pbkdf2salt?: string;
  readonly fetchChunk?: (id: string) => Promise<CouchDbDocument | null>;
}

export type DecryptDocumentResult =
  | { readonly verified: true; readonly document: CouchDbDocument }
  | { readonly verified: false; readonly error: string };

export type AssembleChunksResult = { readonly ok: true; readonly bytes: Uint8Array } | DecodeFailure;

export function classifyDocumentId(id: string): DocumentIdClass {
  if (id.startsWith(PREFIX_ENCRYPTED_CHUNK) || id.startsWith(PREFIX_CHUNK)) {
    return 'chunk';
  }
  if (id.startsWith(PREFIX_OBFUSCATED)) {
    return 'obfuscated-note';
  }
  return 'note';
}

export function isReservedChunkId(id: string): boolean {
  return classifyDocumentId(id) === 'chunk';
}

export function isObfuscatedNoteId(id: string): boolean {
  return id.startsWith(PREFIX_OBFUSCATED);
}

export function isNoteType(type: string): boolean {
  return (NoteTypes as readonly string[]).includes(type);
}

function isSupportedAlgorithm(algorithm?: string): boolean {
  if (algorithm === undefined) {
    return true;
  }
  return algorithm === E2EEAlgorithms.V1 || algorithm === E2EEAlgorithms.V2;
}

function parseSaltBytes(rawSalt?: string): Uint8Array | undefined {
  if (!rawSalt) {
    return undefined;
  }
  if (/^[0-9a-fA-F]+$/.test(rawSalt) && rawSalt.length % 2 === 0) {
    return hexStringToUint8Array(rawSalt);
  }
  try {
    const buf = Buffer.from(rawSalt, 'base64');
    if (buf.length > 0) {
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
  } catch {
    // Fall back to text encoder
  }
  return new TextEncoder().encode(rawSalt);
}

function looksEncryptedString(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith(HKDF_ENCRYPTED_PREFIX) ||
      value.startsWith(ENCRYPT_OLD_HEADER) ||
      value.startsWith('[') ||
      value.startsWith(ENCRYPTED_META_PREFIX))
  );
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function decryptCiphertext(
  ciphertext: string,
  passphrase: string,
  algorithm: string | undefined,
  useDynamicIterationCount: boolean,
  saltBytes: Uint8Array | undefined
): Promise<string> {
  const preferV2 = algorithm === undefined || algorithm === E2EEAlgorithms.V2;
  if (ciphertext.startsWith(HKDF_ENCRYPTED_PREFIX) || ciphertext.startsWith(ENCRYPTED_META_PREFIX)) {
    if (!saltBytes) {
      throw new Error('Missing PBKDF2 salt in sync parameters document');
    }
    const payload = ciphertext.startsWith(ENCRYPTED_META_PREFIX)
      ? ciphertext.slice(ENCRYPTED_META_PREFIX.length)
      : ciphertext;
    return await decryptHkdf(payload, passphrase, saltBytes as never);
  }

  if (preferV2 && ciphertext.startsWith(ENCRYPT_OLD_HEADER) && saltBytes) {
    try {
      return await decryptHkdf(ciphertext, passphrase, saltBytes as never);
    } catch {
      // V1 records still read on a V2 database (migrationDecrypt).
    }
  }

  try {
    return await decryptV1(ciphertext, passphrase, useDynamicIterationCount);
  } catch (first) {
    if (useDynamicIterationCount) {
      return await decryptV1(ciphertext, passphrase, false);
    }
    throw first;
  }
}

export async function verifyPathIdentity(
  path: string,
  documentId: string,
  options?: {
    obfuscatePassphrase?: string | false;
    handleFilenameCaseSensitive?: boolean;
  }
): Promise<boolean> {
  const caseInsensitive = !Boolean(options?.handleFilenameCaseSensitive);
  const obfuscate = options?.obfuscatePassphrase ?? false;
  const expectedId = String(
    await path2id_base(path as Parameters<typeof path2id_base>[0], obfuscate, caseInsensitive)
  );
  return expectedId === documentId;
}

export async function decryptIncomingDocument(
  doc: CouchDbDocument,
  options?: DecodeOptions
): Promise<DecryptDocumentResult> {
  if (options?.algorithm !== undefined && !isSupportedAlgorithm(options.algorithm)) {
    return {
      verified: false,
      error: `INCOMPATIBLE: unsupported E2EEAlgorithm '${options.algorithm}'`,
    };
  }

  const needsDecrypt =
    doc.e_ === true || looksEncryptedString(doc.path) || looksEncryptedString(doc.data);
  if (!needsDecrypt) {
    return { verified: true, document: doc };
  }

  const passphrase = options?.encryptionPassphrase;
  if (!passphrase) {
    return {
      verified: false,
      error: 'Remote database is encrypted but no passphrase was provided',
    };
  }

  const saltBytes = parseSaltBytes(options?.pbkdf2salt);
  const useDynamic = Boolean(options?.useDynamicIterationCount);

  try {
    const next: CouchDbDocument = { ...doc };

    if (typeof next.path === 'string' && next.path.startsWith(ENCRYPTED_META_PREFIX)) {
      if (!saltBytes) {
        return { verified: false, error: 'Missing PBKDF2 salt in sync parameters document' };
      }
      const encryptedMeta = next.path.slice(ENCRYPTED_META_PREFIX.length);
      const props = JSON.parse(await decryptHkdf(encryptedMeta, passphrase, saltBytes as never));
      if (props && typeof props === 'object') {
        for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
          next[key] = value;
        }
      }
    } else if (typeof next.path === 'string' && looksEncryptedString(next.path)) {
      next.path = await decryptCiphertext(
        next.path,
        passphrase,
        options?.algorithm,
        useDynamic,
        saltBytes
      );
    }

    if (typeof next.data === 'string' && looksEncryptedString(next.data)) {
      next.data = await decryptCiphertext(
        next.data,
        passphrase,
        options?.algorithm,
        useDynamic,
        saltBytes
      );
    }

    return { verified: true, document: next };
  } catch (err) {
    return {
      verified: false,
      error: `Passphrase authentication failed: ${(err as Error).message || 'Decryption failed'}`,
    };
  }
}

export async function assembleChunks(
  children: readonly string[],
  expectedSize: number,
  fetchChunk: (id: string) => Promise<CouchDbDocument | null>,
  options?: DecodeOptions,
  isBinary = false
): Promise<AssembleChunksResult> {
  if ((!children || children.length === 0) && expectedSize > 0) {
    return {
      ok: false,
      code: 'MISSING_CHUNK',
      message: 'Document metadata lists a non-zero size but has no children chunks',
      id: '',
    };
  }

  const parts: Uint8Array[] = [];
  for (const id of children) {
    const chunk = await fetchChunk(id);
    if (!chunk) {
      return {
        ok: false,
        code: 'MISSING_CHUNK',
        message: `Missing child chunk '${id}'`,
        id,
      };
    }

    let leaf = chunk;
    if (chunk.e_ === true || looksEncryptedString(chunk.data)) {
      const decrypted = await decryptIncomingDocument(chunk, options);
      if (!decrypted.verified) {
        return {
          ok: false,
          code: 'DECRYPT_FAILED',
          message: decrypted.error,
          id,
        };
      }
      leaf = decrypted.document;
    }

    if (typeof leaf.data !== 'string') {
      return {
        ok: false,
        code: 'MISSING_CHUNK',
        message: `Chunk '${id}' is missing a string data field`,
        id,
      };
    }
    if (isBinary) {
      parts.push(new Uint8Array(Buffer.from(leaf.data, 'base64')));
    } else {
      parts.push(new TextEncoder().encode(leaf.data));
    }
  }

  const bytes = concatBytes(parts);
  if (bytes.byteLength !== expectedSize) {
    return {
      ok: false,
      code: 'SIZE_MISMATCH',
      message: `Assembled size ${bytes.byteLength} does not match metadata size ${expectedSize}`,
      id: children[0] ?? '',
    };
  }

  return { ok: true, bytes };
}

function failureFromAssemble(result: DecodeFailure, path?: string): DecodeFailure {
  return path === undefined ? result : { ...result, path };
}

export async function decodeNoteLeaf(
  doc: CouchDbDocument,
  options?: DecodeOptions
): Promise<DecodeResult> {
  if (options?.algorithm !== undefined && !isSupportedAlgorithm(options.algorithm)) {
    return {
      ok: false,
      code: 'INCOMPATIBLE',
      message: `Unsupported E2EEAlgorithm '${options.algorithm}'`,
      id: doc._id,
    };
  }

  const decrypted = await decryptIncomingDocument(doc, options);
  if (!decrypted.verified) {
    return {
      ok: false,
      code: decrypted.error.startsWith('INCOMPATIBLE') ? 'INCOMPATIBLE' : 'DECRYPT_FAILED',
      message: decrypted.error,
      id: doc._id,
    };
  }

  const leaf = decrypted.document;
  const type = typeof leaf.type === 'string' ? leaf.type : '';
  const path = typeof leaf.path === 'string' ? leaf.path : undefined;

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

  const obfuscatePassphrase =
    options?.usePathObfuscation && options.encryptionPassphrase
      ? options.encryptionPassphrase
      : false;
  const identityOk = await verifyPathIdentity(path, doc._id, {
    obfuscatePassphrase,
    handleFilenameCaseSensitive: options?.handleFilenameCaseSensitive,
  });
  if (!identityOk) {
    const expectedId = String(
      await path2id_base(path as Parameters<typeof path2id_base>[0], obfuscatePassphrase, !Boolean(options?.handleFilenameCaseSensitive))
    );
    return {
      ok: false,
      code: 'PATH_ID_MISMATCH',
      message: `path2id for '${path}' is '${expectedId}', not document id '${doc._id}'`,
      id: doc._id,
      path,
    };
  }

  const deleted = leaf.deleted === true || leaf._deleted === true;
  if (deleted) {
    return {
      ok: true,
      path,
      bytes: new Uint8Array(),
      sourceRevision: leaf._rev,
      type: type || 'notes',
      deleted: true,
    };
  }

  const children = Array.isArray(leaf.children) ? (leaf.children as string[]) : [];

  if (type === EntryTypes.NOTE_PLAIN || type === EntryTypes.NOTE_BINARY) {
    const expectedSize = typeof leaf.size === 'number' ? leaf.size : 0;
    if (children.length === 0) {
      if (expectedSize > 0) {
        return {
          ok: false,
          code: 'MISSING_CHUNK',
          message: `Empty children when size ${expectedSize} > 0 for '${path}'`,
          id: doc._id,
          path,
        };
      }
      return {
        ok: true,
        path,
        bytes: new Uint8Array(),
        sourceRevision: leaf._rev,
        type,
        deleted,
      };
    }

    if (!options?.fetchChunk) {
      return {
        ok: false,
        code: 'MISSING_CHUNK',
        message: `Document '${doc._id}' requires children chunks but no fetchChunk callback was supplied`,
        id: doc._id,
        path,
      };
    }

    const isBinary = type === EntryTypes.NOTE_BINARY;
    const assembled = await assembleChunks(children, expectedSize, options.fetchChunk, options, isBinary);
    if (!assembled.ok) {
      return failureFromAssemble(assembled, path);
    }
    return {
      ok: true,
      path,
      bytes: assembled.bytes,
      sourceRevision: leaf._rev,
      type,
      deleted,
    };
  }

  if (type !== EntryTypes.NOTE_LEGACY) {
    return {
      ok: false,
      code: 'UNSUPPORTED_NOTE_SHAPE',
      message: `Unsupported note type '${type || 'unknown'}' for '${path}'`,
      id: doc._id,
      path,
    };
  }

  if (children.length > 0) {
    if (!options?.fetchChunk) {
      return {
        ok: false,
        code: 'MISSING_CHUNK',
        message: `Document '${doc._id}' requires children chunks but no fetchChunk callback was supplied`,
        id: doc._id,
        path,
      };
    }
    const assembled = await assembleChunks(
      children,
      typeof leaf.size === 'number' ? leaf.size : 0,
      options.fetchChunk,
      options
    );
    if (!assembled.ok) {
      return failureFromAssemble(assembled, path);
    }
    return {
      ok: true,
      path,
      bytes: assembled.bytes,
      sourceRevision: leaf._rev,
      type,
      deleted,
    };
  }

  if (typeof leaf.data !== 'string') {
    return {
      ok: false,
      code: 'UNSUPPORTED_NOTE_SHAPE',
      message: `Legacy notes document '${doc._id}' is missing an inline string data field`,
      id: doc._id,
      path,
    };
  }

  const bytes = new TextEncoder().encode(leaf.data);
  if (typeof leaf.size === 'number' && leaf.size !== bytes.byteLength) {
    return {
      ok: false,
      code: 'SIZE_MISMATCH',
      message: `Assembled size ${bytes.byteLength} does not match metadata size ${leaf.size} for '${path}'`,
      id: doc._id,
      path,
    };
  }

  return {
    ok: true,
    path,
    bytes,
    sourceRevision: leaf._rev,
    type,
    deleted,
  };
}
