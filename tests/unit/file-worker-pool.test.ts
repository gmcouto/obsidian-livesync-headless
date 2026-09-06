import { describe, it, expect, vi } from 'vitest';
import { FileWorkerPool } from '../../src/daemon/file-worker-pool.js';
import type { InvalidationHint } from '../../src/daemon/fs-watcher.js';

describe('FileWorkerPool', () => {
  it('executes tasks for distinct paths concurrently up to concurrency limit', async () => {
    let maxObservedConcurrency = 0;
    let active = 0;

    const workerFn = async () => {
      active++;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active--;
    };

    const pool = new FileWorkerPool({
      concurrency: 3,
      workerFn,
    });

    pool.enqueue({ path: 'file1.md', source: 'local_fs', timestamp: Date.now() });
    pool.enqueue({ path: 'file2.md', source: 'local_fs', timestamp: Date.now() });
    pool.enqueue({ path: 'file3.md', source: 'local_fs', timestamp: Date.now() });
    pool.enqueue({ path: 'file4.md', source: 'local_fs', timestamp: Date.now() });

    await pool.drain();

    expect(maxObservedConcurrency).toBe(3);
    expect(pool.isIdle()).toBe(true);
  });

  it('serializes tasks on the same path and re-runs once if dirty hint arrived while busy', async () => {
    const executionLog: string[] = [];

    const workerFn = async (hint: InvalidationHint) => {
      executionLog.push(`start-${hint.path}-${hint.timestamp}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      executionLog.push(`end-${hint.path}-${hint.timestamp}`);
    };

    const pool = new FileWorkerPool({
      concurrency: 4,
      workerFn,
    });

    pool.enqueue({ path: 'same.md', source: 'local_fs', timestamp: 1 });
    // Enqueue second and third hint for same path while first is running
    await new Promise((resolve) => setTimeout(resolve, 10));
    pool.enqueue({ path: 'same.md', source: 'local_fs', timestamp: 2 });
    pool.enqueue({ path: 'same.md', source: 'local_fs', timestamp: 3 });

    await pool.drain();

    // First ran with ts: 1, then dirty ran with newest ts: 3
    expect(executionLog).toEqual([
      'start-same.md-1',
      'end-same.md-1',
      'start-same.md-3',
      'end-same.md-3',
    ]);
  });

  it('triggers onOverflow callback when queue reaches max capacity', async () => {
    let overflowCalled = false;
    const pool = new FileWorkerPool({
      concurrency: 1,
      maxQueueSize: 2,
      workerFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      onOverflow: () => {
        overflowCalled = true;
      },
    });

    pool.enqueue({ path: 'p1.md', source: 'local_fs', timestamp: 1 }); // Active
    pool.enqueue({ path: 'p2.md', source: 'local_fs', timestamp: 2 }); // Queue slot 1
    pool.enqueue({ path: 'p3.md', source: 'local_fs', timestamp: 3 }); // Queue slot 2 (full)
    const admitted = pool.enqueue({ path: 'p4.md', source: 'local_fs', timestamp: 4 }); // Overflow

    expect(admitted).toBe(false);
    expect(overflowCalled).toBe(true);

    await pool.drain();
  });

  it('handles worker errors without crashing pool', async () => {
    let caughtError: unknown = null;
    const pool = new FileWorkerPool({
      concurrency: 2,
      workerFn: async (hint) => {
        if (hint.path === 'error.md') {
          throw new Error('Fatal task error');
        }
      },
      onError: (_p, err) => {
        caughtError = err;
      },
    });

    pool.enqueue({ path: 'error.md', source: 'local_fs', timestamp: 1 });
    pool.enqueue({ path: 'ok.md', source: 'local_fs', timestamp: 2 });

    await pool.drain();

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe('Fatal task error');
    expect(pool.isIdle()).toBe(true);
  });
});
