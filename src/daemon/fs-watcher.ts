import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as chokidar from 'chokidar';
import { isReservedOrIgnoredPath } from '../domain/path-policy.js';

export interface InvalidationHint {
  readonly path: string;
  readonly source: 'local_fs' | 'remote_changes' | 'periodic_scan' | 'retry';
  readonly remoteSeq?: string;
  readonly timestamp: number;
}

export interface FsWatcherOptions {
  readonly vaultRoot: string;
  readonly debounceMs?: number;
  readonly onInvalidation?: (hint: InvalidationHint) => void;
  readonly ignored?: (string | RegExp | ((path: string) => boolean))[];
}

const DEFAULT_DEBOUNCE_MS = 300;

export class FsWatcher extends EventEmitter {
  private readonly vaultRoot: string;
  private readonly debounceMs: number;
  private readonly onInvalidationCallback?: (hint: InvalidationHint) => void;
  private watcher: chokidar.FSWatcher | null = null;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private isClosed = false;

  constructor(options: FsWatcherOptions) {
    super();
    this.vaultRoot = path.resolve(options.vaultRoot);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onInvalidationCallback = options.onInvalidation;
  }

  async start(): Promise<void> {
    if (this.watcher || this.isClosed) {
      return;
    }

    const defaultIgnored = [
      /(^|[/\\])\.obsidian-livesync-state([/\\]|$)/,
      /(^|[/\\])\.git([/\\]|$)/,
      /(^|[/\\])\.ols-tmp-/,
      /(^|[/\\])\.DS_Store$/,
      /(^|[/\\])thumbs\.db$/i,
      /\.swp$/i,
      /\.tmp$/i,
      /~$/,
    ];

    this.watcher = chokidar.watch(this.vaultRoot, {
      ignored: defaultIgnored,
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      awaitWriteFinish: false,
    });

    this.watcher.on('add', (filePath: string) => this.handleFsEvent(filePath));
    this.watcher.on('change', (filePath: string) => this.handleFsEvent(filePath));
    this.watcher.on('unlink', (filePath: string) => this.handleFsEvent(filePath));
    this.watcher.on('error', (error: unknown) => {
      this.emit('error', error);
    });

    await new Promise<void>((resolve) => {
      this.watcher?.once('ready', () => {
        resolve();
      });
    });
  }

  private handleFsEvent(rawPath: string): void {
    if (this.isClosed) {
      return;
    }

    const resolved = path.resolve(rawPath);
    let relative = path.relative(this.vaultRoot, resolved);

    // Normalize to forward slashes
    relative = relative.split(path.sep).join('/');

    // Ignore if outside vault root or empty
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return;
    }

    // Ignore internal or reserved paths
    if (this.isIgnoredPath(relative)) {
      return;
    }

    this.scheduleDebouncedHint(relative);
  }

  private isIgnoredPath(relativePath: string): boolean {
    const parts = relativePath.split('/');
    for (const part of parts) {
      if (
        part === '.obsidian-livesync-state' ||
        part === '.git' ||
        part.startsWith('.ols-tmp-') ||
        part === '.DS_Store' ||
        part.toLowerCase() === 'thumbs.db' ||
        part.endsWith('.swp') ||
        part.endsWith('.tmp') ||
        part.endsWith('~')
      ) {
        return true;
      }
    }

    return isReservedOrIgnoredPath(relativePath);
  }

  private scheduleDebouncedHint(relativePath: string): void {
    const existingTimer = this.debounceTimers.get(relativePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(relativePath);
      if (this.isClosed) {
        return;
      }

      const hint: InvalidationHint = {
        path: relativePath,
        source: 'local_fs',
        timestamp: Date.now(),
      };

      if (this.onInvalidationCallback) {
        try {
          this.onInvalidationCallback(hint);
        } catch (err) {
          this.emit('error', err);
        }
      }

      this.emit('invalidation', hint);
    }, this.debounceMs);

    this.debounceTimers.set(relativePath, timer);
  }

  getPendingCount(): number {
    return this.debounceTimers.size;
  }

  async close(): Promise<void> {
    this.isClosed = true;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
