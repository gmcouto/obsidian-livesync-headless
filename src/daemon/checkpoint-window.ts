import type { CheckpointRepository } from '../storage/checkpoint-repo.js';

export type SequenceState = 'pending' | 'completed' | 'failed';

export interface TrackedSequence {
  readonly seq: string;
  state: SequenceState;
  error?: unknown;
}

export class CheckpointWindow {
  private readonly sequenceQueue: TrackedSequence[] = [];
  private readonly sequenceMap = new Map<string, TrackedSequence>();

  trackSequence(seq: string): void {
    if (this.sequenceMap.has(seq)) {
      return;
    }

    const item: TrackedSequence = {
      seq,
      state: 'pending',
    };

    this.sequenceQueue.push(item);
    this.sequenceMap.set(seq, item);
  }

  markCompleted(seq: string): void {
    const item = this.sequenceMap.get(seq);
    if (item) {
      item.state = 'completed';
      delete item.error;
    }
  }

  markFailed(seq: string, error?: unknown): void {
    const item = this.sequenceMap.get(seq);
    if (item) {
      item.state = 'failed';
      item.error = error;
    }
  }

  getContiguousCommitSequence(): string | null {
    let highestContiguous: string | null = null;

    for (const item of this.sequenceQueue) {
      if (item.state === 'completed') {
        highestContiguous = item.seq;
      } else {
        // First non-completed item halts contiguous sequence progression
        break;
      }
    }

    return highestContiguous;
  }

  commit(checkpointRepo: CheckpointRepository, remoteFingerprint: string): string | null {
    const commitSeq = this.getContiguousCommitSequence();
    if (!commitSeq) {
      return null;
    }

    checkpointRepo.saveCheckpoint({
      remoteFingerprint,
      lastUpdateSeq: commitSeq,
      completedAt: new Date().toISOString(),
    });

    // Purge entries up to and including commitSeq
    const commitIndex = this.sequenceQueue.findIndex((item) => item.seq === commitSeq);
    if (commitIndex >= 0) {
      const removed = this.sequenceQueue.splice(0, commitIndex + 1);
      for (const item of removed) {
        this.sequenceMap.delete(item.seq);
      }
    }

    return commitSeq;
  }

  getPendingCount(): number {
    return this.sequenceQueue.filter((item) => item.state === 'pending').length;
  }

  hasFailures(): boolean {
    return this.sequenceQueue.some((item) => item.state === 'failed');
  }

  getQueueSize(): number {
    return this.sequenceQueue.length;
  }

  reset(): void {
    this.sequenceQueue.length = 0;
    this.sequenceMap.clear();
  }
}
