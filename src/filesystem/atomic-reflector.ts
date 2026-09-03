import { randomBytes } from 'node:crypto';
import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../diagnostics/logger.js';

export class ReadbackMismatchError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string) {
    super(`Read-back bytes did not match assembled content for '${relativePath}'`);
    this.name = 'ReadbackMismatchError';
    this.relativePath = relativePath;
  }
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe vault-relative path rejected: ${relativePath}`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

export async function installAtomically(
  vaultRoot: string,
  relativePath: string,
  bytes: Uint8Array
): Promise<void> {
  assertSafeRelativePath(relativePath);

  const dest = join(vaultRoot, relativePath);
  const parentDir = dirname(dest);
  await mkdir(parentDir, { recursive: true });

  const tmp = join(parentDir, `.ols-tmp-${randomBytes(8).toString('hex')}`);
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tmp, dest);

  try {
    const dir = await open(parentDir, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (err) {
    logger.warn('Parent-directory sync is unsupported or failed; file sync and read-back remain authoritative', {
      path: relativePath,
      error: (err as Error).message,
    });
  }

  const written = new Uint8Array(await readFile(dest));
  if (!bytesEqual(written, bytes)) {
    throw new ReadbackMismatchError(relativePath);
  }
}
