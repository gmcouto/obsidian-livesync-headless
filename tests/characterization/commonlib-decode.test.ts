import { describe, it, expect } from 'vitest';
import {
  encrypt as encryptHkdf,
  createPBKDF2Salt,
} from 'octagonal-wheels/encryption/hkdf';
import { encrypt as encryptV1 } from 'octagonal-wheels/encryption';
import { uint8ArrayToHexString } from 'octagonal-wheels/binary/hex';
import { E2EEAlgorithms } from '@vrtmrz/livesync-commonlib/compat/common/types';
import {
  decodeNoteLeaf,
  decryptIncomingDocument,
  assembleChunks,
} from '../../src/livesync/decode-adapter.js';
import type { CouchDbDocument } from '../../src/livesync/inspector.js';

const ENCRYPTED_META_PREFIX = '/\\:';

describe('Commonlib decode characterization (0.1.21)', () => {
  const passphrase = 'correct-e2ee-passphrase';
  const saltBytes = createPBKDF2Salt();
  const saltHex = uint8ArrayToHexString(saltBytes);

  async function encryptV2Meta(fields: {
    path: string;
    mtime?: number;
    ctime?: number;
    size: number;
    children?: string[];
  }): Promise<string> {
    const payload = JSON.stringify({
      path: fields.path,
      mtime: fields.mtime ?? 1,
      ctime: fields.ctime ?? 1,
      size: fields.size,
      children: fields.children,
    });
    return ENCRYPTED_META_PREFIX + (await encryptHkdf(payload, passphrase, saltBytes));
  }

  it('decrypts V2 HKDF ciphertext produced with the admission salt', async () => {
    const original = 'plain-note-body';
    const size = new TextEncoder().encode(original).byteLength;
    const encryptedPath = await encryptV2Meta({ path: 'Welcome.md', size });
    const encryptedData = await encryptHkdf(original, passphrase, saltBytes);

    const result = await decryptIncomingDocument(
      {
        _id: 'Welcome.md',
        _rev: '1-v2',
        type: 'notes',
        path: encryptedPath,
        data: encryptedData,
        e_: true,
        size: 0,
      },
      {
        encryptionPassphrase: passphrase,
        algorithm: E2EEAlgorithms.V2,
        pbkdf2salt: saltHex,
      }
    );

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.document.path).toBe('Welcome.md');
      expect(result.document.data).toBe(original);
    }
  });

  it('decrypts empty-string V1 ciphertext to the original payload', async () => {
    const original = 'legacy-v1-body';
    const encryptedPath = await encryptV1('Welcome.md', passphrase, false);
    const encryptedData = await encryptV1(original, passphrase, false);

    const result = await decryptIncomingDocument(
      {
        _id: 'Welcome.md',
        _rev: '1-v1',
        type: 'notes',
        path: encryptedPath,
        data: encryptedData,
        e_: true,
      },
      {
        encryptionPassphrase: passphrase,
        algorithm: E2EEAlgorithms.V1,
        pbkdf2salt: saltHex,
      }
    );

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.document.path).toBe('Welcome.md');
      expect(result.document.data).toBe(original);
    }
  });

  it('fails closed with a Passphrase authentication error on the wrong passphrase', async () => {
    const original = 'secret-body';
    const encryptedData = await encryptHkdf(original, passphrase, saltBytes);
    const encryptedPath = await encryptV2Meta({
      path: 'Welcome.md',
      size: new TextEncoder().encode(original).byteLength,
    });

    const result = await decryptIncomingDocument(
      {
        _id: 'Welcome.md',
        _rev: '1-bad',
        type: 'notes',
        path: encryptedPath,
        data: encryptedData,
        e_: true,
      },
      {
        encryptionPassphrase: 'wrong-passphrase',
        algorithm: E2EEAlgorithms.V2,
        pbkdf2salt: saltHex,
      }
    );

    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.error).toContain('Passphrase');
    }

    const decoded = await decodeNoteLeaf(
      {
        _id: 'Welcome.md',
        _rev: '1-bad',
        type: 'notes',
        path: encryptedPath,
        data: encryptedData,
        e_: true,
      },
      {
        encryptionPassphrase: 'wrong-passphrase',
        algorithm: E2EEAlgorithms.V2,
        pbkdf2salt: saltHex,
      }
    );
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.message).toContain('Passphrase');
    }
  });

  it("treats unknown algorithm string 'v9' as INCOMPATIBLE without attempting decrypt", async () => {
    const decoded = await decodeNoteLeaf(
      {
        _id: 'Welcome.md',
        _rev: '1-v9',
        type: 'notes',
        path: 'Welcome.md',
        data: 'should-not-be-read',
      },
      {
        encryptionPassphrase: passphrase,
        algorithm: 'v9',
        pbkdf2salt: saltHex,
      }
    );

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.code).toBe('INCOMPATIBLE');
    }
  });

  it('assembles children in order and fails closed on a missing chunk', async () => {
    const chunkA: CouchDbDocument = {
      _id: 'h:chunk-a',
      _rev: '1-a',
      type: 'leaf',
      data: 'Hello ',
    };
    const chunks = new Map<string, CouchDbDocument>([['h:chunk-a', chunkA]]);

    const missing = await assembleChunks(['h:chunk-a', 'h:chunk-missing'], 11, async (id) => {
      return chunks.get(id) ?? null;
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toMatch(/CHUNK|MISSING/i);
    }
  });

  it('fails assembleChunks when concatenated byteLength does not match metadata size', async () => {
    const chunkA: CouchDbDocument = {
      _id: 'h:chunk-a',
      _rev: '1-a',
      type: 'leaf',
      data: 'Hello ',
    };
    const chunkB: CouchDbDocument = {
      _id: 'h:chunk-b',
      _rev: '1-b',
      type: 'leaf',
      data: 'world',
    };
    const chunks = new Map<string, CouchDbDocument>([
      ['h:chunk-a', chunkA],
      ['h:chunk-b', chunkB],
    ]);

    const mismatch = await assembleChunks(['h:chunk-a', 'h:chunk-b'], 999, async (id) => {
      return chunks.get(id) ?? null;
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.code).toBe('SIZE_MISMATCH');
    }

    const ok = await assembleChunks(['h:chunk-a', 'h:chunk-b'], 11, async (id) => {
      return chunks.get(id) ?? null;
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(new TextDecoder().decode(ok.bytes)).toBe('Hello world');
      expect(ok.bytes.byteLength).toBe(11);
    }
  });

  it('decodes a chunked plain document through decodeNoteLeaf', async () => {
    const body = 'Hello world';
    const decoded = await decodeNoteLeaf(
      {
        _id: 'Chunked.md',
        _rev: '1-plain',
        type: 'plain',
        path: 'Chunked.md',
        children: ['h:chunk-a', 'h:chunk-b'],
        size: body.length,
      },
      {
        handleFilenameCaseSensitive: true,
        fetchChunk: async (id) => {
          if (id === 'h:chunk-a') {
            return { _id: id, _rev: '1-a', type: 'leaf', data: 'Hello ' };
          }
          if (id === 'h:chunk-b') {
            return { _id: id, _rev: '1-b', type: 'leaf', data: 'world' };
          }
          return null;
        },
      }
    );

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.type).toBe('plain');
      expect(new TextDecoder().decode(decoded.bytes)).toBe(body);
    }
  });
});
