import { EventEmitter } from 'node:events';

export interface RemoteChangeEvent {
  readonly docId: string;
  readonly rev: string;
  readonly seq: string;
  readonly deleted: boolean;
  readonly timestamp: number;
}

export interface ChangesConsumerOptions {
  readonly couchDbUrl: string | URL;
  readonly databaseName: string;
  readonly since?: string;
  readonly authHeader?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly heartbeatMs?: number;
  readonly timeoutMs?: number;
  readonly onEvent?: (event: RemoteChangeEvent) => void;
  readonly onError?: (error: unknown) => void;
}

export class ChangesConsumer extends EventEmitter {
  private readonly baseUrl: URL;
  private readonly databaseName: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly authHeader?: string;
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly onEventCallback?: (event: RemoteChangeEvent) => void;
  private readonly onErrorCallback?: (error: unknown) => void;

  private abortController: AbortController | null = null;
  private isRunning = false;
  private currentSeq: string;

  constructor(options: ChangesConsumerOptions) {
    super();
    this.baseUrl = new URL(options.couchDbUrl.toString());
    this.databaseName = options.databaseName;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.authHeader = options.authHeader;
    this.heartbeatMs = options.heartbeatMs ?? 25000;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.currentSeq = options.since ?? '0';
    this.onEventCallback = options.onEvent;
    this.onErrorCallback = options.onError;
  }

  getCurrentSeq(): string {
    return this.currentSeq;
  }

  setSince(seq: string): void {
    this.currentSeq = seq;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    const targetUrl = new URL(`/${encodeURIComponent(this.databaseName)}/_changes`, this.baseUrl);
    targetUrl.searchParams.set('feed', 'continuous');
    targetUrl.searchParams.set('since', this.currentSeq);
    targetUrl.searchParams.set('heartbeat', String(this.heartbeatMs));
    targetUrl.searchParams.set('timeout', String(this.timeoutMs));

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }

    try {
      const response = await this.fetchFn(targetUrl.toString(), {
        method: 'GET',
        headers,
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`CouchDB _changes stream failed with HTTP status ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('CouchDB _changes response returned no body stream.');
      }

      this.emit('connected');

      await this.consumeStream(response.body);
    } catch (err: unknown) {
      if (this.abortController?.signal.aborted) {
        // Expected cancellation
        return;
      }
      this.isRunning = false;
      this.onErrorCallback?.(err);
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
    } finally {
      this.isRunning = false;
      this.emit('close');
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (this.isRunning) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            // Heartbeat empty line
            continue;
          }

          try {
            const rawEvent = JSON.parse(trimmed) as {
              seq?: string | number;
              id?: string;
              changes?: Array<{ rev: string }>;
              deleted?: boolean;
            };

            if (rawEvent.seq !== undefined && rawEvent.id) {
              const seqStr = String(rawEvent.seq);
              this.currentSeq = seqStr;

              // Filter out chunk and internal document IDs
              if (
                rawEvent.id.startsWith('h:') ||
                rawEvent.id.startsWith('e:') ||
                rawEvent.id.startsWith('chunk:')
              ) {
                continue;
              }

              const rev = rawEvent.changes?.[0]?.rev ?? '';
              const event: RemoteChangeEvent = {
                docId: rawEvent.id,
                rev,
                seq: seqStr,
                deleted: Boolean(rawEvent.deleted),
                timestamp: Date.now(),
              };

              this.onEventCallback?.(event);
              this.emit('change', event);
            }
          } catch {
            // Non-JSON line or trailing summary: ignore safely
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async close(): Promise<void> {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
