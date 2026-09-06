import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProvenanceRepository } from '../storage/provenance-repo.js';

export interface LoopSuppressorOptions {
  readonly hashAlgorithm?: string;
}

export class LoopSuppressor {
  private readonly hashAlgorithm: string;

  constructor(options?: LoopSuppressorOptions) {
    this.hashAlgorithm = options?.hashAlgorithm ?? 'sha256';
  }

  /**
   * Evaluates whether a local filesystem event should be suppressed.
   * Returns true if the event represents an echo (content is unchanged from last sync)
   * or a non-actionable state, false if it is a genuine local modification that needs syncing.
   */
  async shouldSuppressLocalEvent(
    vaultRoot: string,
    relativePath: string,
    provenanceRepo: ProvenanceRepository
  ): Promise<boolean> {
    const fullPath = path.join(vaultRoot, relativePath);

    let content: Uint8Array;
    try {
      content = await fs.readFile(fullPath);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        // File does not exist on disk (unlinked)
        const provenance = provenanceRepo.getByPath(relativePath);
        if (!provenance) {
          // File was never in provenance (or already cleaned up) — suppress
          return true;
        }
        // Provenance exists but file is gone: genuine local deletion
        return false;
      }
      // Other read error (e.g. permission or lock): do not suppress, let reconciler handle
      return false;
    }

    const currentHash = createHash(this.hashAlgorithm).update(content).digest('hex');
    const provenance = provenanceRepo.getByPath(relativePath);

    if (!provenance) {
      // New file without provenance: genuine local addition
      return false;
    }

    if (currentHash === provenance.contentSha256) {
      // Content has not changed since last recorded provenance: suppress echo
      return true;
    }

    // Content differs: genuine local change
    return false;
  }

  /**
   * Evaluates whether a remote CouchDB changes event should be suppressed.
   * Returns true if the remote revision matches the revision pushed by this client,
   * false if it is a new or different revision.
   */
  shouldSuppressRemoteEvent(
    relativePath: string,
    remoteRev: string,
    provenanceRepo: ProvenanceRepository
  ): boolean {
    if (!remoteRev) {
      return false;
    }

    const provenance = provenanceRepo.getByPath(relativePath);
    if (!provenance) {
      // No provenance: new remote file
      return false;
    }

    if (provenance.remoteRevision === remoteRev) {
      // Remote revision matches the one this client pushed: suppress echo
      return true;
    }

    return false;
  }
}
