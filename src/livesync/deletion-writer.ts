import { E2EEAlgorithms } from '@vrtmrz/livesync-commonlib/compat/common/types';
import { path2id_base } from '@vrtmrz/livesync-commonlib/compat/string_and_binary/path';
import { encrypt as encryptHkdf } from 'octagonal-wheels/encryption/hkdf';
import { encrypt as encryptV1 } from 'octagonal-wheels/encryption';
import { hexStringToUint8Array } from 'octagonal-wheels/binary/hex';
import type { WriteCapability, ArmedSyncCapability } from '../security/capabilities.js';
import { isWriteCapability, isArmedSyncCapability } from '../security/capabilities.js';
import { createArmedGuardedFetch } from '../security/transport-guard.js';

export interface DeletionWriterOptions {
  readonly baseUrl: URL;
  readonly databaseName: string;
  readonly encryptionPassphrase?: string;
  readonly algorithm?: string;
  readonly useDynamicIterationCount?: boolean;
  readonly usePathObfuscation?: boolean;
  readonly pbkdf2salt?: string;
  readonly handleFilenameCaseSensitive?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface DeletionResult {
  readonly ok: boolean;
  readonly path: string;
  readonly docId: string;
  readonly rev?: string;
  readonly error?: string;
  readonly conflict?: boolean;
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

export class DeletionWriter {
  private readonly guardedFetch: typeof globalThis.fetch;

  constructor(private readonly options: DeletionWriterOptions) {
    this.guardedFetch = createArmedGuardedFetch(
      {
        allowedBaseUrl: options.baseUrl,
        databaseName: options.databaseName,
      },
      options.fetch ?? globalThis.fetch
    );
  }

  async writeDeletion(
    path: string,
    baseRev: string,
    capability: WriteCapability | ArmedSyncCapability
  ): Promise<DeletionResult> {
    if (!isWriteCapability(capability) && !isArmedSyncCapability(capability)) {
      throw new Error('DeletionWriter requires an active WriteCapability or ArmedSyncCapability token.');
    }

    const passphrase = this.options.encryptionPassphrase;
    const preferV2 = this.options.algorithm === undefined || this.options.algorithm === E2EEAlgorithms.V2;
    const saltBytes = parseSaltBytes(this.options.pbkdf2salt);
    const useDynamic = Boolean(this.options.useDynamicIterationCount);

    const obfuscate =
      this.options.usePathObfuscation && passphrase ? passphrase : false;
    const caseInsensitive = !Boolean(this.options.handleFilenameCaseSensitive);
    const docId = String(await path2id_base(path as Parameters<typeof path2id_base>[0], obfuscate, caseInsensitive));

    let pathInDoc = path;
    if (obfuscate && passphrase) {
      if (preferV2 && saltBytes) {
        pathInDoc = await encryptHkdf(path, passphrase, saltBytes as never);
      } else {
        pathInDoc = await encryptV1(path, passphrase, useDynamic);
      }
    }

    // LiveSync logical deletion document extending baseRev (SYNC-04)
    // NEVER issues CouchDB HTTP DELETE
    const deletionDoc: Record<string, unknown> = {
      _id: docId,
      _rev: baseRev,
      path: pathInDoc,
      type: 'notes',
      deleted: true,
      mtime: Date.now(),
      ctime: Date.now(),
      size: 0,
      children: [],
    };

    const dbUrl = new URL(this.options.databaseName, this.options.baseUrl).href.replace(/\/$/, '');
    const docUrl = `${dbUrl}/${encodeURIComponent(docId)}`;

    const res = await this.guardedFetch(docUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deletionDoc),
    });

    if (res.status === 409) {
      return {
        ok: false,
        conflict: true,
        path,
        docId,
        error: `Conflict (409) writing logical deletion for '${docId}' extending revision '${baseRev}'`,
      };
    }

    if (res.status !== 200 && res.status !== 201) {
      const errText = await res.text();
      return {
        ok: false,
        path,
        docId,
        error: `Logical deletion PUT failed with status ${res.status}: ${errText}`,
      };
    }

    const resJson = (await res.json()) as { ok?: boolean; id?: string; rev?: string };
    return {
      ok: true,
      path,
      docId,
      rev: resJson.rev,
    };
  }
}
