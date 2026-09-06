import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/storage/sqlite.js';
import { CheckpointRepository } from '../../src/storage/checkpoint-repo.js';
import { CheckpointWindow } from '../../src/daemon/checkpoint-window.js';

describe('CheckpointWindow', () => {
  let checkpointRepo: CheckpointRepository;
  let window: CheckpointWindow;
  const peerId = 'remote-peer-fingerprint-123';

  beforeEach(() => {
    const db = openDatabase(':memory:');
    checkpointRepo = new CheckpointRepository(db);
    window = new CheckpointWindow();
  });

  it('tracks sequences and advances contiguous commit sequence on in-order completions', () => {
    window.trackSequence('1-seq');
    window.trackSequence('2-seq');
    window.trackSequence('3-seq');

    expect(window.getContiguousCommitSequence()).toBeNull();

    window.markCompleted('1-seq');
    expect(window.getContiguousCommitSequence()).toBe('1-seq');

    window.markCompleted('2-seq');
    expect(window.getContiguousCommitSequence()).toBe('2-seq');

    window.markCompleted('3-seq');
    expect(window.getContiguousCommitSequence()).toBe('3-seq');

    const committed = window.commit(checkpointRepo, peerId);
    expect(committed).toBe('3-seq');

    const saved = checkpointRepo.getCheckpoint(peerId);
    expect(saved?.lastUpdateSeq).toBe('3-seq');
    expect(window.getQueueSize()).toBe(0);
  });

  it('blocks sequence advancement on out-of-order completions until gap is resolved', () => {
    window.trackSequence('1-seq');
    window.trackSequence('2-seq');
    window.trackSequence('3-seq');

    // 1-seq and 3-seq complete, but 2-seq is still pending
    window.markCompleted('1-seq');
    window.markCompleted('3-seq');

    expect(window.getContiguousCommitSequence()).toBe('1-seq');

    // Commit advances to 1-seq
    const commit1 = window.commit(checkpointRepo, peerId);
    expect(commit1).toBe('1-seq');
    expect(checkpointRepo.getCheckpoint(peerId)?.lastUpdateSeq).toBe('1-seq');
    expect(window.getQueueSize()).toBe(2); // 2-seq and 3-seq remain

    // Now 2-seq completes
    window.markCompleted('2-seq');
    expect(window.getContiguousCommitSequence()).toBe('3-seq');

    const commit2 = window.commit(checkpointRepo, peerId);
    expect(commit2).toBe('3-seq');
    expect(checkpointRepo.getCheckpoint(peerId)?.lastUpdateSeq).toBe('3-seq');
    expect(window.getQueueSize()).toBe(0);
  });

  it('fences errors and refuses to advance past a failed sequence token', () => {
    window.trackSequence('1-seq');
    window.trackSequence('2-seq');
    window.trackSequence('3-seq');

    window.markCompleted('1-seq');
    window.markFailed('2-seq', new Error('Transfer conflict / corrupted note'));
    window.markCompleted('3-seq');

    expect(window.hasFailures()).toBe(true);
    expect(window.getContiguousCommitSequence()).toBe('1-seq');

    const committed = window.commit(checkpointRepo, peerId);
    expect(committed).toBe('1-seq');
    expect(checkpointRepo.getCheckpoint(peerId)?.lastUpdateSeq).toBe('1-seq');

    // 2-seq and 3-seq remain in queue because 2-seq failed
    expect(window.getQueueSize()).toBe(2);
    expect(window.getContiguousCommitSequence()).toBeNull();
  });
});
