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
    doc: Record<string, unknown>
  ): Promise<{ rev: string }> {
    const pathSegments = docId.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`/${encodeURIComponent(dbName)}/${pathSegments}`, this.getBaseUrl());
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

  async stop(): Promise<void> {
    if (this.container) {
      await this.container.stop();
      this.container = undefined;
    }
  }
}
