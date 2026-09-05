import { describe, it, expect, vi } from 'vitest';
import {
  createGuardedFetch,
  MutationAttemptBlockedError,
  EndpointDisallowedError,
} from '../../src/security/transport-guard.js';
import {
  createReadCapability,
  createAdmissionCapability,
  createVaultReflectCapability,
  isReadCapability,
  isAdmissionCapability,
  isVaultReflectCapability,
} from '../../src/security/capabilities.js';

describe('Guarded Read-Only HTTP Transport', () => {
  const allowedBaseUrl = new URL('http://127.0.0.1:5984');
  const databaseName = 'obsidian-vault';
  const vaultRoot = '/path/to/vault';

  it('allows GET and HEAD requests to database endpoints', async () => {
    const mockBaseFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const guardedFetch = createGuardedFetch(
      { allowedBaseUrl, databaseName },
      mockBaseFetch as typeof globalThis.fetch
    );

    const res1 = await guardedFetch('http://127.0.0.1:5984/obsidian-vault');
    expect(res1.status).toBe(200);

    const res2 = await guardedFetch('http://127.0.0.1:5984/obsidian-vault/doc123', {
      method: 'GET',
    });
    expect(res2.status).toBe(200);

    const res3 = await guardedFetch('http://127.0.0.1:5984/obsidian-vault', {
      method: 'HEAD',
    });
    expect(res3.status).toBe(200);

    const resRoot = await guardedFetch('http://127.0.0.1:5984/');
    expect(resRoot.status).toBe(200);

    expect(mockBaseFetch).toHaveBeenCalledTimes(4);
  });

  it('blocks PUT, POST, DELETE, PATCH mutating methods before network dispatch', async () => {
    const mockBaseFetch = vi.fn();
    const guardedFetch = createGuardedFetch(
      { allowedBaseUrl, databaseName },
      mockBaseFetch as typeof globalThis.fetch
    );

    const mutatingMethods = ['PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'];

    for (const method of mutatingMethods) {
      await expect(
        guardedFetch('http://127.0.0.1:5984/obsidian-vault/newdoc', { method })
      ).rejects.toThrow(MutationAttemptBlockedError);

      try {
        await guardedFetch('http://127.0.0.1:5984/obsidian-vault/newdoc', { method });
      } catch (err) {
        expect((err as MutationAttemptBlockedError).method).toBe(method);
        expect((err as MutationAttemptBlockedError).url).toContain('/obsidian-vault/newdoc');
      }
    }

    // Ensure mockBaseFetch was never invoked for mutating methods
    expect(mockBaseFetch).not.toHaveBeenCalled();
  });

  it('blocks administrative and destructive CouchDB subpaths', async () => {
    const mockBaseFetch = vi.fn();
    const guardedFetch = createGuardedFetch(
      { allowedBaseUrl, databaseName },
      mockBaseFetch as typeof globalThis.fetch
    );

    const adminPaths = [
      'http://127.0.0.1:5984/obsidian-vault/_compact',
      'http://127.0.0.1:5984/obsidian-vault/_purge',
      'http://127.0.0.1:5984/obsidian-vault/_security',
      'http://127.0.0.1:5984/obsidian-vault/_revs_limit',
      'http://127.0.0.1:5984/_replicator',
      'http://127.0.0.1:5984/obsidian-vault/_design/app',
      'http://127.0.0.1:5984/_users',
      'http://127.0.0.1:5984/_node/node1@127.0.0.1/_config',
    ];

    for (const path of adminPaths) {
      await expect(guardedFetch(path)).rejects.toThrow(EndpointDisallowedError);
    }

    expect(mockBaseFetch).not.toHaveBeenCalled();
  });

  it('blocks requests to different hosts, schemes, or ports', async () => {
    const mockBaseFetch = vi.fn();
    const guardedFetch = createGuardedFetch(
      { allowedBaseUrl, databaseName },
      mockBaseFetch as typeof globalThis.fetch
    );

    await expect(guardedFetch('http://malicious-host:5984/obsidian-vault')).rejects.toThrow(
      EndpointDisallowedError
    );
    await expect(guardedFetch('https://127.0.0.1:5984/obsidian-vault')).rejects.toThrow(
      EndpointDisallowedError
    );
    await expect(guardedFetch('http://127.0.0.1:6984/obsidian-vault')).rejects.toThrow(
      EndpointDisallowedError
    );

    expect(mockBaseFetch).not.toHaveBeenCalled();
  });

  it('blocks access to databases other than the configured databaseName', async () => {
    const mockBaseFetch = vi.fn();
    const guardedFetch = createGuardedFetch(
      { allowedBaseUrl, databaseName },
      mockBaseFetch as typeof globalThis.fetch
    );

    await expect(guardedFetch('http://127.0.0.1:5984/other-database')).rejects.toThrow(
      EndpointDisallowedError
    );
    expect(mockBaseFetch).not.toHaveBeenCalled();
  });

  it('blocks 3xx redirects to a different origin', async () => {
    const mockBaseFetch = vi.fn().mockImplementation(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://attacker-host.com/steal-creds' },
      });
    });

    const guardedFetch = createGuardedFetch(
      { allowedBaseUrl, databaseName },
      mockBaseFetch as typeof globalThis.fetch
    );

    await expect(guardedFetch('http://127.0.0.1:5984/obsidian-vault')).rejects.toThrow(
      EndpointDisallowedError
    );
  });

  it('follows 3xx redirects within the same origin to an allowed path', async () => {
    let callCount = 0;
    const mockBaseFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      callCount++;
      if (callCount === 1) {
        return new Response(null, {
          status: 301,
          headers: { Location: 'http://127.0.0.1:5984/obsidian-vault/canonical' },
        });
      }
      return new Response(JSON.stringify({ redirected: true }), { status: 200 });
    });

    const guardedFetch = createGuardedFetch(
      { allowedBaseUrl, databaseName },
      mockBaseFetch as typeof globalThis.fetch
    );

    const res = await guardedFetch('http://127.0.0.1:5984/obsidian-vault');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.redirected).toBe(true);
    expect(mockBaseFetch).toHaveBeenCalledTimes(2);
  });

  it('correctly creates and validates capability tokens', () => {
    const readCap = createReadCapability(allowedBaseUrl, databaseName);
    expect(isReadCapability(readCap)).toBe(true);
    expect(isAdmissionCapability(readCap)).toBe(false);
    expect(isVaultReflectCapability(readCap)).toBe(false);
    expect(readCap.databaseName).toBe(databaseName);

    const admissionCap = createAdmissionCapability(
      allowedBaseUrl,
      databaseName,
      'fingerprint-sha256',
      'settings-sha256'
    );
    expect(isAdmissionCapability(admissionCap)).toBe(true);
    expect(isReadCapability(admissionCap)).toBe(false);
    expect(isVaultReflectCapability(admissionCap)).toBe(false);
    expect(admissionCap.remoteFingerprint).toBe('fingerprint-sha256');
    expect(admissionCap.negotiatedSettingsHash).toBe('settings-sha256');

    const reflectCap = createVaultReflectCapability(allowedBaseUrl, databaseName, vaultRoot);
    expect(isVaultReflectCapability(reflectCap)).toBe(true);
    expect(isReadCapability(reflectCap)).toBe(false);
    expect(isAdmissionCapability(reflectCap)).toBe(false);
    expect(reflectCap.vaultRoot).toBe(vaultRoot);

    expect(isReadCapability({})).toBe(false);
    expect(isAdmissionCapability(null)).toBe(false);
    expect(isVaultReflectCapability({})).toBe(false);
    expect(isVaultReflectCapability(null)).toBe(false);
  });
});
