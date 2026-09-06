import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FsWatcher, InvalidationHint } from '../../src/daemon/fs-watcher.js';

describe('FsWatcher', () => {
  let tmpVault: string;
  let watcher: FsWatcher | null = null;

  beforeEach(async () => {
    tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'ols-watcher-test-'));
    await fs.mkdir(path.join(tmpVault, 'folder'), { recursive: true });
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    await fs.rm(tmpVault, { recursive: true, force: true });
  });

  it('watches local vault directory and emits invalidation hint on file addition', async () => {
    const hints: InvalidationHint[] = [];
    watcher = new FsWatcher({
      vaultRoot: tmpVault,
      debounceMs: 50,
      onInvalidation: (hint) => hints.push(hint),
    });

    await watcher.start();

    const targetFile = path.join(tmpVault, 'folder', 'note.md');
    await fs.writeFile(targetFile, 'Hello world');

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(hints.length).toBe(1);
    expect(hints[0].path).toBe('folder/note.md');
    expect(hints[0].source).toBe('local_fs');
    expect(hints[0].timestamp).toBeGreaterThan(0);
  });

  it('coalesces rapid burst events on the same path into a single hint (trailing debounce)', async () => {
    const hints: InvalidationHint[] = [];
    watcher = new FsWatcher({
      vaultRoot: tmpVault,
      debounceMs: 100,
      onInvalidation: (hint) => hints.push(hint),
    });

    await watcher.start();

    const targetFile = path.join(tmpVault, 'burst.md');

    // Simulate rapid burst writes
    await fs.writeFile(targetFile, 'v1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.writeFile(targetFile, 'v2');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.writeFile(targetFile, 'v3');

    // Before debounce finishes
    expect(hints.length).toBe(0);

    // Wait for trailing debounce to expire
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(hints.length).toBe(1);
    expect(hints[0].path).toBe('burst.md');
  });

  it('filters internal and temporary files from emitting invalidation hints', async () => {
    const hints: InvalidationHint[] = [];
    watcher = new FsWatcher({
      vaultRoot: tmpVault,
      debounceMs: 50,
      onInvalidation: (hint) => hints.push(hint),
    });

    await watcher.start();

    // Internal state dir
    const stateDir = path.join(tmpVault, '.obsidian-livesync-state');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'state.sqlite'), 'sqlite-data');

    // Git dir
    const gitDir = path.join(tmpVault, '.git');
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main');

    // Temporary swap files
    await fs.writeFile(path.join(tmpVault, '.ols-tmp-12345'), 'tmp data');
    await fs.writeFile(path.join(tmpVault, 'note.md.swp'), 'swap data');
    await fs.writeFile(path.join(tmpVault, 'note.md.tmp'), 'tmp data');
    await fs.writeFile(path.join(tmpVault, 'note.md~'), 'backup data');
    await fs.writeFile(path.join(tmpVault, '.DS_Store'), 'ds store');
    await fs.writeFile(path.join(tmpVault, 'thumbs.db'), 'thumbs db');

    // Valid file
    await fs.writeFile(path.join(tmpVault, 'valid.md'), '# Valid');

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(hints.length).toBe(1);
    expect(hints[0].path).toBe('valid.md');
  });

  it('emits invalidation hint when a file is unlinked', async () => {
    const targetFile = path.join(tmpVault, 'to-delete.md');
    await fs.writeFile(targetFile, 'to delete');

    const hints: InvalidationHint[] = [];
    watcher = new FsWatcher({
      vaultRoot: tmpVault,
      debounceMs: 50,
      onInvalidation: (hint) => hints.push(hint),
    });

    await watcher.start();

    await fs.unlink(targetFile);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(hints.length).toBe(1);
    expect(hints[0].path).toBe('to-delete.md');
  });

  it('clears all pending timers and stops emitting when closed', async () => {
    const hints: InvalidationHint[] = [];
    watcher = new FsWatcher({
      vaultRoot: tmpVault,
      debounceMs: 200,
      onInvalidation: (hint) => hints.push(hint),
    });

    await watcher.start();

    const targetFile = path.join(tmpVault, 'cancelled.md');
    await fs.writeFile(targetFile, 'cancelled');

    // Close before debounce timer fires
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(watcher.getPendingCount()).toBeGreaterThan(0);

    await watcher.close();
    expect(watcher.getPendingCount()).toBe(0);

    // Wait past original debounce time
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hints.length).toBe(0);
  });

  it('handles atomic rename/swap (create tmp file and rename over target) emitting hint for target only', async () => {
    const hints: InvalidationHint[] = [];
    watcher = new FsWatcher({
      vaultRoot: tmpVault,
      debounceMs: 50,
      onInvalidation: (hint) => hints.push(hint),
    });

    await watcher.start();

    const targetPath = path.join(tmpVault, 'document.md');
    const tmpPath = path.join(tmpVault, '.ols-tmp-swap-1234');

    // Simulate atomic editor save
    await fs.writeFile(tmpPath, 'atomic content');
    await fs.rename(tmpPath, targetPath);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // The .ols-tmp-* file was ignored, only document.md is reported
    expect(hints.length).toBe(1);
    expect(hints[0].path).toBe('document.md');
  });
});

