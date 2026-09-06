import { EventEmitter } from 'node:events';
import type { InvalidationHint } from './fs-watcher.js';

export interface FileWorkerPoolOptions {
  readonly concurrency?: number;
  readonly maxQueueSize?: number;
  readonly workerFn: (hint: InvalidationHint) => Promise<void>;
  readonly onOverflow?: () => void;
  readonly onError?: (path: string, error: unknown) => void;
}

export class FileWorkerPool extends EventEmitter {
  private readonly concurrency: number;
  private readonly maxQueueSize: number;
  private readonly workerFn: (hint: InvalidationHint) => Promise<void>;
  private readonly onOverflowCallback?: () => void;
  private readonly onErrorCallback?: (path: string, error: unknown) => void;

  private readonly pendingQueue: InvalidationHint[] = [];
  private readonly activePaths = new Set<string>();
  private readonly dirtyPaths = new Map<string, InvalidationHint>();
  private isPaused = false;
  private drainResolvers: Array<() => void> = [];

  constructor(options: FileWorkerPoolOptions) {
    super();
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? 10000);
    this.workerFn = options.workerFn;
    this.onOverflowCallback = options.onOverflow;
    this.onErrorCallback = options.onError;
  }

  enqueue(hint: InvalidationHint): boolean {
    if (this.pendingQueue.length >= this.maxQueueSize) {
      this.onOverflowCallback?.();
      this.emit('overflow');
      return false;
    }

    if (this.activePaths.has(hint.path)) {
      // Path is currently executing: record as dirty so it re-runs once finished
      this.dirtyPaths.set(hint.path, hint);
      return true;
    }

    // Check if path is already in pending queue; if so, replace with newer hint
    const existingIndex = this.pendingQueue.findIndex((item) => item.path === hint.path);
    if (existingIndex >= 0) {
      this.pendingQueue[existingIndex] = hint;
    } else {
      this.pendingQueue.push(hint);
    }

    this.pump();
    return true;
  }

  private pump(): void {
    if (this.isPaused) {
      return;
    }

    while (this.activePaths.size < this.concurrency && this.pendingQueue.length > 0) {
      const hint = this.pendingQueue.shift();
      if (!hint) {
        break;
      }

      if (this.activePaths.has(hint.path)) {
        this.dirtyPaths.set(hint.path, hint);
        continue;
      }

      this.activePaths.add(hint.path);
      this.executeWorker(hint);
    }
  }

  private executeWorker(initialHint: InvalidationHint): void {
    (async () => {
      let currentHint = initialHint;
      try {
        while (true) {
          await this.workerFn(currentHint);

          // Check if dirty hint arrived while busy
          const dirtyHint = this.dirtyPaths.get(currentHint.path);
          if (dirtyHint) {
            this.dirtyPaths.delete(currentHint.path);
            currentHint = dirtyHint;
          } else {
            break;
          }
        }
      } catch (err: unknown) {
        this.onErrorCallback?.(currentHint.path, err);
        if (this.listenerCount('error') > 0) {
          this.emit('error', { path: currentHint.path, error: err });
        }
      } finally {
        this.activePaths.delete(currentHint.path);
        this.pump();
        this.checkDrain();
      }
    })();
  }

  private checkDrain(): void {
    if (this.isIdle() && this.drainResolvers.length > 0) {
      const resolvers = [...this.drainResolvers];
      this.drainResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
      this.emit('drain');
    }
  }

  isIdle(): boolean {
    return (
      this.pendingQueue.length === 0 &&
      this.activePaths.size === 0 &&
      this.dirtyPaths.size === 0
    );
  }

  getActiveCount(): number {
    return this.activePaths.size;
  }

  getPendingCount(): number {
    return this.pendingQueue.length + this.dirtyPaths.size;
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
    this.pump();
  }

  clear(): void {
    this.pendingQueue.length = 0;
    this.dirtyPaths.clear();
  }

  async drain(timeoutMs = 10000): Promise<void> {
    if (this.isIdle()) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.drainResolvers.indexOf(resolve);
        if (index >= 0) {
          this.drainResolvers.splice(index, 1);
        }
        reject(new Error(`FileWorkerPool drain timed out after ${timeoutMs}ms with ${this.getActiveCount()} active tasks remaining.`));
      }, timeoutMs);

      this.drainResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
