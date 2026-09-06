import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/storage/sqlite.js';
import { ProvenanceRepository } from '../../src/storage/provenance-repo.js';
import { LoopSuppressor } from '../../src/daemon/loop-suppressor.js';

describe('LoopSuppressor', () => {
  let tmpVault: string;
  let provenanceRepo: ProvenanceRepository;
  let suppressor: LoopSuppressor;

  beforeEach(async () => {
    tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'ols-suppressor-test-'));
    const db = openDatabase(':memory:');
    provenanceRepo = new ProvenanceRepository(db);
    suppressor = new LoopSuppressor();
  });

  afterEach(async () => {
    await fs.rm(tmpVault, { recursive: true, force: true });
  });

  describe('Local Event Suppression', () => {
    it('suppresses local event when file content SHA-256 matches provenance', async () => {
      const relativePath = 'note.md';
      const fullPath = path.join(tmpVault, relativePath);
      const content = 'Hello world content';
      await fs.writeFile(fullPath, content);

      const hash = createHash('sha256').update(content).digest('hex');
      provenanceRepo.saveProvenance({
        path: relativePath,
        remoteRevision: '1-abc',
        contentSha256: hash,
        observedMtime: Date.now(),
        remoteFingerprint: 'fp-123',
        reflectedAt: new Date().toISOString(),
      });

      const shouldSuppress = await suppressor.shouldSuppressLocalEvent(
        tmpVault,
        relativePath,
        provenanceRepo
      );
      expect(shouldSuppress).toBe(true);
    });

    it('admits local event when file content SHA-256 differs from provenance', async () => {
      const relativePath = 'note.md';
      const fullPath = path.join(tmpVault, relativePath);
      await fs.writeFile(fullPath, 'New modified content');

      const oldHash = createHash('sha256').update('Old content').digest('hex');
      provenanceRepo.saveProvenance({
        path: relativePath,
        remoteRevision: '1-abc',
        contentSha256: oldHash,
        observedMtime: Date.now() - 10000,
        remoteFingerprint: 'fp-123',
        reflectedAt: new Date().toISOString(),
      });

      const shouldSuppress = await suppressor.shouldSuppressLocalEvent(
        tmpVault,
        relativePath,
        provenanceRepo
      );
      expect(shouldSuppress).toBe(false);
    });

    it('admits local event when file has no provenance (new local file)', async () => {
      const relativePath = 'brand-new.md';
      const fullPath = path.join(tmpVault, relativePath);
      await fs.writeFile(fullPath, 'Brand new file');

      const shouldSuppress = await suppressor.shouldSuppressLocalEvent(
        tmpVault,
        relativePath,
        provenanceRepo
      );
      expect(shouldSuppress).toBe(false);
    });

    it('admits local event when file is deleted on disk but exists in provenance (local deletion)', async () => {
      const relativePath = 'deleted.md';
      provenanceRepo.saveProvenance({
        path: relativePath,
        remoteRevision: '2-def',
        contentSha256: 'some-hash',
        observedMtime: Date.now(),
        remoteFingerprint: 'fp-123',
        reflectedAt: new Date().toISOString(),
      });

      const shouldSuppress = await suppressor.shouldSuppressLocalEvent(
        tmpVault,
        relativePath,
        provenanceRepo
      );
      expect(shouldSuppress).toBe(false);
    });

    it('suppresses local event when file is missing and has no provenance', async () => {
      const relativePath = 'never-existed.md';

      const shouldSuppress = await suppressor.shouldSuppressLocalEvent(
        tmpVault,
        relativePath,
        provenanceRepo
      );
      expect(shouldSuppress).toBe(true);
    });

    it('suppresses local event after touching file (mtime updated but content hash identical)', async () => {
      const relativePath = 'touched.md';
      const fullPath = path.join(tmpVault, relativePath);
      const content = 'Unchanged content';
      await fs.writeFile(fullPath, content);

      const hash = createHash('sha256').update(content).digest('hex');
      const pastTime = new Date(Date.now() - 60000);
      await fs.utimes(fullPath, pastTime, pastTime);

      provenanceRepo.saveProvenance({
        path: relativePath,
        remoteRevision: '1-xyz',
        contentSha256: hash,
        observedMtime: pastTime.getTime(),
        remoteFingerprint: 'fp-123',
        reflectedAt: pastTime.toISOString(),
      });

      // Update mtime to now without changing content (touch)
      const now = new Date();
      await fs.utimes(fullPath, now, now);

      const shouldSuppress = await suppressor.shouldSuppressLocalEvent(
        tmpVault,
        relativePath,
        provenanceRepo
      );
      expect(shouldSuppress).toBe(true);
    });
  });

  describe('Remote Event Suppression', () => {
    it('suppresses remote event when remote revision matches provenance', () => {
      const relativePath = 'remote.md';
      const rev = '3-pushed-by-me';

      provenanceRepo.saveProvenance({
        path: relativePath,
        remoteRevision: rev,
        contentSha256: 'hash-xyz',
        observedMtime: Date.now(),
        remoteFingerprint: 'fp-123',
        reflectedAt: new Date().toISOString(),
      });

      const shouldSuppress = suppressor.shouldSuppressRemoteEvent(
        relativePath,
        rev,
        provenanceRepo
      );
      expect(shouldSuppress).toBe(true);
    });

    it('admits remote event when remote revision differs from provenance', () => {
      const relativePath = 'remote.md';

      provenanceRepo.saveProvenance({
        path: relativePath,
        remoteRevision: '1-old-rev',
        contentSha256: 'hash-xyz',
        observedMtime: Date.now(),
        remoteFingerprint: 'fp-123',
        reflectedAt: new Date().toISOString(),
      });

      const shouldSuppress = suppressor.shouldSuppressRemoteEvent(
        relativePath,
        '2-new-rev-from-peer',
        provenanceRepo
      );
      expect(shouldSuppress).toBe(false);
    });

    it('admits remote event when file has no provenance (new remote file)', () => {
      const shouldSuppress = suppressor.shouldSuppressRemoteEvent(
        'new-remote.md',
        '1-initial-rev',
        provenanceRepo
      );
      expect(shouldSuppress).toBe(false);
    });
  });
});
