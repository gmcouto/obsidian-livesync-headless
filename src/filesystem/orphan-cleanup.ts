import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const OLS_TMP_PREFIX = '.ols-tmp-';

export async function cleanupOrphanStagingFiles(vaultPath: string): Promise<number> {
  let cleanedCount = 0;

  async function scanAndClean(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanAndClean(fullPath);
      } else if (entry.isFile() && entry.name.startsWith(OLS_TMP_PREFIX)) {
        try {
          await unlink(fullPath);
          cleanedCount++;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            // Non-fatal warning if unable to unlink a temp file
            console.warn(`Failed to unlink orphan staging file '${fullPath}': ${(err as Error).message}`);
          }
        }
      }
    }
  }

  await scanAndClean(vaultPath);
  return cleanedCount;
}
