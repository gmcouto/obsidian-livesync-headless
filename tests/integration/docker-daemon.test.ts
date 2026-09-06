import { describe, it, expect, beforeAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { VERSION } from '../../src/cli/index.js';

const execFileAsync = promisify(execFile);
const IMAGE_TAG = 'obsidian-livesync-headless:test';

describe('Docker Container Integration Tests (DOCKER-01, DOCKER-02, DOCKER-03)', () => {
  beforeAll(() => {
    execFileSync('docker', ['build', '-t', IMAGE_TAG, '.'], { stdio: 'pipe' });
  });

  it('verifies Docker image metadata, user, entrypoint, default CMD, volumes, and env defaults', async () => {
    const { stdout } = await execFileAsync('docker', ['inspect', IMAGE_TAG]);
    const inspectResult = JSON.parse(stdout);
    expect(Array.isArray(inspectResult)).toBe(true);
    expect(inspectResult.length).toBeGreaterThan(0);

    const config = inspectResult[0].Config;

    // Non-root default user
    expect(config.User).toBe('livesync');

    // DOCKER-03: Entrypoint and default CMD
    expect(config.Entrypoint).toEqual(['/usr/local/bin/obsidian-livesync-headless']);
    expect(config.Cmd).toEqual(['daemon']);

    // DOCKER-02: Volume mount points
    expect(config.Volumes).toHaveProperty('/vault');
    expect(config.Volumes).toHaveProperty('/data');

    // DOCKER-02: Environment defaults
    const envVars = config.Env as string[];
    expect(envVars).toContain('HOME=/home/livesync');
    expect(envVars).toContain('LIVESYNC_VAULT_PATH=/vault');
    expect(envVars).toContain('LIVESYNC_STATE_PATH=/data/state.db');
  });

  it('runs as non-root user livesync by default and supports arbitrary UID/GID rootless execution', async () => {
    // Verify default user execution
    const { stdout: defaultUserOut } = await execFileAsync('docker', [
      'run',
      '--rm',
      '--entrypoint',
      '/bin/sh',
      IMAGE_TAG,
      '-c',
      'id -u && id -un',
    ]);
    expect(defaultUserOut.trim().split('\n')).toEqual(['1000', 'livesync']);

    // Verify arbitrary UID/GID execution (rootless / custom user setup)
    const { stdout: customUserOut } = await execFileAsync('docker', [
      'run',
      '--rm',
      '--user',
      '1001:1001',
      '--entrypoint',
      '/bin/sh',
      IMAGE_TAG,
      '-c',
      'id -u; touch /vault/rootless.test /data/rootless.db && ls -la /vault/rootless.test /data/rootless.db',
    ]);
    expect(customUserOut).toContain('1001');
    expect(customUserOut).toContain('/vault/rootless.test');
    expect(customUserOut).toContain('/data/rootless.db');
  });

  it('runs --version inside container and outputs build and compatibility identity', async () => {
    const { stdout, stderr } = await execFileAsync('docker', [
      'run',
      '--rm',
      IMAGE_TAG,
      '--version',
    ]);

    expect(stdout).toContain(`v${VERSION}`);
    expect(stdout).toContain('OBSIDIAN LIVESYNC HEADLESS — BUILD & COMPATIBILITY IDENTITY');
    expect(stderr).toBe('');
  });

  it('runs inspect --help inside container and prints CLI help text', async () => {
    const { stdout } = await execFileAsync('docker', [
      'run',
      '--rm',
      IMAGE_TAG,
      'inspect',
      '--help',
    ]);

    expect(stdout).toContain('obsidian-livesync-headless [command] [options]');
    expect(stdout).toContain('daemon');
    expect(stdout).toContain('pull');
    expect(stdout).toContain('inspect');
  });

  it('executes daemon mode by default and fails predictably on unreachable host without config file', async () => {
    try {
      await execFileAsync('docker', [
        'run',
        '--rm',
        '-e',
        'LIVESYNC_COUCHDB_URL=http://invalid-couchdb-host:5984',
        '-e',
        'LIVESYNC_COUCHDB_DATABASE=testvault',
        '-e',
        'LIVESYNC_VAULT_PATH=/vault',
        '-e',
        'LIVESYNC_STATE_PATH=/data/state.db',
        IMAGE_TAG,
      ]);
      expect.fail('Expected container execution to exit with error on unreachable host');
    } catch (err: any) {
      // Container should run daemon mode, attempt CouchDB probe, and fail with network/config error (exit code 1 or 5)
      expect(err.code).toBeDefined();
      expect(err.code).not.toBe(0);
      const combinedOutput = (err.stdout || '') + (err.stderr || '');
      expect(combinedOutput).toMatch(/Obsidian LiveSync Continuous Convergence Daemon|Failed to probe remote database|ENOTFOUND|fetch failed/);
    }
  });
});
