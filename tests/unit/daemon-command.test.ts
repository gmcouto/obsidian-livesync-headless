import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseCliArgs, CLI_HELP } from '../../src/cli/index.js';
import { runDaemonCommand } from '../../src/cli/commands/daemon.js';
import { computeFingerprint } from '../../src/livesync/negotiation.js';
import { openDatabase } from '../../src/storage/sqlite.js';
import { AdmissionRepository } from '../../src/storage/admission-repo.js';
import { EXIT_CODES } from '../../src/diagnostics/outcomes.js';

describe('CLI Daemon Command', () => {
  let tmpDir: string;
  let vaultDir: string;
  let configPath: string;
  let stateDbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ols-daemon-cmd-test-'));
    vaultDir = path.join(tmpDir, 'vault');
    await fs.mkdir(vaultDir, { recursive: true });

    stateDbPath = path.join(tmpDir, 'state.sqlite');
    configPath = path.join(tmpDir, 'config.yaml');

    const configContent = `
remote:
  url: "http://127.0.0.1:5984"
  database: "testdb"
vault:
  path: "${vaultDir}"
state:
  path: "${stateDbPath}"
`;
    await fs.writeFile(configPath, configContent);

    const fingerprint = computeFingerprint('http://127.0.0.1:5984', 'testdb');

    // Seed admission
    const db = openDatabase(stateDbPath);
    const admissionRepo = new AdmissionRepository(db);
    admissionRepo.saveAdmission({
      remoteFingerprint: fingerprint,
      couchdbUrl: 'http://127.0.0.1:5984',
      databaseName: 'testdb',
      couchdbVersion: '3.5.2',
      versionInfoRev: '1-v',
      milestoneRev: '1-m',
      negotiatedSettingsHash: 'shash-123',
      negotiatedSettingsJson: '{}',
      updateSeq: '0',
      admittedAt: new Date().toISOString(),
    });
    db.close();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses CLI daemon arguments correctly', () => {
    const parsed = parseCliArgs([
      'daemon',
      '-c',
      'config.yaml',
      '--write',
      '--periodic-scan-sec',
      '60',
      '--concurrency',
      '8',
      '--debounce-ms',
      '500',
    ]);

    expect(parsed.command).toBe('daemon');
    expect(parsed.options.config).toBe('config.yaml');
    expect(parsed.options.write).toBe(true);
    expect(parsed.options.periodicScanSec).toBe(60);
    expect(parsed.options.concurrency).toBe(8);
    expect(parsed.options.debounceMs).toBe(500);
  });

  it('includes daemon command in CLI help text', () => {
    expect(CLI_HELP).toContain('daemon');
    expect(CLI_HELP).toContain('--periodic-scan-sec');
    expect(CLI_HELP).toContain('--concurrency');
    expect(CLI_HELP).toContain('--debounce-ms');
  });

  it('rejects --write mode with error when no active write grant exists', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const exitCode = await runDaemonCommand({
      configPath,
      write: true,
      stdout: (msg) => stdoutLines.push(msg),
      stderr: (msg) => stderrLines.push(msg),
      registerSignalHandlers: false,
    });

    expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(stderrLines.some((msg) => msg.includes('No active write grant found'))).toBe(true);
  });

  it('runs read-only daemon startup cleanly when write mode is false', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    // Mock fetch for catch-up pass and changes stream
    const mockFetch: typeof globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/_changes')) {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ rows: [] }),
      } as unknown as Response;
    });

    const exitCode = await runDaemonCommand({
      configPath,
      write: false,
      fetch: mockFetch,
      stdout: (msg) => stdoutLines.push(msg),
      stderr: (msg) => stderrLines.push(msg),
      registerSignalHandlers: false,
      onEngineReady: async (engine) => {
        expect(engine.stateMachine.getState()).toBe('DEGRADED_READ_ONLY');
        await engine.stop();
      },
    });

    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(stdoutLines.some((msg) => msg.includes('Read-Only (Pull Monitoring)'))).toBe(true);
    expect(stdoutLines.some((msg) => msg.includes('read-only (pull-only) mode'))).toBe(true);
    expect(stdoutLines.some((msg) => msg.includes('LIVESYNC_MODE=write'))).toBe(true);
  });

  it('rejects LIVESYNC_WRITE=true env var with error when no active write grant exists', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    // Pass write via config (simulating LIVESYNC_WRITE=true in env) but NOT via CLI options.write
    // The daemon should still detect write intent from config.cli.write and fail with a clear error.
    const envConfigPath = configPath.replace('config.yaml', 'config-write.yaml');
    await fs.writeFile(
      envConfigPath,
      `
remote:
  url: "http://127.0.0.1:5984"
  database: "testdb"
vault:
  path: "${vaultDir}"
state:
  path: "${stateDbPath}"
cli:
  write: true
`
    );

    const exitCode = await runDaemonCommand({
      configPath: envConfigPath,
      write: false, // CLI flag NOT set — should still pick up write:true from config
      stdout: (msg) => stdoutLines.push(msg),
      stderr: (msg) => stderrLines.push(msg),
      registerSignalHandlers: false,
    });

    expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(stderrLines.some((msg) => msg.includes('No active write grant found'))).toBe(true);
    expect(stderrLines.some((msg) => msg.includes('FIX'))).toBe(true);
    expect(stderrLines.some((msg) => msg.includes('arm'))).toBe(true);
    // Banner should show Bidirectional mode because write was requested via config
    expect(stdoutLines.some((msg) => msg.includes('Bidirectional (Write Armed)'))).toBe(true);
  });
});
