import {
  decrypt as decryptHkdf,
  HKDF_ENCRYPTED_PREFIX,
} from 'octagonal-wheels/encryption/hkdf';
import { decrypt as decryptV2 } from 'octagonal-wheels/encryption';
import { hexStringToUint8Array } from 'octagonal-wheels/binary/hex';
import type { CouchDbDocument } from './inspector.js';

export interface SyncinfoVerificationResult {
  readonly verified: boolean;
  readonly error?: string;
  readonly decryptedData?: string;
}

export async function verifySyncinfo(
  syncinfoDoc: CouchDbDocument | null,
  syncParamsDoc: CouchDbDocument | null,
  passphrase?: string
): Promise<SyncinfoVerificationResult> {
  // If syncinfoDoc is null or lacks data, return { verified: true } (unencrypted database)
  if (!syncinfoDoc || !syncinfoDoc.data || typeof syncinfoDoc.data !== 'string') {
    return { verified: true };
  }

  const rawData = syncinfoDoc.data;

  // Check if data is encrypted (starts with % or [)
  const isEncrypted = rawData.startsWith('%') || rawData.startsWith('[');
  if (!isEncrypted) {
    return { verified: true, decryptedData: rawData };
  }

  if (!passphrase) {
    return {
      verified: false,
      error: 'Remote database is encrypted but no passphrase was provided',
    };
  }

  try {
    let decrypted: string;

    if (rawData.startsWith(HKDF_ENCRYPTED_PREFIX)) {
      const rawSalt = syncParamsDoc?.pbkdf2salt;
      if (!rawSalt || typeof rawSalt !== 'string') {
        return {
          verified: false,
          error: 'Missing PBKDF2 salt in sync parameters document',
        };
      }

      let saltBytes: Uint8Array;
      if (/^[0-9a-fA-F]+$/.test(rawSalt) && rawSalt.length % 2 === 0) {
        saltBytes = hexStringToUint8Array(rawSalt);
      } else {
        saltBytes = new TextEncoder().encode(rawSalt);
      }

      decrypted = await decryptHkdf(rawData, passphrase, saltBytes);
    } else {
      // Legacy V2/V3 encryption
      decrypted = await decryptV2(rawData, passphrase);
    }

    return { verified: true, decryptedData: decrypted };
  } catch (err) {
    return {
      verified: false,
      error: `Passphrase authentication failed: ${(err as Error).message || 'Decryption failed'}`,
    };
  }
}
