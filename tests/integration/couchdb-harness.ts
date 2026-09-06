import { CouchDBContainer, type StartedCouchDBContainer } from '@testcontainers/couchdb';
import {
  VERSIONING_DOCID,
  MILESTONE_DOCID,
  DOCID_SYNC_PARAMETERS,
  SYNCINFO_ID,
} from '../../src/livesync/inspector.js';

export class CouchDbTestHarness {
  private container?: StartedCouchDBContainer;
  private baseUrl?: URL;
  private username = 'admin';
  private password = 'password';

  async start(): Promise<void> {
    const couchContainer = new CouchDBContainer('couchdb:3.5.2.1')
      .withUsername(this.username)
      .withPassword(this.password);

    this.container = await couchContainer.start();
    const parsed = new URL(this.container.getUrl());
    // Strip userinfo from the base URL so credentials are supplied via headers
    this.baseUrl = new URL(`${parsed.protocol}//${parsed.host}`);
    this.username = this.container.getUsername();
    this.password = this.container.getPassword();
  }

  getBaseUrl(): URL {
    if (!this.baseUrl) {
      throw new Error('CouchDB container not started.');
    }
    return new URL(this.baseUrl.href);
  }

  getCredentials(): { username: string; password: string } {
    return {
      username: this.username,
      password: this.password,
    };
  }

  private getAuthHeader(): string {
    return 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
  }

  async createDatabase(name: string): Promise<void> {
    const url = new URL(`/${encodeURIComponent(name)}`, this.getBaseUrl());
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: 'application/json',
      },
    });
    if (!res.ok && res.status !== 412) {
      throw new Error(`Failed to create database '${name}': HTTP ${res.status} ${res.statusText}`);
    }
  }

  async putDocument(
    dbName: string,
    docId: string,
    doc: Record<string, unknown>,
    query?: Record<string, string>
  ): Promise<{ rev: string }> {
    const pathSegments = docId.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`/${encodeURIComponent(dbName)}/${pathSegments}`, this.getBaseUrl());
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(doc),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to put document '${docId}' in '${dbName}': HTTP ${res.status} ${res.statusText}`
      );
    }
    const json = (await res.json()) as { rev: string };
    return { rev: json.rev };
  }

  async seedLiveSyncData(
    dbName: string,
    options?: {
      version?: number;
      locked?: boolean;
      pbkdf2salt?: string;
      hashAlgorithm?: string;
      syncinfo?: string;
      sampleNotes?: Record<string, string>;
      tweakValues?: Record<string, unknown>;
    }
  ): Promise<void> {
    // 1. Versioning doc
    await this.putDocument(dbName, VERSIONING_DOCID, {
      version: options?.version ?? 12,
    });

    // 2. Milestone doc
    await this.putDocument(dbName, MILESTONE_DOCID, {
      locked: options?.locked ?? false,
      tweak_values: {
        PREFERRED: {
          hashAlg: options?.hashAlgorithm ?? 'sha256',
          customChunkSize: 100,
          ...options?.tweakValues,
        },
      },
    });

    // 3. Sync parameters doc
    if (options?.pbkdf2salt || options?.hashAlgorithm) {
      await this.putDocument(dbName, DOCID_SYNC_PARAMETERS, {
        pbkdf2salt: options.pbkdf2salt ?? 'salt-12345',
        hashAlgorithm: options.hashAlgorithm ?? 'sha256',
        customChunkSize: 100,
      });
    }

    // 4. Syncinfo doc
    if (options?.syncinfo) {
      await this.putDocument(dbName, SYNCINFO_ID, {
        data: options.syncinfo,
        type: 'encrypted',
      });
    }

    // 5. Sample notes
    if (options?.sampleNotes) {
      for (const [title, content] of Object.entries(options.sampleNotes)) {
        await this.putDocument(dbName, title, {
          title,
          content,
          mtime: Date.now(),
        });
      }
    }
  }

  async seedLegacyNote(
    dbName: string,
    relativePath: string,
    body: string
  ): Promise<{ id: string; rev: string }> {
    const { path2id_base } = await import(
      '@vrtmrz/livesync-commonlib/compat/string_and_binary/path'
    );
    const id = String(await path2id_base(relativePath, false, true));
    const size = new TextEncoder().encode(body).byteLength;
    const { rev } = await this.putDocument(dbName, id, {
      type: 'notes',
      path: relativePath,
      data: body,
      size,
      deleted: false,
      mtime: Date.now(),
    });
    return { id, rev };
  }

  async seedConflictingLegacyNotes(
    dbName: string,
    relativePath: string,
    winnerBody: string,
    otherBody: string
  ): Promise<{ id: string; winnerRev: string; otherRev: string }> {
    const first = await this.seedLegacyNote(dbName, relativePath, winnerBody);
    const otherRev = '1-conflictleaf';
    await this.putDocument(
      dbName,
      first.id,
      {
        _id: first.id,
        _rev: otherRev,
        type: 'notes',
        path: relativePath,
        data: otherBody,
        size: new TextEncoder().encode(otherBody).byteLength,
        deleted: false,
        mtime: Date.now(),
      },
      { new_edits: 'false' }
    );
    return { id: first.id, winnerRev: first.rev, otherRev };
  }

  async seedChunkedPlainNote(
    dbName: string,
    relativePath: string,
    body: string
  ): Promise<{ id: string; rev: string; byteLength: number; children: string[] }> {
    const { path2id_base } = await import(
      '@vrtmrz/livesync-commonlib/compat/string_and_binary/path'
    );
    const mid = Math.max(1, Math.floor(body.length / 2));
    const parts = [body.slice(0, mid), body.slice(mid)];
    const children: string[] = [];
    for (const [index, part] of parts.entries()) {
      const chunkId = `h:plain-${relativePath.replace(/[^A-Za-z0-9]/g, '')}-${index}`;
      await this.putDocument(dbName, chunkId, {
        type: 'leaf',
        data: part,
      });
      children.push(chunkId);
    }

    const id = String(await path2id_base(relativePath, false, true));
    const byteLength = new TextEncoder().encode(body).byteLength;
    const { rev } = await this.putDocument(dbName, id, {
      type: 'plain',
      path: relativePath,
      children,
      size: byteLength,
      deleted: false,
      mtime: Date.now(),
    });
    return { id, rev, byteLength, children };
  }

  async seedNewnoteBinary(
    dbName: string,
    relativePath: string,
    body: string
  ): Promise<{ id: string; rev: string; byteLength: number; children: string[] }> {
    const { path2id_base } = await import(
      '@vrtmrz/livesync-commonlib/compat/string_and_binary/path'
    );
    const mid = Math.max(1, Math.floor(body.length / 2));
    const parts = [body.slice(0, mid), body.slice(mid)];
    const children: string[] = [];
    for (const [index, part] of parts.entries()) {
      const chunkId = `h:newnote-${relativePath.replace(/[^A-Za-z0-9]/g, '')}-${index}`;
      await this.putDocument(dbName, chunkId, {
        type: 'leaf',
        data: part,
      });
      children.push(chunkId);
    }

    const id = String(await path2id_base(relativePath, false, true));
    const byteLength = new TextEncoder().encode(body).byteLength;
    const { rev } = await this.putDocument(dbName, id, {
      type: 'newnote',
      path: relativePath,
      children,
      size: byteLength,
      deleted: false,
      mtime: Date.now(),
    });
    return { id, rev, byteLength, children };
  }

  async seedEncryptedV2Note(
    dbName: string,
    relativePath: string,
    body: string,
    passphrase: string,
    saltHex: string
  ): Promise<{ id: string; rev: string; byteLength: number }> {
    const { path2id_base } = await import(
      '@vrtmrz/livesync-commonlib/compat/string_and_binary/path'
    );
    const { encrypt: encryptHkdf } = await import('octagonal-wheels/encryption/hkdf');
    const { hexStringToUint8Array } = await import('octagonal-wheels/binary/hex');

    const saltBytes = hexStringToUint8Array(saltHex);
    const byteLength = new TextEncoder().encode(body).byteLength;
    const meta = JSON.stringify({
      path: relativePath,
      mtime: Date.now(),
      ctime: Date.now(),
      size: byteLength,
    });
    const encryptedPath = `/\\:${await encryptHkdf(meta, passphrase, saltBytes)}`;
    const encryptedData = await encryptHkdf(body, passphrase, saltBytes);
    const id = String(await path2id_base(relativePath, false, true));
    const { rev } = await this.putDocument(dbName, id, {
      type: 'notes',
      path: encryptedPath,
      data: encryptedData,
      e_: true,
      size: 0,
      deleted: false,
    });
    return { id, rev, byteLength };
  }

  async seedObfuscatedNote(
    dbName: string,
    relativePath: string,
    body: string,
    passphrase: string,
    saltHex: string
  ): Promise<{ id: string; rev: string; byteLength: number }> {
    const { path2id_base } = await import(
      '@vrtmrz/livesync-commonlib/compat/string_and_binary/path'
    );
    const { encrypt: encryptHkdf } = await import('octagonal-wheels/encryption/hkdf');
    const { hexStringToUint8Array } = await import('octagonal-wheels/binary/hex');

    const saltBytes = hexStringToUint8Array(saltHex);
    const byteLength = new TextEncoder().encode(body).byteLength;
    const meta = JSON.stringify({
      path: relativePath,
      mtime: Date.now(),
      ctime: Date.now(),
      size: byteLength,
    });
    const encryptedPath = `/\\:${await encryptHkdf(meta, passphrase, saltBytes)}`;
    const encryptedData = await encryptHkdf(body, passphrase, saltBytes);
    const id = String(await path2id_base(relativePath, passphrase, true));
    const { rev } = await this.putDocument(dbName, id, {
      type: 'notes',
      path: encryptedPath,
      data: encryptedData,
      e_: true,
      size: 0,
      deleted: false,
    });
    return { id, rev, byteLength };
  }

  async seedDeletedNote(
    dbName: string,
    relativePath: string,
    options?: {
      passphrase?: string;
    }
  ): Promise<{ id: string; rev: string }> {
    const { path2id_base } = await import(
      '@vrtmrz/livesync-commonlib/compat/string_and_binary/path'
    );
    const id = String(await path2id_base(relativePath, options?.passphrase ?? false, true));

    let existingRev: string | undefined;
    try {
      const url = new URL(
        `/${encodeURIComponent(dbName)}/${encodeURIComponent(id)}`,
        this.getBaseUrl()
      );
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: this.getAuthHeader(),
          Accept: 'application/json',
        },
      });
      if (res.ok) {
        const json = (await res.json()) as { _rev?: string };
        existingRev = json._rev;
      }
    } catch {
      // Ignore
    }

    const { rev } = await this.putDocument(dbName, id, {
      ...(existingRev ? { _rev: existingRev } : {}),
      type: 'notes',
      path: relativePath,
      deleted: true,
      mtime: Date.now(),
    });
    return { id, rev };
  }

  async stop(): Promise<void> {
    if (this.container) {
      await this.container.stop();
      this.container = undefined;
    }
  }
}
