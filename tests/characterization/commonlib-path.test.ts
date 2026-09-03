import { describe, it, expect } from 'vitest';
import {
  path2id_base,
  id2path_base,
} from '@vrtmrz/livesync-commonlib/compat/string_and_binary/path';
import {
  decodeNoteLeaf,
  verifyPathIdentity,
  classifyDocumentId,
  validateStoragePath,
  shouldBeIgnored,
} from '../../src/livesync/decode-adapter.js';

describe('Commonlib path identity characterization (0.1.21)', () => {
  it("path2id_base('Welcome.md', false, false) equals Welcome.md", async () => {
    const id = String(await path2id_base('Welcome.md' as never, false, false));
    expect(id).toBe('Welcome.md');
    expect(String(id2path_base(id as never))).toBe('Welcome.md');
  });

  it('maps a leading underscore filename with a slash prefix', async () => {
    const id = String(await path2id_base('_hidden.md' as never, false, false));
    expect(id).toBe('/_hidden.md');
  });

  it('yields an f: document id when obfuscatePassphrase is set', async () => {
    const passphrase = 'shared-e2ee-and-obfuscation';
    const id = String(await path2id_base('Welcome.md' as never, passphrase, false));
    expect(id.startsWith('f:')).toBe(true);

    const matches = await verifyPathIdentity('Welcome.md', id, {
      obfuscatePassphrase: passphrase,
      handleFilenameCaseSensitive: true,
    });
    expect(matches).toBe(true);
  });

  it('decodes an obfuscated leaf using the document path, never the f: id as a vault name', async () => {
    const passphrase = 'shared-e2ee-and-obfuscation';
    const vaultPath = 'Notes/Welcome.md';
    const id = String(await path2id_base(vaultPath as never, passphrase, false));
    const body = '# recovered from path field\n';

    const decoded = await decodeNoteLeaf(
      {
        _id: id,
        _rev: '1-obf',
        type: 'notes',
        path: vaultPath,
        data: body,
        size: new TextEncoder().encode(body).byteLength,
      },
      {
        handleFilenameCaseSensitive: true,
        usePathObfuscation: true,
        encryptionPassphrase: passphrase,
      }
    );

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.path).toBe(vaultPath);
      expect(decoded.path.startsWith('f:')).toBe(false);
      expect(new TextDecoder().decode(decoded.bytes)).toBe(body);
    }
  });

  it('re-exports validateStoragePath and shouldBeIgnored wrappers', () => {
    expect(() => validateStoragePath('../escape.md')).toThrow();
    expect(shouldBeIgnored('redflag.md')).toBe(true);
  });

  it('classifies reserved chunk prefixes and leaves f: as a note id', () => {
    expect(classifyDocumentId('h:abc')).toBe('chunk');
    expect(classifyDocumentId('h:+abc')).toBe('chunk');
    expect(classifyDocumentId('f:deadbeef')).not.toBe('chunk');
  });
});
