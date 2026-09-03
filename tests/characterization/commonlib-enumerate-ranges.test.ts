import { describe, it, expect } from 'vitest';
import {
  PREFIX_CHUNK,
  PREFIX_ENCRYPTED_CHUNK,
  PREFIX_OBFUSCATED,
} from '@vrtmrz/livesync-commonlib/compat/common/types';
import { classifyDocumentId, isReservedChunkId } from '../../src/livesync/decode-adapter.js';

describe('Commonlib reserved-id enumerate ranges (0.1.21)', () => {
  it('classifies h: and h:+ prefixes as chunks, matching DFM skip ranges', () => {
    expect(PREFIX_CHUNK).toBe('h:');
    expect(PREFIX_ENCRYPTED_CHUNK).toBe('h:+');
    expect(PREFIX_OBFUSCATED).toBe('f:');

    expect(classifyDocumentId(`${PREFIX_CHUNK}deadbeef`)).toBe('chunk');
    expect(classifyDocumentId(`${PREFIX_ENCRYPTED_CHUNK}deadbeef`)).toBe('chunk');
    expect(isReservedChunkId(`${PREFIX_CHUNK}x`)).toBe(true);
    expect(isReservedChunkId(`${PREFIX_ENCRYPTED_CHUNK}x`)).toBe(true);
  });

  it('does not treat f: obfuscated note ids as chunks', () => {
    expect(classifyDocumentId(`${PREFIX_OBFUSCATED}abcdef`)).not.toBe('chunk');
    expect(isReservedChunkId(`${PREFIX_OBFUSCATED}abcdef`)).toBe(false);
  });

  it('never calls Commonlib enumerate() — skip ranges are prefix classification only', () => {
    expect(typeof classifyDocumentId).toBe('function');
    expect(classifyDocumentId('Welcome.md')).not.toBe('chunk');
  });
});
