import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { VaultScanner } from '../../src/filesystem/vault-scanner.js';

describe('VaultScanner', () => {
  let tempDir: string;
  let scanner: VaultScanner;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-scanner-test-'));
    scanner = new VaultScanner();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('recursively scans vault files and calculates correct SHA-256 hashes', async () => {
    await fs.mkdir(path.join(tempDir, 'Folder/Subfolder'), { recursive: true });

    const note1Content = 'Hello world from Note 1';
    const note1Hash = crypto.createHash('sha256').update(note1Content).digest('hex');
    await fs.writeFile(path.join(tempDir, 'RootNote.md'), note1Content);

    const note2Content = 'Nested file content';
    const note2Hash = crypto.createHash('sha256').update(note2Content).digest('hex');
    await fs.writeFile(path.join(tempDir, 'Folder/Subfolder/DeepNote.md'), note2Content);

    const files = await scanner.scanVault(tempDir);

    expect(files.size).toBe(2);

    const rootEntry = files.get('RootNote.md');
    expect(rootEntry).toBeDefined();
    expect(rootEntry?.contentSha256).toBe(note1Hash);
    expect(rootEntry?.size).toBe(Buffer.byteLength(note1Content));

    const deepEntry = files.get('Folder/Subfolder/DeepNote.md');
    expect(deepEntry).toBeDefined();
    expect(deepEntry?.contentSha256).toBe(note2Hash);
  });

  it('skips hidden directories (.obsidian, .git, .trash) and ignored files', async () => {
    await fs.mkdir(path.join(tempDir, '.obsidian/plugins'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.obsidian/app.json'), '{"theme":"dark"}');

    await fs.mkdir(path.join(tempDir, '.trash'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.trash/Deleted.md'), 'deleted');

    await fs.writeFile(path.join(tempDir, '.DS_Store'), 'ignored');
    await fs.writeFile(path.join(tempDir, 'Valid.md'), 'valid note');

    const files = await scanner.scanVault(tempDir);

    expect(files.size).toBe(1);
    expect(files.has('Valid.md')).toBe(true);
    expect(files.has('.obsidian/app.json')).toBe(false);
    expect(files.has('.trash/Deleted.md')).toBe(false);
    expect(files.has('.DS_Store')).toBe(false);
  });
});
