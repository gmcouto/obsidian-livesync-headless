import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/storage/sqlite.js';
import { ProvenanceRepository } from '../../src/storage/provenance-repo.js';
import { DaemonStateMachine } from '../../src/daemon/daemon-state.js';
import { FileReconciler } from '../../src/daemon/file-reconciler.js';
import type { WriteCapability } from '../../src/security/capabilities.js';

describe('FileReconciler', () => {
  let tmpVault: string;
  let tmpStateDir: string;
  let statePath: string;
  let stateMachine: DaemonStateMachine;

  const mockCapability: WriteCapability = {
    grantId: 'grant-test-123',
    remoteFingerprint: 'fp-test-123',
    vaultRoot: '',
    settingsHash: 'shash-123',
    commonlibVersion: '0.1.21',
    bootstrapGeneration: 'gen-1',
    issuedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'ols-reconcile-vault-'));
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ols-reconcile-state-'));
    statePath = path.join(tmpStateDir, 'state.sqlite');

    // Initialize db
    const db = openDatabase(statePath);
    db.close();

    stateMachine = new DaemonStateMachine();
    stateMachine.transitionTo('HEALTHY_BIDIRECTIONAL');
  });

  afterEach(async () => {
    await fs.rm(tmpVault, { recursive: true, force: true });
    await fs.rm(tmpStateDir, { recursive: true, force: true });
  });

  it('recognizes identical content as a noop and updates provenance', async () => {
    const relativePath = 'note.md';
    const content = 'Exact same content';
    await fs.writeFile(path.join(tmpVault, relativePath), content);

    const hash = createHash('sha256').update(content).digest('hex');

    // Mock fetch returning remote doc with matching content
    const mockFetch: typeof globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/chunk%3A1') || url.includes('/chunk:1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _id: 'chunk:1',
            data: content,
            type: 'leaf',
          }),
        } as unknown as Response;
      }
      if (url.includes('/_changes') || url.includes('/note.md')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _id: 'note.md',
            _rev: '1-remote-rev',
            path: 'note.md',
            type: 'plain',
            size: Buffer.byteLength(content),
            children: ['chunk:1'],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const reconciler = new FileReconciler({
      vaultRoot: tmpVault,
      statePath,
      baseUrl: new URL('http://127.0.0.1:5984'),
      databaseName: 'testdb',
      remoteFingerprint: 'fp-test-123',
      fetch: mockFetch,
      stateMachine,
      getCapability: () => mockCapability,
    });

    const result = await reconciler.reconcile(relativePath);
    expect(result.action).toBe('noop');
    expect(result.success).toBe(true);

    const db = openDatabase(statePath);
    const provRepo = new ProvenanceRepository(db);
    const saved = provRepo.getByPath(relativePath);
    db.close();

    expect(saved?.contentSha256).toBe(hash);
    expect(saved?.remoteRevision).toBe('1-remote-rev');
  });

  it('skips push mutation when daemon is in DEGRADED_READ_ONLY mode', async () => {
    stateMachine.transitionTo('DEGRADED_READ_ONLY', 'Write grant revoked');

    const relativePath = 'local-only.md';
    await fs.writeFile(path.join(tmpVault, relativePath), 'Local only note');

    const mockFetch: typeof globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as unknown as Response);

    const reconciler = new FileReconciler({
      vaultRoot: tmpVault,
      statePath,
      baseUrl: new URL('http://127.0.0.1:5984'),
      databaseName: 'testdb',
      remoteFingerprint: 'fp-test-123',
      fetch: mockFetch,
      stateMachine,
      getCapability: () => null, // No capability in degraded mode
    });

    const result = await reconciler.reconcile(relativePath);
    expect(result.action).toBe('skipped');
    expect(result.success).toBe(true);
  });

  it('pulls remote document and creates local file when missing locally', async () => {
    const relativePath = 'remote-new.md';
    const remoteContent = 'Remote content to pull';

    const mockFetch: typeof globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/chunk%3A2') || url.includes('/chunk:2')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _id: 'chunk:2',
            data: remoteContent,
            type: 'leaf',
          }),
        } as unknown as Response;
      }
      if (url.includes('/remote-new.md')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            _id: 'remote-new.md',
            _rev: '2-pulled-rev',
            path: 'remote-new.md',
            type: 'plain',
            size: Buffer.byteLength(remoteContent),
            children: ['chunk:2'],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const reconciler = new FileReconciler({
      vaultRoot: tmpVault,
      statePath,
      baseUrl: new URL('http://127.0.0.1:5984'),
      databaseName: 'testdb',
      remoteFingerprint: 'fp-test-123',
      fetch: mockFetch,
      stateMachine,
      getCapability: () => mockCapability,
    });

    const result = await reconciler.reconcile(relativePath);
    expect(result.action).toBe('pull');
    expect(result.success).toBe(true);

    const onDisk = await fs.readFile(path.join(tmpVault, relativePath), 'utf-8');
    expect(onDisk).toBe(remoteContent);

    const db = openDatabase(statePath);
    const provRepo = new ProvenanceRepository(db);
    const saved = provRepo.getByPath(relativePath);
    db.close();

    expect(saved?.remoteRevision).toBe('2-pulled-rev');
  });
});
