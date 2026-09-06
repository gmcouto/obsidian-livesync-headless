import { describe, it, expect, vi } from 'vitest';
import {
  createArmedGuardedFetch,
  MutationAttemptBlockedError,
  EndpointDisallowedError,
} from '../../src/security/transport-guard.js';

describe('createArmedGuardedFetch', () => {
  const options = {
    allowedBaseUrl: new URL('http://couchdb.local:5984'),
    databaseName: 'testvault',
  };

  it('allows GET, HEAD, PUT, and POST requests to allowed endpoints', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const armedFetch = createArmedGuardedFetch(options, mockFetch);

    // GET db
    await armedFetch('http://couchdb.local:5984/testvault');
    // POST _bulk_docs
    await armedFetch('http://couchdb.local:5984/testvault/_bulk_docs', { method: 'POST', body: '{}' });
    // PUT doc
    await armedFetch('http://couchdb.local:5984/testvault/doc1', { method: 'PUT', body: '{}' });
    // HEAD doc
    await armedFetch('http://couchdb.local:5984/testvault/doc1', { method: 'HEAD' });
    // GET root
    await armedFetch('http://couchdb.local:5984/');

    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('strictly blocks DELETE method with MutationAttemptBlockedError', async () => {
    const mockFetch = vi.fn();
    const armedFetch = createArmedGuardedFetch(options, mockFetch);

    await expect(
      armedFetch('http://couchdb.local:5984/testvault/doc1', { method: 'DELETE' })
    ).rejects.toThrow(MutationAttemptBlockedError);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('strictly blocks COPY and PATCH methods with MutationAttemptBlockedError', async () => {
    const mockFetch = vi.fn();
    const armedFetch = createArmedGuardedFetch(options, mockFetch);

    await expect(
      armedFetch('http://couchdb.local:5984/testvault/doc1', { method: 'COPY' })
    ).rejects.toThrow(MutationAttemptBlockedError);

    await expect(
      armedFetch('http://couchdb.local:5984/testvault/doc1', { method: 'PATCH' })
    ).rejects.toThrow(MutationAttemptBlockedError);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks administrative and destructive subpaths even when called with POST or PUT', async () => {
    const mockFetch = vi.fn();
    const armedFetch = createArmedGuardedFetch(options, mockFetch);

    // _compact
    await expect(
      armedFetch('http://couchdb.local:5984/testvault/_compact', { method: 'POST' })
    ).rejects.toThrow(EndpointDisallowedError);

    // _purge
    await expect(
      armedFetch('http://couchdb.local:5984/testvault/_purge', { method: 'POST' })
    ).rejects.toThrow(EndpointDisallowedError);

    // _security
    await expect(
      armedFetch('http://couchdb.local:5984/testvault/_security', { method: 'PUT', body: '{}' })
    ).rejects.toThrow(EndpointDisallowedError);

    // _design
    await expect(
      armedFetch('http://couchdb.local:5984/testvault/_design/app', { method: 'PUT', body: '{}' })
    ).rejects.toThrow(EndpointDisallowedError);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks access to out-of-scope paths or different databases', async () => {
    const mockFetch = vi.fn();
    const armedFetch = createArmedGuardedFetch(options, mockFetch);

    await expect(
      armedFetch('http://couchdb.local:5984/otherdb/doc1', { method: 'GET' })
    ).rejects.toThrow(EndpointDisallowedError);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks cross-origin requests and cross-origin redirects', async () => {
    const mockFetch = vi.fn();
    const armedFetch = createArmedGuardedFetch(options, mockFetch);

    // Cross origin direct call
    await expect(
      armedFetch('http://evil.com:5984/testvault/doc1', { method: 'GET' })
    ).rejects.toThrow(EndpointDisallowedError);

    // Cross origin redirect
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://evil.com:5984/testvault/doc1' },
      })
    );

    await expect(
      armedFetch('http://couchdb.local:5984/testvault/doc1', { method: 'GET' })
    ).rejects.toThrow(EndpointDisallowedError);
  });
});
