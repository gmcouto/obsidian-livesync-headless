import {
  PREFIX_CHUNK,
  PREFIX_ENCRYPTED_CHUNK,
  E2EEAlgorithms,
} from '@vrtmrz/livesync-commonlib/compat/common/types';
import { path2id_base } from '@vrtmrz/livesync-commonlib/compat/string_and_binary/path';
import { splitPieces2V2, collectGenAll } from '@vrtmrz/livesync-commonlib/compat/string_and_binary/chunks';
import { digestHash } from '@vrtmrz/livesync-commonlib/compat/string_and_binary/hash';
import { encrypt as encryptHkdf } from 'octagonal-wheels/encryption/hkdf';
import { encrypt as encryptV1 } from 'octagonal-wheels/encryption';
import { hexStringToUint8Array } from 'octagonal-wheels/binary/hex';
import type { WriteCapability, ArmedSyncCapability } from '../security/capabilities.js';
import { isWriteCapability, isArmedSyncCapability } from '../security/capabilities.js';
import { createArmedGuardedFetch } from '../security/transport-guard.js';

export interface PushAdapterOptions {
  readonly baseUrl: URL;
  readonly databaseName: string;
  readonly chunkSize?: number;
  readonly minimumChunkSize?: number;
  readonly encryptionPassphrase?: string;
  readonly algorithm?: string;
  readonly useDynamicIterationCount?: boolean;
  readonly usePathObfuscation?: boolean;
  readonly pbkdf2salt?: string;
  readonly handleFilenameCaseSensitive?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface PushFileParams {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly baseRev?: string | null;
  readonly mtime?: number;
  readonly ctime?: number;
}

export interface PushResult {
  readonly ok: boolean;
  readonly path: string;
  readonly docId: string;
  readonly rev?: string;
  readonly error?: string;
  readonly conflict?: boolean;
  readonly chunksUploaded: number;
  readonly chunksExisting: number;
}

function parseSaltBytes(rawSalt?: string): Uint8Array | undefined {
  if (!rawSalt) {
    return undefined;
  }
  if (/^[0-9a-fA-F]+$/.test(rawSalt) && rawSalt.length % 2 === 0) {
    return hexStringToUint8Array(rawSalt);
  }
  return new TextEncoder().encode(rawSalt);
}

export class PushAdapter {
  private readonly guardedFetch: typeof globalThis.fetch;

  constructor(private readonly options: PushAdapterOptions) {
    this.guardedFetch = createArmedGuardedFetch(
      {
        allowedBaseUrl: options.baseUrl,
        databaseName: options.databaseName,
      },
      options.fetch ?? globalThis.fetch
    );
  }

  async pushFile(
    params: PushFileParams,
    capability: WriteCapability | ArmedSyncCapability
  ): Promise<PushResult> {
    if (!isWriteCapability(capability) && !isArmedSyncCapability(capability)) {
      throw new Error('PushAdapter requires an active WriteCapability or ArmedSyncCapability token.');
    }

    const chunkSize = this.options.chunkSize ?? 50000;
    const minimumChunkSize = this.options.minimumChunkSize ?? 20;
    const passphrase = this.options.encryptionPassphrase;
    const isEncrypted = Boolean(passphrase);
    const preferV2 = this.options.algorithm === undefined || this.options.algorithm === E2EEAlgorithms.V2;
    const saltBytes = parseSaltBytes(this.options.pbkdf2salt);
    const useDynamic = Boolean(this.options.useDynamicIterationCount);

    if (isEncrypted && preferV2 && !saltBytes) {
      throw new Error('PushAdapter: PBKDF2 salt is required for V2 E2EE encryption.');
    }

    const obfuscate =
      this.options.usePathObfuscation && passphrase ? passphrase : false;
    const caseInsensitive = !Boolean(this.options.handleFilenameCaseSensitive);
    const docId = String(await path2id_base(params.path as Parameters<typeof path2id_base>[0], obfuscate, caseInsensitive));

    // 1. Chunk splitting
    const contentStr = new TextDecoder('utf-8', { fatal: false }).decode(params.bytes);
    let pieces: string[] = [];
    if (params.bytes.byteLength > 0) {
      const blob = new Blob([contentStr], { type: 'text/plain' });
      const genFn = await splitPieces2V2(blob, chunkSize, false, minimumChunkSize, params.path);
      pieces = await collectGenAll(genFn());
    }

    // 2. Prepare chunk documents and IDs
    interface PreparedChunk {
      id: string;
      doc: {
        _id: string;
        data: string;
        type: string;
        e_?: boolean;
      };
    }

    const preparedChunks: PreparedChunk[] = [];
    for (const piece of pieces) {
      let dataToStore = piece;
      let isChunkEncrypted = false;

      if (isEncrypted && passphrase) {
        if (preferV2 && saltBytes) {
          dataToStore = await encryptHkdf(piece, passphrase, saltBytes as never);
        } else {
          dataToStore = await encryptV1(piece, passphrase, useDynamic);
        }
        isChunkEncrypted = true;
      }

      const hash = await digestHash(dataToStore);
      const chunkId = isChunkEncrypted ? `${PREFIX_ENCRYPTED_CHUNK}${hash}` : `${PREFIX_CHUNK}${hash}`;

      preparedChunks.push({
        id: chunkId,
        doc: {
          _id: chunkId,
          data: dataToStore,
          type: 'leaf',
          ...(isChunkEncrypted ? { e_: true } : {}),
        },
      });
    }

    // 3. Strict Chunk-First Upload (SYNC-03)
    let chunksUploaded = 0;
    let chunksExisting = 0;
    const dbUrl = new URL(this.options.databaseName, this.options.baseUrl).href.replace(/\/$/, '');

    for (const chunk of preparedChunks) {
      const chunkUrl = `${dbUrl}/${encodeURIComponent(chunk.id)}`;
      
      // Check if chunk already exists
      const headRes = await this.guardedFetch(chunkUrl, { method: 'HEAD' });
      if (headRes.status === 200) {
        chunksExisting++;
        continue;
      }

      // Upload missing chunk
      const putRes = await this.guardedFetch(chunkUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.doc),
      });

      if (putRes.status !== 200 && putRes.status !== 201) {
        const errText = await putRes.text();
        return {
          ok: false,
          path: params.path,
          docId,
          error: `Chunk write failed for '${chunk.id}' with status ${putRes.status}: ${errText}`,
          chunksUploaded,
          chunksExisting,
        };
      }

      chunksUploaded++;
    }

    // 4. Note Metadata Document Upload (SYNC-02)
    let pathInDoc = params.path;
    if (obfuscate && passphrase) {
      if (preferV2 && saltBytes) {
        pathInDoc = await encryptHkdf(params.path, passphrase, saltBytes as never);
      } else {
        pathInDoc = await encryptV1(params.path, passphrase, useDynamic);
      }
    }

    const noteDoc: Record<string, unknown> = {
      _id: docId,
      path: pathInDoc,
      type: 'plain',
      size: params.bytes.byteLength,
      ctime: params.ctime ?? Date.now(),
      mtime: params.mtime ?? Date.now(),
      children: preparedChunks.map((c) => c.id),
      deleted: false,
    };

    if (params.baseRev) {
      noteDoc._rev = params.baseRev;
    }

    const noteUrl = `${dbUrl}/${encodeURIComponent(docId)}`;
    const noteRes = await this.guardedFetch(noteUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteDoc),
    });

    if (noteRes.status === 409) {
      return {
        ok: false,
        conflict: true,
        path: params.path,
        docId,
        error: `Conflict (409) updating document '${docId}' extending base revision '${params.baseRev ?? 'none'}'`,
        chunksUploaded,
        chunksExisting,
      };
    }

    if (noteRes.status !== 200 && noteRes.status !== 201) {
      const errText = await noteRes.text();
      return {
        ok: false,
        path: params.path,
        docId,
        error: `Note document write failed with status ${noteRes.status}: ${errText}`,
        chunksUploaded,
        chunksExisting,
      };
    }

    const resJson = (await noteRes.json()) as { ok?: boolean; id?: string; rev?: string };
    return {
      ok: true,
      path: params.path,
      docId,
      rev: resJson.rev,
      chunksUploaded,
      chunksExisting,
    };
  }
}
