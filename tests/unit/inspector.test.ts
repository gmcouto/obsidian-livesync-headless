import { describe, it, expect, vi } from 'vitest';
import {
  probeRemoteDatabase,
  fetchDocumentIfExists,
  DatabaseNotFoundError,
  AuthenticationRequiredError,
  VERSIONING_DOCID,
  MILESTONE_DOCID,
  DOCID_SYNC_PARAMETERS,
  SYNCINFO_ID,
} from '../../src/livesync/inspector.js';
import {
  ZeroMutationVerifier,
  MutationDetectedError,
} from '../../src/livesync/zero-mutation.js';

describe('CouchDB Protocol Inspector Unit Tests', () => {
  const baseUrl = new URL('http://127.0.0.1:5984');
  const databaseName = 'obsidian-vault';

  it('successfully probes a well-formed LiveSync database', async () => {
    const mockResponses: Record<string, unknown> = {
      'http://127.0.0.1:5984/': { couchdb: 'Welcome', version: '3.5.2' },
      'http://127.0.0.1:5984/obsidian-vault': {
        db_name: 'obsidian-vault',
        doc_count: 42,
        update_seq: '100-g1AAAA',
      },
      [`http://127.0.0.1:5984/obsidian-vault/${VERSIONING_DOCID}`]: {
        _id: VERSIONING_DOCID,
        _rev: '1-ver',
        version: 12,
      },
      [`http://127.0.0.1:5984/obsidian-vault/${MILESTONE_DOCID}`]: {
        _id: MILESTONE_DOCID,
        _rev: '2-mile',
        locked: false,
        tweak_values: { PREFERRED: { hashAlg: 'sha256' } },
      },
      [`http://127.0.0.1:5984/obsidian-vault/${DOCID_SYNC_PARAMETERS}`]: {
        _id: DOCID_SYNC_PARAMETERS,
        _rev: '1-params',
        pbkdf2salt: 'salt123',
        hashAlgorithm: 'sha256',
      },
      [`http://127.0.0.1:5984/obsidian-vault/${SYNCINFO_ID}`]: {
        _id: SYNCINFO_ID,
        _rev: '1-sync',
        data: 'encrypted-syncinfo-payload',
      },
      'http://127.0.0.1:5984/obsidian-vault/_all_docs?limit=10': {
        total_rows: 42,
        offset: 0,
        rows: [
          { id: 'note1.md', value: { rev: '1-abc' } },
          { id: 'note2.md', value: { rev: '2-def' } },
        ],
      },
    };

    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const data = mockResponses[url];
      if (data !== undefined) {
        return new Response(JSON.stringify(data), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not_found', reason: 'missing' }), {
        status: 404,
      });
    });

    const result = await probeRemoteDatabase(
      mockFetch as typeof globalThis.fetch,
      baseUrl,
      databaseName,
      { username: 'admin', password: 'password' }
    );

    expect(result.databaseInfo.docCount).toBe(42);
    expect(result.databaseInfo.updateSeq).toBe('100-g1AAAA');
    expect(result.databaseInfo.couchdbVersion).toBe('3.5.2');

    expect(result.versionDoc?.version).toBe(12);
    expect(result.milestoneDoc?.locked).toBe(false);
    expect(result.milestoneDoc?.tweak_values?.PREFERRED).toEqual({ hashAlg: 'sha256' });
    expect(result.syncParamsDoc?.pbkdf2salt).toBe('salt123');
    expect(result.syncinfoDoc?.data).toBe('encrypted-syncinfo-payload');
    expect(result.sampleDocs).toHaveLength(2);
    expect(result.sampleDocs[0].id).toBe('note1.md');
  });

  it('throws DatabaseNotFoundError when database returns 404', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    });

    await expect(
      probeRemoteDatabase(mockFetch as typeof globalThis.fetch, baseUrl, 'nonexistent-db')
    ).rejects.toThrow(DatabaseNotFoundError);
  });

  it('throws AuthenticationRequiredError when CouchDB returns 401 or 403', async () => {
    const mockFetch401 = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    });
    await expect(
      probeRemoteDatabase(mockFetch401 as typeof globalThis.fetch, baseUrl, databaseName)
    ).rejects.toThrow(AuthenticationRequiredError);

    const mockFetch403 = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    });
    await expect(
      probeRemoteDatabase(mockFetch403 as typeof globalThis.fetch, baseUrl, databaseName)
    ).rejects.toThrow(AuthenticationRequiredError);
  });

  it('returns null for missing optional documents without throwing', async () => {
    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://127.0.0.1:5984/obsidian-vault') {
        return new Response(JSON.stringify({ doc_count: 0, update_seq: '0' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    });

    const result = await probeRemoteDatabase(mockFetch as typeof globalThis.fetch, baseUrl, databaseName);

    expect(result.databaseInfo.docCount).toBe(0);
    expect(result.versionDoc).toBeNull();
    expect(result.milestoneDoc).toBeNull();
    expect(result.syncParamsDoc).toBeNull();
    expect(result.syncinfoDoc).toBeNull();
    expect(result.sampleDocs).toEqual([]);
  });

  it('fetchDocumentIfExists appends conflicts=true and other query params to the document URL', async () => {
    const mockResponses: Record<string, unknown> = {
      'http://127.0.0.1:5984/obsidian-vault/Welcome.md?conflicts=true': {
        _id: 'Welcome.md',
        _rev: '2-win',
        type: 'notes',
        path: 'Welcome.md',
        _conflicts: ['1-other'],
      },
      'http://127.0.0.1:5984/obsidian-vault/Welcome.md?rev=1-other': {
        _id: 'Welcome.md',
        _rev: '1-other',
        type: 'notes',
        path: 'Welcome.md',
        data: 'other-leaf',
      },
    };

    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const data = mockResponses[url];
      if (data !== undefined) {
        return new Response(JSON.stringify(data), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    });

    const withConflicts = await fetchDocumentIfExists(
      mockFetch as typeof globalThis.fetch,
      baseUrl,
      databaseName,
      'Welcome.md',
      undefined,
      { conflicts: 'true' }
    );
    expect(withConflicts?._rev).toBe('2-win');
    expect(withConflicts?._conflicts).toEqual(['1-other']);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5984/obsidian-vault/Welcome.md?conflicts=true',
      expect.objectContaining({ method: 'GET' })
    );

    const leaf = await fetchDocumentIfExists(
      mockFetch as typeof globalThis.fetch,
      baseUrl,
      databaseName,
      'Welcome.md',
      undefined,
      { rev: '1-other' }
    );
    expect(leaf?._rev).toBe('1-other');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5984/obsidian-vault/Welcome.md?rev=1-other',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('ZeroMutationVerifier verifies identical snapshots and flags any changes', () => {
    const pre = {
      updateSeq: '1-abc',
      docCount: 10,
      revisions: {
        obsydian_livesync_version: '1-v',
        '_local/obsydian_livesync_milestone': '1-m',
      },
    };

    // Unchanged
    expect(() => ZeroMutationVerifier.assertNoMutation(pre, { ...pre })).not.toThrow();

    // Changed updateSeq
    expect(() =>
      ZeroMutationVerifier.assertNoMutation(pre, { ...pre, updateSeq: '2-def' })
    ).toThrow(MutationDetectedError);

    // Changed docCount
    expect(() =>
      ZeroMutationVerifier.assertNoMutation(pre, { ...pre, docCount: 11 })
    ).toThrow(MutationDetectedError);

    // Changed doc rev
    expect(() =>
      ZeroMutationVerifier.assertNoMutation(pre, {
        ...pre,
        revisions: { ...pre.revisions, obsydian_livesync_version: '2-v' },
      })
    ).toThrow(MutationDetectedError);
  });
});
