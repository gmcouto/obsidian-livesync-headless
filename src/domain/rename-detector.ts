import type { VaultFileEntry } from '../filesystem/vault-scanner.js';
import type { ProvenanceRecord } from '../storage/provenance-repo.js';

export interface CaseRename {
  readonly oldPath: string;
  readonly newPath: string;
  readonly contentSha256: string;
  readonly baseRev: string;
}

export interface CrossPathRename {
  readonly oldPath: string;
  readonly newPath: string;
  readonly contentSha256: string;
  readonly baseRev: string;
}

export interface RenameDetectionResult {
  readonly caseRenames: CaseRename[];
  readonly crossPathRenames: CrossPathRename[];
  readonly consumedDeletedPaths: Set<string>;
  readonly consumedCreatedPaths: Set<string>;
}

export class RenameDetector {
  detectRenames(
    localFiles: Map<string, VaultFileEntry>,
    provenanceMap: Map<string, ProvenanceRecord>
  ): RenameDetectionResult {
    const caseRenames: CaseRename[] = [];
    const crossPathRenames: CrossPathRename[] = [];
    const consumedDeletedPaths = new Set<string>();
    const consumedCreatedPaths = new Set<string>();

    const deletedPaths: string[] = [];
    for (const provPath of provenanceMap.keys()) {
      if (!localFiles.has(provPath)) {
        deletedPaths.push(provPath);
      }
    }

    const createdPaths: string[] = [];
    for (const localPath of localFiles.keys()) {
      if (!provenanceMap.has(localPath)) {
        createdPaths.push(localPath);
      }
    }

    // 1. Detect Case-Only Renames (SYNC-05)
    for (const delPath of deletedPaths) {
      const provRec = provenanceMap.get(delPath)!;
      const delPathLower = delPath.toLowerCase();

      for (const crePath of createdPaths) {
        if (consumedCreatedPaths.has(crePath)) {
          continue;
        }

        if (delPathLower === crePath.toLowerCase() && delPath !== crePath) {
          const localEntry = localFiles.get(crePath)!;
          if (localEntry.contentSha256 === provRec.contentSha256) {
            caseRenames.push({
              oldPath: delPath,
              newPath: crePath,
              contentSha256: provRec.contentSha256,
              baseRev: provRec.remoteRevision,
            });
            consumedDeletedPaths.add(delPath);
            consumedCreatedPaths.add(crePath);
            break;
          }
        }
      }
    }

    // 2. Detect Cross-Path Renames (SYNC-05)
    for (const delPath of deletedPaths) {
      if (consumedDeletedPaths.has(delPath)) {
        continue;
      }
      const provRec = provenanceMap.get(delPath)!;

      const matchingCreated: string[] = [];
      for (const crePath of createdPaths) {
        if (consumedCreatedPaths.has(crePath)) {
          continue;
        }
        const localEntry = localFiles.get(crePath)!;
        if (localEntry.contentSha256 === provRec.contentSha256) {
          matchingCreated.push(crePath);
        }
      }

      // Unambiguous 1-to-1 match
      if (matchingCreated.length === 1) {
        const matchedPath = matchingCreated[0];
        crossPathRenames.push({
          oldPath: delPath,
          newPath: matchedPath,
          contentSha256: provRec.contentSha256,
          baseRev: provRec.remoteRevision,
        });
        consumedDeletedPaths.add(delPath);
        consumedCreatedPaths.add(matchedPath);
      }
    }

    return {
      caseRenames,
      crossPathRenames,
      consumedDeletedPaths,
      consumedCreatedPaths,
    };
  }
}
