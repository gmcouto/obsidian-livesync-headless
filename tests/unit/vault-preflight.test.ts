import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { preflightVault } from '../../src/filesystem/vault-preflight.js';

describe('vault preflight', () => {
  let tempDir: string;
  let vaultPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'livesync-vault-preflight-'));
    vaultPath = path.join(tempDir, 'vault');
    await fs.mkdir(vaultPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('accepts an empty vault when dedicated is false', async () => {
    const result = await preflightVault(vaultPath, false, () => []);
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  it('fails when dedicated is false and the vault contains any file', async () => {
    await fs.writeFile(path.join(vaultPath, 'existing.md'), 'local');
    const result = await preflightVault(vaultPath, false, () => []);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('VAULT_NOT_EMPTY');
  });

  it('blocks an existing file without a provenance row when dedicated is true', async () => {
    await fs.writeFile(path.join(vaultPath, 'unproven.md'), 'do-not-overwrite');
    const result = await preflightVault(vaultPath, true, () => []);
    expect(result.ok).toBe(false);
    expect(result.blocks.some((block) => block.path === 'unproven.md')).toBe(true);
    const body = await fs.readFile(path.join(vaultPath, 'unproven.md'), 'utf8');
    expect(body).toBe('do-not-overwrite');
  });

  it('allows an existing file that already has a provenance row when dedicated is true', async () => {
    await fs.writeFile(path.join(vaultPath, 'known.md'), 'proven');
    const result = await preflightVault(vaultPath, true, () => ['known.md']);
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  it('fails when a vault entry is a symlink', async () => {
    const target = path.join(tempDir, 'outside.md');
    await fs.writeFile(target, 'secret');
    await fs.symlink(target, path.join(vaultPath, 'link.md'));
    const result = await preflightVault(vaultPath, false, () => []);
    expect(result.ok).toBe(false);
    expect(result.code.toLowerCase()).toMatch(/symlink|unsafe/);
  });
});
