import { describe, it, expect } from 'vitest';
import {
  encrypt as encryptHkdf,
  createPBKDF2Salt,
} from 'octagonal-wheels/encryption/hkdf';
import { uint8ArrayToHexString } from 'octagonal-wheels/binary/hex';
import { verifySyncinfo } from '../../src/livesync/syncinfo.js';

describe('Commonlib Crypto & Syncinfo Verification Characterization', () => {
  const passphrase = 'correct-e2ee-passphrase';
  const saltBytes = createPBKDF2Salt();
  const saltHex = uint8ArrayToHexString(saltBytes);

  it('verifies unencrypted databases without requiring a passphrase', async () => {
    // Missing syncinfo doc
    const res1 = await verifySyncinfo(null, null);
    expect(res1.verified).toBe(true);

    // Syncinfo doc with non-encrypted string
    const res2 = await verifySyncinfo(
      { _id: 'syncinfo', _rev: '1-a', data: 'plain-unencrypted-string' },
      null
    );
    expect(res2.verified).toBe(true);
    expect(res2.decryptedData).toBe('plain-unencrypted-string');
  });

  it('authenticates valid passphrase against HKDF-encrypted syncinfo', async () => {
    const originalPayload = JSON.stringify({ vault: 'my-vault', device: 'test-device' });
    const encryptedData = await encryptHkdf(originalPayload, passphrase, saltBytes);

    const syncinfoDoc = {
      _id: 'syncinfo',
      _rev: '1-enc',
      data: encryptedData,
    };
    const syncParamsDoc = {
      _id: '_local/obsidian_livesync_sync_parameters',
      _rev: '1-p',
      pbkdf2salt: saltHex,
    };

    const res = await verifySyncinfo(syncinfoDoc, syncParamsDoc, passphrase);
    expect(res.verified).toBe(true);
    expect(res.decryptedData).toBe(originalPayload);
  });

  it('fails closed when an incorrect passphrase is supplied', async () => {
    const originalPayload = JSON.stringify({ secret: 12345 });
    const encryptedData = await encryptHkdf(originalPayload, passphrase, saltBytes);

    const syncinfoDoc = {
      _id: 'syncinfo',
      _rev: '1-enc',
      data: encryptedData,
    };
    const syncParamsDoc = {
      _id: '_local/obsidian_livesync_sync_parameters',
      _rev: '1-p',
      pbkdf2salt: saltHex,
    };

    const res = await verifySyncinfo(syncinfoDoc, syncParamsDoc, 'wrong-passphrase');
    expect(res.verified).toBe(false);
    expect(res.error).toContain('Passphrase authentication failed');
  });

  it('fails closed when remote is encrypted but no passphrase was supplied', async () => {
    const encryptedData = await encryptHkdf('payload', passphrase, saltBytes);

    const syncinfoDoc = {
      _id: 'syncinfo',
      _rev: '1-enc',
      data: encryptedData,
    };
    const syncParamsDoc = {
      _id: '_local/obsidian_livesync_sync_parameters',
      _rev: '1-p',
      pbkdf2salt: saltHex,
    };

    const res = await verifySyncinfo(syncinfoDoc, syncParamsDoc, undefined);
    expect(res.verified).toBe(false);
    expect(res.error).toContain('Remote database is encrypted but no passphrase was provided');
  });

  it('fails closed when sync parameters lack PBKDF2 salt', async () => {
    const encryptedData = await encryptHkdf('payload', passphrase, saltBytes);

    const syncinfoDoc = {
      _id: 'syncinfo',
      _rev: '1-enc',
      data: encryptedData,
    };

    const res = await verifySyncinfo(syncinfoDoc, null, passphrase);
    expect(res.verified).toBe(false);
    expect(res.error).toContain('Missing PBKDF2 salt');
  });
});
