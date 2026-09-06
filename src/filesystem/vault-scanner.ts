import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isReservedOrIgnoredPath } from '../domain/path-policy.js';

export interface VaultFileEntry {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  readonly contentSha256: string;
}

export class VaultScanner {
  async scanVault(vaultRoot: string): Promise<Map<string, VaultFileEntry>> {
    const results = new Map<string, VaultFileEntry>();
    const rootAbs = path.resolve(vaultRoot);

    const walk = async (currentDir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw err;
      }

      for (const entry of entries) {
        const name = entry.name;
        // Ignore hidden / system directories and files (.obsidian, .git, .trash, etc.)
        if (name.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(currentDir, name);
        const relPath = path.relative(rootAbs, fullPath).split(path.sep).join('/');

        if (isReservedOrIgnoredPath(relPath) || isReservedOrIgnoredPath(name)) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          const buffer = await fs.readFile(fullPath);
          const hash = crypto.createHash('sha256').update(new Uint8Array(buffer)).digest('hex');

          results.set(relPath, {
            path: relPath,
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs),
            contentSha256: hash,
          });
        }
      }
    };

    await walk(rootAbs);
    return results;
  }
}
