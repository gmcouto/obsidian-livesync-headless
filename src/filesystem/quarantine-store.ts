import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeVaultRelativePath } from '../domain/path-policy.js';
import type { QuarantineRepository, QuarantineRecord } from '../storage/quarantine-repo.js';

export class QuarantineError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'QuarantineError';
  }
}

export interface QuarantineOptions {
  reason?: 'REMOTE_DELETION' | 'DIVERGENT_DISPLACEMENT' | string;
  readFileFn?: (path: string) => Promise<Uint8Array>;
  writeFileFn?: (path: string, data: Uint8Array) => Promise<void>;
  mkdirFn?: (path: string, options: { recursive: boolean }) => Promise<void | string>;
  unlinkFn?: (path: string) => Promise<void>;
}

export async function quarantineVaultFile(
  vaultRoot: string,
  stateRoot: string,
  relativePath: string,
  remoteRevision: string | null | undefined,
  quarantineRepo: QuarantineRepository,
  options: QuarantineOptions = {}
): Promise<QuarantineRecord> {
  // 1. Enforce path security
  try {
    assertSafeVaultRelativePath(relativePath);
  } catch (err) {
    throw new QuarantineError(
      `Invalid vault relative path for quarantine: ${relativePath}`,
      err
    );
  }

  const fullVaultPath = path.join(vaultRoot, relativePath);
  const readFileFn = options.readFileFn ?? ((p) => fs.readFile(p));
  const writeFileFn = options.writeFileFn ?? ((p, d) => fs.writeFile(p, d));
  const mkdirFn = options.mkdirFn ?? ((p, o) => fs.mkdir(p, o));
  const unlinkFn = options.unlinkFn ?? ((p) => fs.unlink(p));
  const reason = options.reason ?? 'REMOTE_DELETION';

  try {
    // 2. Read source file
    let fileBytes: Uint8Array;
    try {
      fileBytes = await readFileFn(fullVaultPath);
    } catch (err) {
      throw new QuarantineError(
        `Failed to read source file from vault at '${fullVaultPath}'`,
        err
      );
    }

    const hash = createHash('sha256').update(fileBytes).digest('hex');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSubdir = `${timestamp}_${hash.slice(0, 8)}`;
    const destQuarantinePath = path.join(stateRoot, 'quarantine', safeSubdir, relativePath);

    // 3. Ensure destination directory exists
    try {
      await mkdirFn(path.dirname(destQuarantinePath), { recursive: true });
    } catch (err) {
      throw new QuarantineError(
        `Failed to create quarantine directory for '${destQuarantinePath}'`,
        err
      );
    }

    // 4. Write to quarantine destination
    try {
      await writeFileFn(destQuarantinePath, fileBytes);
    } catch (err) {
      throw new QuarantineError(
        `Failed to write quarantined file to '${destQuarantinePath}'`,
        err
      );
    }

    // 5. Read-back verification
    try {
      const readBack = await readFileFn(destQuarantinePath);
      if (!Buffer.from(readBack).equals(Buffer.from(fileBytes))) {
        throw new Error('Read-back bytes do not match source bytes');
      }
    } catch (err) {
      throw new QuarantineError(
        `Quarantine read-back verification failed for '${relativePath}'`,
        err
      );
    }

    // 6. Record in SQLite repository
    const record: QuarantineRecord = {
      originalPath: relativePath,
      quarantinePath: destQuarantinePath,
      remoteRevision: remoteRevision ?? null,
      contentSha256: hash,
      reason,
      quarantinedAt: new Date().toISOString(),
    };

    try {
      const rowId = quarantineRepo.saveQuarantine(record);
      (record as { id?: number }).id = rowId;
    } catch (err) {
      throw new QuarantineError(
        `Failed to record quarantine entry in database for '${relativePath}'`,
        err
      );
    }

    // 7. Unlink source vault file (only after all above steps succeeded)
    try {
      await unlinkFn(fullVaultPath);
    } catch (err) {
      throw new QuarantineError(
        `Failed to unlink source vault file '${fullVaultPath}' after quarantine preservation`,
        err
      );
    }

    return record;
  } catch (err) {
    if (err instanceof QuarantineError) {
      throw err;
    }
    throw new QuarantineError(`Unexpected quarantine failure for '${relativePath}'`, err);
  }
}
