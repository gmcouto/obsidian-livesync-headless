import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SyncCoordinator } from '../../src/domain/sync-coordinator.js';
import { createWriteCapability } from '../../src/security/capabilities.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { ProvenanceRepository } from '../../src/storage/provenance-repo.js';
import { QuarantineRepository } from '../../src/storage/quarantine-repo.js';
import { CheckpointRepository } from '../../src/storage/checkpoint-repo.js';

describe('SyncCoordinator (Unit)', () => {
  let tempDir: string;
  let vaultRoot: string;
  let statePath: string;
  const baseUrl = new URL('http://127.0.0.1:5984');
  const databaseName = 'testdb';
  const remoteFingerprint = 'fp-test-1234';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-coord-unit-'));
    vaultRoot = path.join(tempDir, 'vault');
    statePath = path.join(tempDir, 'state.sqlite');
    await fs.mkdir(vaultRoot, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('throws when not in dry-run mode and no WriteCapability is provided', async () => {
    const coordinator = new SyncCoordinator({
      baseUrl,
      databaseName,
      vaultRoot,
      statePath,
      dryRun: false,
      remoteFingerprint,
    });

    await expect(coordinator.sync(undefined)).rejects.toThrow(
      /SyncCoordinator requires WriteCapability/
    );
  });

  it('handles dry-run mode: computes plan and performs zero writes', async () => {
    // Mock fetch for CouchDB inventory
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr.includes('/_all_docs')) {
        return new Response(
          JSON.stringify({
            total_rows: 1,
            offset: 0,
            rows: [
              {
                id: 'remote.md',
                key: 'remote.md',
                value: { rev: '1-abc' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (urlStr.includes('remote.md')) {
        return new Response(
          JSON.stringify({
            _id: 'remote.md',
            _rev: '1-abc',
            type: 'notes',
            path: 'remote.md',
            data: 'Remote content',
            mtime: Date.now(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const coordinator = new SyncCoordinator({
      baseUrl,
      databaseName,
      vaultRoot,
      statePath,
      dryRun: true,
      remoteFingerprint,
      handleFilenameCaseSensitive: true,
      fetch: mockFetch as any,
    });

    const result = await coordinator.sync();

    expect(result.ok).toBe(true);
    expect(result.appliedActions).toBe(0);
    expect(result.plan.summary.pullCreates).toBe(1);

    // Verify no files written to disk
    const filesOnDisk = await fs.readdir(vaultRoot);
    expect(filesOnDisk.length).toBe(0);

    // Verify SQLite has zero provenance records
    const db = openDatabase(statePath);
    const pRepo = new ProvenanceRepository(db);
    expect(pRepo.getAllAsMap().size).toBe(0);
    db.close();
  });

  it('executes apply mode for bidirectional sync (pulls remote, pushes local, updates provenance & checkpoint)', async () => {
    // 1. Create a local file to push
    const localContent = 'Hello from local file';
    await fs.writeFile(path.join(vaultRoot, 'local.md'), localContent);

    const uploadedDocs: any[] = [];

    // Mock fetch for inventory and push
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = input.toString();
      const method = init?.method ?? 'GET';

      if (urlStr.includes('/_all_docs')) {
        return new Response(
          JSON.stringify({
            total_rows: 1,
            offset: 0,
            rows: [
              {
                id: 'remote.md',
                key: 'remote.md',
                value: { rev: '1-rem' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (urlStr.includes('remote.md') && method === 'GET') {
        return new Response(
          JSON.stringify({
            _id: 'remote.md',
            _rev: '1-rem',
            type: 'notes',
            path: 'remote.md',
            data: 'Remote pulled content',
            mtime: Date.now(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (method === 'PUT') {
        const body = JSON.parse(init?.body as string);
        uploadedDocs.push(body);
        return new Response(JSON.stringify({ ok: true, id: body._id, rev: '1-pushed' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const coordinator = new SyncCoordinator({
      baseUrl,
      databaseName,
      vaultRoot,
      statePath,
      dryRun: false,
      remoteFingerprint,
      handleFilenameCaseSensitive: true,
      updateSeq: '42-seq',
      fetch: mockFetch as any,
    });

    const capability = createWriteCapability(baseUrl, databaseName, 'grant-1', remoteFingerprint, vaultRoot);
    const result = await coordinator.sync(capability);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.appliedActions).toBe(2); // 1 pull-create, 1 push-create
    expect(result.plan.summary.pullCreates).toBe(1);
    expect(result.plan.summary.pushCreates).toBe(1);

    // Check remote pulled file is installed on disk
    const pulledData = await fs.readFile(path.join(vaultRoot, 'remote.md'), 'utf8');
    expect(pulledData).toBe('Remote pulled content');

    // Check local file was pushed
    expect(uploadedDocs.length).toBe(1);
    expect(uploadedDocs[0]._id).toBe('local.md');

    // Check provenance in SQLite
    const db = openDatabase(statePath);
    const pRepo = new ProvenanceRepository(db);
    const pulledProv = pRepo.getByPath('remote.md');
    const pushedProv = pRepo.getByPath('local.md');
    expect(pulledProv?.remoteRevision).toBe('1-rem');
    expect(pushedProv?.remoteRevision).toBe('1-pushed');

    // Check checkpoint updated
    const cRepo = new CheckpointRepository(db);
    const cp = cRepo.getCheckpoint(remoteFingerprint);
    expect(cp?.lastUpdateSeq).toBe('42-seq');
    db.close();
  });

  it('safely surfaces conflicts and halts fail-closed without overwriting either side (SYNC-06, SYNC-07)', async () => {
    // Local and remote have divergent content and different base
    await fs.writeFile(path.join(vaultRoot, 'conflict.md'), 'Local divergent edit');

    const db = openDatabase(statePath);
    const pRepo = new ProvenanceRepository(db);
    pRepo.saveProvenance({
      path: 'conflict.md',
      remoteRevision: '1-old',
      contentSha256: 'oldhash',
      observedMtime: 1000,
      remoteFingerprint,
      reflectedAt: new Date().toISOString(),
    });
    db.close();

    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr.includes('/_all_docs')) {
        return new Response(
          JSON.stringify({
            total_rows: 1,
            offset: 0,
            rows: [
              {
                id: 'conflict.md',
                key: 'conflict.md',
                value: { rev: '2-remote' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (urlStr.includes('conflict.md')) {
        return new Response(
          JSON.stringify({
            _id: 'conflict.md',
            _rev: '2-remote',
            type: 'notes',
            path: 'conflict.md',
            data: 'Remote divergent edit',
            mtime: 2000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const coordinator = new SyncCoordinator({
      baseUrl,
      databaseName,
      vaultRoot,
      statePath,
      dryRun: false,
      remoteFingerprint,
      handleFilenameCaseSensitive: true,
      fetch: mockFetch as any,
    });

    const capability = createWriteCapability(baseUrl, databaseName, 'grant-1', remoteFingerprint, vaultRoot);
    const result = await coordinator.sync(capability);

    expect(result.ok).toBe(false);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]).toContain("Conflict at 'conflict.md'");
    expect(result.appliedActions).toBe(0);

    // Ensure local file was not overwritten
    const localAfter = await fs.readFile(path.join(vaultRoot, 'conflict.md'), 'utf8');
    expect(localAfter).toBe('Local divergent edit');
  });
});
