import type { ContinuousEngine } from './continuous-engine.js';

export interface ShutdownHandlerOptions {
  readonly engine: ContinuousEngine;
  readonly drainTimeoutMs?: number;
  readonly logger?: (message: string) => void;
  readonly onShutdownComplete?: (exitCode: number) => void;
  readonly exitFn?: (code: number) => void;
}

export class ShutdownHandler {
  private readonly engine: ContinuousEngine;
  private readonly drainTimeoutMs: number;
  private readonly logger: (message: string) => void;
  private readonly onShutdownComplete?: (exitCode: number) => void;
  private readonly exitFn: (code: number) => void;

  private isShuttingDown = false;
  private sigintListener: (() => void) | null = null;
  private sigtermListener: (() => void) | null = null;

  constructor(options: ShutdownHandlerOptions) {
    this.engine = options.engine;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 10000;
    this.logger = options.logger ?? ((msg) => process.stderr.write(`${msg}\n`));
    this.onShutdownComplete = options.onShutdownComplete;
    this.exitFn = options.exitFn ?? ((code) => process.exit(code));
  }

  registerSignalHandlers(): void {
    if (this.sigintListener || this.sigtermListener) {
      return;
    }

    this.sigintListener = () => {
      this.handleSignal('SIGINT').catch((err) => {
        this.logger(`Shutdown error on SIGINT: ${(err as Error).message}`);
        this.exitFn(1);
      });
    };

    this.sigtermListener = () => {
      this.handleSignal('SIGTERM').catch((err) => {
        this.logger(`Shutdown error on SIGTERM: ${(err as Error).message}`);
        this.exitFn(1);
      });
    };

    process.on('SIGINT', this.sigintListener);
    process.on('SIGTERM', this.sigtermListener);
  }

  unregisterSignalHandlers(): void {
    if (this.sigintListener) {
      process.removeListener('SIGINT', this.sigintListener);
      this.sigintListener = null;
    }
    if (this.sigtermListener) {
      process.removeListener('SIGTERM', this.sigtermListener);
      this.sigtermListener = null;
    }
  }

  async handleSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
    if (this.isShuttingDown) {
      this.logger(`Received second ${signal} — forcing immediate process termination.`);
      this.exitFn(1);
      return;
    }

    this.isShuttingDown = true;
    this.logger(`Received ${signal}, initiating graceful shutdown (drain timeout: ${this.drainTimeoutMs}ms)...`);

    try {
      await this.engine.stop(this.drainTimeoutMs);
      this.logger('Graceful shutdown completed successfully.');

      if (this.onShutdownComplete) {
        this.onShutdownComplete(0);
      } else {
        this.exitFn(0);
      }
    } catch (err: unknown) {
      this.logger(`Shutdown completed with error: ${(err as Error).message}`);
      if (this.onShutdownComplete) {
        this.onShutdownComplete(1);
      } else {
        this.exitFn(1);
      }
    } finally {
      this.unregisterSignalHandlers();
    }
  }
}
