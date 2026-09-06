import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runSyncCommand, emitBackupWarningBanner } from '../../src/cli/commands/sync.js';
import { runArmCommand } from '../../src/cli/commands/arm.js';
import { computeFingerprint } from '../../src/livesync/negotiation.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { WriteGrantRepo } from '../../src/storage/write-grant-repo.js';
import { EXIT_CODES, OutcomeCategory } from '../../src/diagnostics/outcomes.js';

describe('Sync & Arm CLI Commands (Unit)', () => {
  let tempDir: string;
  let vaultRoot: string;
  let statePath: string;
  let configPath: string;
  const remoteUrl = 'http://127.0.0.1:5984';
  const databaseName = 'testdb';
  const expectedFingerprint = computeFingerprint(remoteUrl, databaseName);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-cmd-unit-'));
    vaultRoot = path.join(tempDir, 'vault');
    statePath = path.join(tempDir, 'state.sqlite');
    configPath = path.join(tempDir, 'config.yaml');
    await fs.mkdir(vaultRoot, { recursive: true });

    const yamlContent = `
remote:
  url: "${remoteUrl}"
  database: "${databaseName}"
vault:
  path: "${vaultRoot}"
state:
  path: "${statePath}"
`;
    await fs.writeFile(configPath, yamlContent, 'utf8');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function createProbeMockFetch() {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/testdb') || url.endsWith('/testdb/')) {
        return new Response(JSON.stringify({ db_name: 'testdb', doc_count: 0, update_seq: '0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.includes('obsydian_livesync_version')) {
        return new Response(
          JSON.stringify({ _id: 'obsydian_livesync_version', _rev: '1-v', version: 12 }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.includes('obsydian_livesync_milestone')) {
        return new Response(
          JSON.stringify({
            _id: '_local/obsydian_livesync_milestone',
            _rev: '1-m',
            locked: false,
            tweak_values: { PREFERRED: {} },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.includes('_all_docs')) {
        return new Response(JSON.stringify({ total_rows: 0, offset: 0, rows: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    });
  }

  it('emitBackupWarningBanner emits the required SAFE-07 backup disclaimer', () => {
    const outputs: string[] = [];
    emitBackupWarningBanner((msg) => outputs.push(msg));
    const fullText = outputs.join('');

    expect(fullText).toContain('WARNING: Synchronization propagates creations, updates, and deletions');
    expect(fullText).toContain('It is NOT an independent backup');
  });

  it('runSyncCommand blocks un-armed write synchronization with MUTATION_VIOLATION (CONF-07)', async () => {
    const outputs: string[] = [];
    const writeStdout = (msg: string) => outputs.push(msg);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createProbeMockFetch() as any;

    try {
      const exitCode = await runSyncCommand({
        configPath,
        dryRun: false,
        json: true,
        stdout: writeStdout,
      });

      expect(exitCode).toBe(EXIT_CODES.MUTATION_VIOLATION);
      const jsonReport = outputs.find((s) => s.includes('"outcome":"MUTATION_VIOLATION"'));
      expect(jsonReport).toBeDefined();
      expect(jsonReport).toContain('Write operations not armed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runArmCommand issues a 5-tuple write grant in SQLite', async () => {
    const outputs: string[] = [];
    const writeStdout = (msg: string) => outputs.push(msg);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = createProbeMockFetch() as any;

    try {
      const exitCode = await runArmCommand({
        configPath,
        json: true,
        stdout: writeStdout,
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);

      // Verify grant in SQLite
      const db = openDatabase(statePath);
      const grantRepo = new WriteGrantRepo(db);
      const grant = grantRepo.getActiveGrant(expectedFingerprint, vaultRoot);
      expect(grant).not.toBeNull();
      expect(grant?.commonlibVersion).toBe('0.1.21');
      db.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runArmCommand with --revoke revokes active grants', async () => {
    const outputs: string[] = [];
    const writeStdout = (msg: string) => outputs.push(msg);

    // First issue a grant directly
    const db = openDatabase(statePath);
    const grantRepo = new WriteGrantRepo(db);
    grantRepo.issueGrant({
      remoteFingerprint: expectedFingerprint,
      vaultRoot,
      settingsHash: 'hash',
      commonlibVersion: '0.1.21',
      bootstrapGeneration: '1',
    });
    expect(grantRepo.getActiveGrant(expectedFingerprint, vaultRoot)).not.toBeNull();
    db.close();

    const exitCode = await runArmCommand({
      configPath,
      revoke: true,
      json: true,
      stdout: writeStdout,
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);

    const dbAfter = openDatabase(statePath);
    const repoAfter = new WriteGrantRepo(dbAfter);
    expect(repoAfter.getActiveGrant(expectedFingerprint, vaultRoot)).toBeNull();
    dbAfter.close();
  });
});
