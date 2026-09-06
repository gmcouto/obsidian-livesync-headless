import { describe, it, expect, vi } from 'vitest';
import { PushAdapter } from '../../src/livesync/push-adapter.js';
import { decodeNoteLeaf } from '../../src/livesync/decode-adapter.js';
import { createWriteCapability } from '../../src/security/capabilities.js';
import type { CouchDbDocument } from '../../src/livesync/inspector.js';

describe('PushAdapter', () => {
  const baseUrl = new URL('http://couchdb.local:5984');
  const databaseName = 'vaultdb';
  const capability = createWriteCapability(
    baseUrl,
    databaseName,
    'grant-123',
    'remote-fp-123',
    '/home/vault'
  );

  it('splits, uploads chunks first, and then writes the note document for plain text', async () => {
    const remoteStore = new Map<string, CouchDbDocument>();
    const requestOrder: string[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(urlStr);
      const docId = decodeURIComponent(url.pathname.split('/').pop() || '');
      const method = (init?.method || 'GET').toUpperCase();

      requestOrder.push(`${method} ${docId}`);

      if (method === 'HEAD') {
        if (remoteStore.has(docId)) {
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      }

      if (method === 'PUT') {
        const body = JSON.parse(init?.body as string);
        remoteStore.set(docId, body);
        return new Response(JSON.stringify({ ok: true, id: docId, rev: '1-rev123' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(null, { status: 405 });
    });

    const adapter = new PushAdapter({
      baseUrl,
      databaseName,
      chunkSize: 25,
      minimumChunkSize: 10,
      fetch: mockFetch as typeof globalThis.fetch,
    });

    const content = 'This is line 1 of the file.\nThis is line 2 of the file.\n';
    const bytes = new TextEncoder().encode(content);

    const result = await adapter.pushFile(
      {
        path: 'Folder/Doc.md',
        bytes,
        mtime: 1700000000000,
        ctime: 1690000000000,
      },
      capability
    );

    expect(result.ok).toBe(true);
    expect(result.path).toBe('Folder/Doc.md');
    expect(result.rev).toBe('1-rev123');
    expect(result.chunksUploaded).toBeGreaterThan(0);

    // Verify chunk-first sequencing: all chunk PUTs must precede the note PUT
    const noteDocId = result.docId;
    const notePutIndex = requestOrder.indexOf(`PUT ${noteDocId}`);
    expect(notePutIndex).toBeGreaterThan(0);

    const chunkPuts = requestOrder
      .slice(0, notePutIndex)
      .filter((req) => req.startsWith('PUT h:'));
    expect(chunkPuts.length).toBe(result.chunksUploaded);

    // Verify round-trip decoding via Phase 2 decodeNoteLeaf
    const noteDoc = remoteStore.get(noteDocId)!;
    const decodeRes = await decodeNoteLeaf(noteDoc, {
      fetchChunk: async (id) => remoteStore.get(id) ?? null,
    });

    expect(decodeRes.ok).toBe(true);
    if (decodeRes.ok) {
      expect(decodeRes.path).toBe('Folder/Doc.md');
      expect(new TextDecoder().decode(decodeRes.bytes)).toBe(content);
      expect(decodeRes.deleted).toBe(false);
    }
  });

  it('aborts note document upload if any chunk write fails (SYNC-03)', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(urlStr);
      const docId = decodeURIComponent(url.pathname.split('/').pop() || '');
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'HEAD') {
        return new Response(null, { status: 404 });
      }

      if (method === 'PUT') {
        if (docId.startsWith('h:')) {
          return new Response('Disk full error', { status: 500 });
        }
        return new Response(JSON.stringify({ ok: true, id: docId, rev: '1-rev' }), { status: 201 });
      }

      return new Response(null, { status: 405 });
    });

    const adapter = new PushAdapter({
      baseUrl,
      databaseName,
      chunkSize: 20,
      fetch: mockFetch as typeof globalThis.fetch,
    });

    const bytes = new TextEncoder().encode('Some sample text to chunk');
    const result = await adapter.pushFile({ path: 'Test.md', bytes }, capability);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Chunk write failed');
  });

  it('supports V2 E2EE encryption with salt and path obfuscation round trip', async () => {
    const remoteStore = new Map<string, CouchDbDocument>();
    const saltHex = 'abcdef0123456789abcdef0123456789';
    const passphrase = 'my-secret-vault-pass';

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(urlStr);
      const docId = decodeURIComponent(url.pathname.split('/').pop() || '');
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'HEAD') {
        return remoteStore.has(docId) ? new Response(null, { status: 200 }) : new Response(null, { status: 404 });
      }

      if (method === 'PUT') {
        const body = JSON.parse(init?.body as string);
        remoteStore.set(docId, body);
        return new Response(JSON.stringify({ ok: true, id: docId, rev: '1-v2rev' }), { status: 201 });
      }

      return new Response(null, { status: 405 });
    });

    const adapter = new PushAdapter({
      baseUrl,
      databaseName,
      chunkSize: 30,
      encryptionPassphrase: passphrase,
      pbkdf2salt: saltHex,
      algorithm: 'v2',
      usePathObfuscation: true,
      fetch: mockFetch as typeof globalThis.fetch,
    });

    const content = '# Secret Note\nThis note is fully encrypted with V2 HKDF and path obfuscation.';
    const bytes = new TextEncoder().encode(content);

    const result = await adapter.pushFile({ path: 'Private/Secret.md', bytes }, capability);
    expect(result.ok).toBe(true);

    // Verify note doc is obfuscated
    const noteDoc = remoteStore.get(result.docId)!;
    expect(noteDoc.path).not.toBe('Private/Secret.md'); // Path is encrypted

    // Verify decodeNoteLeaf can decrypt and assemble it cleanly
    const decodeRes = await decodeNoteLeaf(noteDoc, {
      encryptionPassphrase: passphrase,
      pbkdf2salt: saltHex,
      algorithm: 'v2',
      usePathObfuscation: true,
      fetchChunk: async (id) => remoteStore.get(id) ?? null,
    });

    expect(decodeRes.ok).toBe(true);
    if (decodeRes.ok) {
      expect(decodeRes.path).toBe('Private/Secret.md');
      expect(new TextDecoder().decode(decodeRes.bytes)).toBe(content);
    }
  });

  it('includes base revision when updating an existing file (SYNC-02)', async () => {
    let capturedNoteBody: Record<string, unknown> | null = null;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'HEAD') return new Response(null, { status: 200 }); // all chunks exist
      if (method === 'PUT') {
        capturedNoteBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ ok: true, id: 'doc', rev: '2-next' }), { status: 200 });
      }
      return new Response(null, { status: 405 });
    });

    const adapter = new PushAdapter({
      baseUrl,
      databaseName,
      fetch: mockFetch as typeof globalThis.fetch,
    });

    const bytes = new TextEncoder().encode('Updated content');
    const result = await adapter.pushFile(
      {
        path: 'Doc.md',
        bytes,
        baseRev: '1-prevRev',
      },
      capability
    );

    expect(result.ok).toBe(true);
    expect(capturedNoteBody?._rev).toBe('1-prevRev');
  });

  it('returns conflict result when note PUT returns 409', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'HEAD') return new Response(null, { status: 200 });
      if (method === 'PUT') {
        return new Response(JSON.stringify({ error: 'conflict', reason: 'Document update conflict.' }), {
          status: 409,
        });
      }
      return new Response(null, { status: 405 });
    });

    const adapter = new PushAdapter({
      baseUrl,
      databaseName,
      fetch: mockFetch as typeof globalThis.fetch,
    });

    const bytes = new TextEncoder().encode('Content');
    const result = await adapter.pushFile(
      {
        path: 'Doc.md',
        bytes,
        baseRev: '1-old',
      },
      capability
    );

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });
});
