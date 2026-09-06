export interface ReconnectionManagerOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterFactor?: number;
}

export class ReconnectionManager {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterFactor: number;
  private attempt = 0;
  private activeTimer: NodeJS.Timeout | null = null;

  constructor(options?: ReconnectionManagerOptions) {
    this.baseDelayMs = options?.baseDelayMs ?? 500;
    this.maxDelayMs = options?.maxDelayMs ?? 30000;
    this.jitterFactor = options?.jitterFactor ?? 0.25;
  }

  getAttempt(): number {
    return this.attempt;
  }

  recordSuccess(): void {
    this.attempt = 0;
  }

  recordFailure(): void {
    this.attempt++;
  }

  calculateDelay(attempt: number): number {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, attempt));
    const jitterRange = exponential * this.jitterFactor;
    // Jitter in range [-jitterRange, +jitterRange]
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    const rawDelay = exponential + jitter;

    return Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, Math.round(rawDelay)));
  }

  getNextDelay(): number {
    const delay = this.calculateDelay(this.attempt);
    this.attempt++;
    return delay;
  }

  async scheduleRetry<T>(
    action: () => Promise<T> | T,
    signal?: AbortSignal
  ): Promise<T> {
    const delay = this.getNextDelay();

    if (signal?.aborted) {
      throw new Error('Retry aborted before timer started');
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTimer = null;
        resolve();
      }, delay);

      this.activeTimer = timer;

      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          this.activeTimer = null;
          signal.removeEventListener('abort', onAbort);
          reject(new Error('Retry operation aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    if (signal?.aborted) {
      throw new Error('Retry operation aborted');
    }

    return await action();
  }

  cancel(): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
  }
}
