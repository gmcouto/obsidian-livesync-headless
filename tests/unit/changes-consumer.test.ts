import { describe, it, expect, vi } from 'vitest';
import { ChangesConsumer, RemoteChangeEvent } from '../../src/daemon/changes-consumer.js';

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

describe('ChangesConsumer', () => {
  it('parses continuous NDJSON stream across fragmented chunk boundaries and emits events', async () => {
    const events: RemoteChangeEvent[] = [];
    const chunks = [
      '{"seq":"1-g1","id":"note1.md","changes":[{"rev":"1-abc"}]}\n',
      '{"seq":"2-g2","id":"note2.md","changes":',
      '[{"rev":"1-def"}],"deleted":true}\n\n', // includes heartbeat empty line
      '{"seq":"3-g3"',
      ':"chunk:h123","changes":[{"rev":"1-xyz"}]}\n', // chunk document (filtered)
      '{"seq":"4-g4","id":"h:abcde","changes":[{"rev":"1-xyz"}]}\n', // chunk doc (filtered)
      '{"seq":"5-g5","id":"note3.md","changes":[{"rev":"2-ghi"}]}\n',
    ];

    const mockFetch: typeof globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: createMockStream(chunks),
    } as unknown as Response);

    const consumer = new ChangesConsumer({
      couchDbUrl: 'http://127.0.0.1:5984',
      databaseName: 'testdb',
      since: '0',
      fetchFn: mockFetch,
      onEvent: (e) => events.push(e),
    });

    await consumer.start();

    expect(events.length).toBe(3);

    expect(events[0]).toMatchObject({
      docId: 'note1.md',
      rev: '1-abc',
      seq: '1-g1',
      deleted: false,
    });

    expect(events[1]).toMatchObject({
      docId: 'note2.md',
      rev: '1-def',
      seq: '2-g2',
      deleted: true,
    });

    expect(events[2]).toMatchObject({
      docId: 'note3.md',
      rev: '2-ghi',
      seq: '5-g5',
      deleted: false,
    });

    expect(consumer.getCurrentSeq()).toBe('5-g5');
  });

  it('handles HTTP error responses by emitting error', async () => {
    let capturedError: unknown = null;
    const mockFetch: typeof globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      body: null,
    } as unknown as Response);

    const consumer = new ChangesConsumer({
      couchDbUrl: 'http://127.0.0.1:5984',
      databaseName: 'testdb',
      fetchFn: mockFetch,
      onError: (err) => {
        capturedError = err;
      },
    });

    await consumer.start();

    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toContain('401');
  });

  it('stops reading cleanly when close() is called', async () => {
    const encoder = new TextEncoder();
    let streamClosed = false;

    const infiniteStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (streamClosed) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode('{"seq":"1-g1","id":"note.md","changes":[{"rev":"1-abc"}]}\n')
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      cancel() {
        streamClosed = true;
      },
    });

    const mockFetch: typeof globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: infiniteStream,
    } as unknown as Response);

    const consumer = new ChangesConsumer({
      couchDbUrl: 'http://127.0.0.1:5984',
      databaseName: 'testdb',
      fetchFn: mockFetch,
    });

    const startPromise = consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 75));

    await consumer.close();
    await startPromise;

    expect(consumer.getCurrentSeq()).toBe('1-g1');
  });
});
