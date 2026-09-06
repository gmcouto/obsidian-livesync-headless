import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShutdownHandler } from '../../src/daemon/shutdown-handler.js';
import type { ContinuousEngine } from '../../src/daemon/continuous-engine.js';

describe('ShutdownHandler', () => {
  let mockEngine: ContinuousEngine;
  let exitCodes: number[];
  let logMessages: string[];

  beforeEach(() => {
    exitCodes = [];
    logMessages = [];
    mockEngine = {
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContinuousEngine;
  });

  it('coordinates graceful shutdown and exits with code 0 on first signal', async () => {
    const handler = new ShutdownHandler({
      engine: mockEngine,
      drainTimeoutMs: 5000,
      logger: (msg) => logMessages.push(msg),
      exitFn: (code) => exitCodes.push(code),
    });

    await handler.handleSignal('SIGINT');

    expect(mockEngine.stop).toHaveBeenCalledWith(5000);
    expect(exitCodes).toEqual([0]);
    expect(logMessages.some((m) => m.includes('initiating graceful shutdown'))).toBe(true);
    expect(logMessages.some((m) => m.includes('completed successfully'))).toBe(true);
  });

  it('forces immediate termination with code 1 if second signal is received during shutdown', async () => {
    let resolveStop: () => void;
    mockEngine.stop = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStop = resolve;
      })
    );

    const handler = new ShutdownHandler({
      engine: mockEngine,
      logger: (msg) => logMessages.push(msg),
      exitFn: (code) => exitCodes.push(code),
    });

    const firstSignalPromise = handler.handleSignal('SIGTERM');

    // Send second signal while first is still awaiting stop
    await handler.handleSignal('SIGINT');

    expect(exitCodes).toContain(1);
    expect(logMessages.some((m) => m.includes('forcing immediate process termination'))).toBe(true);

    resolveStop!();
    await firstSignalPromise;
  });

  it('exits with code 1 if engine.stop throws an error', async () => {
    mockEngine.stop = vi.fn().mockRejectedValue(new Error('Drain failure'));

    const handler = new ShutdownHandler({
      engine: mockEngine,
      logger: (msg) => logMessages.push(msg),
      exitFn: (code) => exitCodes.push(code),
    });

    await handler.handleSignal('SIGINT');

    expect(exitCodes).toEqual([1]);
    expect(logMessages.some((m) => m.includes('Shutdown completed with error'))).toBe(true);
  });
});
