import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {
  assertSafeVaultRelativePath,
  findCaseFoldCollisions,
  isReservedOrIgnoredPath,
} from '../../src/domain/path-policy.js';

describe('vault-relative path policy', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'livesync-path-policy-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects traversal, absolute, drive-letter, and backslash paths', () => {
    expect(() => assertSafeVaultRelativePath('../escape')).toThrow();
    expect(() => assertSafeVaultRelativePath('/etc/passwd')).toThrow();
    expect(() => assertSafeVaultRelativePath('C:\\windows')).toThrow();
    expect(() => assertSafeVaultRelativePath('.hidden/../x')).toThrow();
    void tempDir;
  });

  it('treats reserved LiveSync flag names and livesync_log_ prefixes as ignored', () => {
    expect(isReservedOrIgnoredPath('redflag.md')).toBe(true);
    expect(isReservedOrIgnoredPath('redflag2.md')).toBe(true);
    expect(isReservedOrIgnoredPath('redflag3.md')).toBe(true);
    expect(isReservedOrIgnoredPath('flag_rebuild.md')).toBe(true);
    expect(isReservedOrIgnoredPath('flag_fetch.md')).toBe(true);
    expect(isReservedOrIgnoredPath('livesync_log_test.md')).toBe(true);
    expect(isReservedOrIgnoredPath('Welcome.md')).toBe(false);
    expect(isReservedOrIgnoredPath('folder/note.md')).toBe(false);
  });

  it('finds case-fold collision pairs when caseInsensitive is true', () => {
    const collisions = findCaseFoldCollisions(['A.md', 'a.md', 'Welcome.md'], true);
    expect(collisions).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['A.md', 'a.md']),
      ])
    );
    expect(findCaseFoldCollisions(['A.md', 'a.md'], false)).toEqual([]);
  });

  it('accepts valid vault-relative notes', () => {
    expect(assertSafeVaultRelativePath('Welcome.md')).toBe('Welcome.md');
    expect(assertSafeVaultRelativePath('folder/note.md')).toBe('folder/note.md');
  });
});
