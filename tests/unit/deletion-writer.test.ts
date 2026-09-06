import { describe, it, expect, vi } from 'vitest';
import { DeletionWriter } from '../../src/livesync/deletion-writer.js';
import { decodeNoteLeaf } from '../../src/livesync/decode-adapter.js';
import { createWriteCapability } from '../../src/security/capabilities.js';
import type { CouchDbDocument } from '../../src/livesync/inspector.js';

describe('DeletionWriter', () => {
  const baseUrl = new URL('http://couchdb.local:5984');
  const databaseName = 'vaultdb';
  const capability = createWriteCapability(
    baseUrl,
    databaseName,
    'grant-del-123',
    'remote-fp-123',
    '/home/vault'
  );

  it('writes a LiveSync logical deletion document extending the base revision (SYNC-04)', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedMethod: string | null = null;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedMethod = (init?.method || 'GET').toUpperCase();
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true, id: capturedBody?._id, rev: '2-deletedRev' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const writer = new DeletionWriter({
      baseUrl,
      databaseName,
      fetch: mockFetch as typeof globalThis.fetch,
    });

    const result = await writer.writeDeletion('Folder/OldNote.md', '1-baseRev', capability);

    expect(result.ok).toBe(true);
    expect(result.path).toBe('Folder/OldNote.md');
    expect(result.rev).toBe('2-deletedRev');

    // Must use PUT, never DELETE
    expect(capturedMethod).toBe('PUT');
    expect(capturedBody?._rev).toBe('1-baseRev');
    expect(capturedBody?.deleted).toBe(true);
    expect(capturedBody?.type).toBe('notes');
    expect(capturedBody?.path).toBe('Folder/OldNote.md');

    // Verify round-trip decode with decodeNoteLeaf
    const decodeRes = await decodeNoteLeaf(capturedBody as unknown as CouchDbDocument);
    expect(decodeRes.ok).toBe(true);
    if (decodeRes.ok) {
      expect(decodeRes.deleted).toBe(true);
      expect(decodeRes.path).toBe('Folder/OldNote.md');
    }
  });

  it('supports path obfuscation and E2EE encryption for deletions', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const saltHex = '0123456789abcdef0123456789abcdef';
    const passphrase = 'secure-passphrase';

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true, id: capturedBody?._id, rev: '3-delRev' }), {
        status: 201,
      });
    });

    const writer = new DeletionWriter({
      baseUrl,
      databaseName,
      encryptionPassphrase: passphrase,
      pbkdf2salt: saltHex,
      algorithm: 'v2',
      usePathObfuscation: true,
      fetch: mockFetch as typeof globalThis.fetch,
    });

    const result = await writer.writeDeletion('Private/OldSecret.md', '2-liveRev', capability);

    expect(result.ok).toBe(true);
    expect(capturedBody?.path).not.toBe('Private/OldSecret.md'); // Obfuscated/encrypted path

    const decodeRes = await decodeNoteLeaf(capturedBody as unknown as CouchDbDocument, {
      encryptionPassphrase: passphrase,
      pbkdf2salt: saltHex,
      algorithm: 'v2',
      usePathObfuscation: true,
    });

    expect(decodeRes.ok).toBe(true);
    if (decodeRes.ok) {
      expect(decodeRes.deleted).toBe(true);
      expect(decodeRes.path).toBe('Private/OldSecret.md');
    }
  });

  it('handles 409 conflict when writing deletion', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'conflict', reason: 'Document update conflict.' }), {
        status: 409,
      });
    });

    const writer = new DeletionWriter({
      baseUrl,
      databaseName,
      fetch: mockFetch as typeof globalThis.fetch,
    });

    const result = await writer.writeDeletion('ConflictDoc.md', '1-staleRev', capability);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });
});
