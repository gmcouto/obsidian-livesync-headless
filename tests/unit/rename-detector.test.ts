import { describe, it, expect } from 'vitest';
import { RenameDetector } from '../../src/domain/rename-detector.js';
import type { VaultFileEntry } from '../../src/filesystem/vault-scanner.js';
import type { ProvenanceRecord } from '../../src/storage/provenance-repo.js';

describe('RenameDetector', () => {
  const detector = new RenameDetector();

  it('detects case-only rename when hash matches provenance (SYNC-05)', () => {
    const localFiles = new Map<string, VaultFileEntry>([
      [
        'notes/my-doc.md',
        {
          path: 'notes/my-doc.md',
          size: 100,
          mtime: 1000,
          contentSha256: 'hash-doc-123',
        },
      ],
    ]);

    const provenanceMap = new Map<string, ProvenanceRecord>([
      [
        'notes/MY-DOC.md',
        {
          path: 'notes/MY-DOC.md',
          remoteRevision: '1-revA',
          contentSha256: 'hash-doc-123',
          observedMtime: 900,
          remoteFingerprint: 'fp',
          reflectedAt: '2026-09-06T00:00:00Z',
        },
      ],
    ]);

    const result = detector.detectRenames(localFiles, provenanceMap);

    expect(result.caseRenames).toHaveLength(1);
    expect(result.caseRenames[0]).toEqual({
      oldPath: 'notes/MY-DOC.md',
      newPath: 'notes/my-doc.md',
      contentSha256: 'hash-doc-123',
      baseRev: '1-revA',
    });
    expect(result.crossPathRenames).toHaveLength(0);
    expect(result.consumedDeletedPaths.has('notes/MY-DOC.md')).toBe(true);
    expect(result.consumedCreatedPaths.has('notes/my-doc.md')).toBe(true);
  });

  it('detects cross-path rename when content hash matches exactly one candidate (SYNC-05)', () => {
    const localFiles = new Map<string, VaultFileEntry>([
      [
        'Archive/OldFile.md',
        {
          path: 'Archive/OldFile.md',
          size: 250,
          mtime: 2000,
          contentSha256: 'hash-moved-456',
        },
      ],
    ]);

    const provenanceMap = new Map<string, ProvenanceRecord>([
      [
        'Active/CurrentFile.md',
        {
          path: 'Active/CurrentFile.md',
          remoteRevision: '2-revB',
          contentSha256: 'hash-moved-456',
          observedMtime: 1500,
          remoteFingerprint: 'fp',
          reflectedAt: '2026-09-06T00:00:00Z',
        },
      ],
    ]);

    const result = detector.detectRenames(localFiles, provenanceMap);

    expect(result.crossPathRenames).toHaveLength(1);
    expect(result.crossPathRenames[0]).toEqual({
      oldPath: 'Active/CurrentFile.md',
      newPath: 'Archive/OldFile.md',
      contentSha256: 'hash-moved-456',
      baseRev: '2-revB',
    });
    expect(result.caseRenames).toHaveLength(0);
    expect(result.consumedDeletedPaths.has('Active/CurrentFile.md')).toBe(true);
    expect(result.consumedCreatedPaths.has('Archive/OldFile.md')).toBe(true);
  });

  it('does not infer rename if multiple created files share identical content hash', () => {
    const localFiles = new Map<string, VaultFileEntry>([
      ['Copy1.md', { path: 'Copy1.md', size: 50, mtime: 100, contentSha256: 'same-hash' }],
      ['Copy2.md', { path: 'Copy2.md', size: 50, mtime: 100, contentSha256: 'same-hash' }],
    ]);

    const provenanceMap = new Map<string, ProvenanceRecord>([
      [
        'Original.md',
        {
          path: 'Original.md',
          remoteRevision: '1-rev',
          contentSha256: 'same-hash',
          observedMtime: 50,
          remoteFingerprint: 'fp',
          reflectedAt: '2026-09-06T00:00:00Z',
        },
      ],
    ]);

    const result = detector.detectRenames(localFiles, provenanceMap);

    // Ambiguous rename is not inferred
    expect(result.caseRenames).toHaveLength(0);
    expect(result.crossPathRenames).toHaveLength(0);
    expect(result.consumedDeletedPaths.size).toBe(0);
  });
});
