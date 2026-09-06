import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReconnectionManager } from '../../src/daemon/reconnection-manager.js';

describe('ReconnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calculates jittered exponential backoff within bounds', () => {
    const manager = new ReconnectionManager({
      baseDelayMs: 1000,
      maxDelayMs: 16000,
      jitterFactor: 0.2,
    });

    // attempt 0: base 1000, +/- 20% -> 800..1200, bounded by [base, max] -> [1000, 1200]
    for (let i = 0; i < 20; i++) {
      const delay = manager.calculateDelay(0);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1200);
    }

    // attempt 1: base 2000, +/- 20% -> 1600..2400
    for (let i = 0; i < 20; i++) {
      const delay = manager.calculateDelay(1);
      expect(delay).toBeGreaterThanOrEqual(1600);
      expect(delay).toBeLessThanOrEqual(2400);
    }

    // attempt 2: base 4000, +/- 20% -> 3200..4800
    for (let i = 0; i < 20; i++) {
      const delay = manager.calculateDelay(2);
      expect(delay).toBeGreaterThanOrEqual(3200);
      expect(delay).toBeLessThanOrEqual(4800);
    }
  });

  it('caps delay at maxDelayMs regardless of high attempt count', () => {
    const manager = new ReconnectionManager({
      baseDelayMs: 500,
      maxDelayMs: 5000,
      jitterFactor: 0.25,
    });

    for (let attempt = 10; attempt < 20; attempt++) {
      const delay = manager.calculateDelay(attempt);
      expect(delay).toBeLessThanOrEqual(5000);
      expect(delay).toBeGreaterThanOrEqual(3750);
    }
  });

  it('increments attempt count on getNextDelay and resets on recordSuccess', () => {
    const manager = new ReconnectionManager({
      baseDelayMs: 500,
    });

    expect(manager.getAttempt()).toBe(0);
    manager.getNextDelay();
    expect(manager.getAttempt()).toBe(1);
    manager.getNextDelay();
    expect(manager.getAttempt()).toBe(2);

    manager.recordSuccess();
    expect(manager.getAttempt()).toBe(0);
  });

  it('schedules retry action and executes after delay', async () => {
    const manager = new ReconnectionManager({
      baseDelayMs: 1000,
      maxDelayMs: 1000,
      jitterFactor: 0,
    });

    let executed = false;
    const retryPromise = manager.scheduleRetry(() => {
      executed = true;
      return 'success';
    });

    expect(executed).toBe(false);

    // Fast-forward timer by 1000ms
    await vi.advanceTimersByTimeAsync(1000);

    const result = await retryPromise;
    expect(executed).toBe(true);
    expect(result).toBe('success');
  });

  it('aborts retry cleanly when AbortSignal fires', async () => {
    const manager = new ReconnectionManager({
      baseDelayMs: 5000,
      maxDelayMs: 5000,
      jitterFactor: 0,
    });

    const controller = new AbortController();
    let executed = false;

    const retryPromise = manager.scheduleRetry(() => {
      executed = true;
    }, controller.signal);

    // Advance 1000ms, then abort
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();

    await expect(retryPromise).rejects.toThrow('Retry operation aborted');
    expect(executed).toBe(false);
  });
});
