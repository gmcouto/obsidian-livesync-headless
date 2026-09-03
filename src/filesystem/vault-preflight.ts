import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface VaultPreflightBlock {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type VaultPreflightResult =
  | { readonly ok: true; readonly blocks: readonly [] }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly blocks: readonly VaultPreflightBlock[];
    };

interface VaultEntry {
  readonly relativePath: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

async function collectVaultEntries(vaultPath: string, prefix = ''): Promise<VaultEntry[] | VaultPreflightResult> {
  let names: string[];
  try {
    names = await readdir(vaultPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        code: 'VAULT_NOT_EMPTY',
        message: `Vault '${vaultPath}' does not exist`,
        blocks: [],
      };
    }
    return {
      ok: false,
      code: 'VAULT_NOT_EMPTY',
      message: `Failed to inspect vault '${vaultPath}': ${(err as Error).message}`,
      blocks: [],
    };
  }

  const entries: VaultEntry[] = [];
  for (const name of names) {
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const fullPath = join(vaultPath, name);
    const stats = await lstat(fullPath);
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        code: 'UNSAFE_SYMLINK',
        message: `Vault entry '${relativePath}' is a symlink and is not trusted`,
        blocks: [
          {
            path: relativePath,
            code: 'UNSAFE_SYMLINK',
            message: `Vault entry '${relativePath}' is a symlink and is not trusted`,
          },
        ],
      };
    }

    if (stats.isDirectory()) {
      entries.push({ relativePath, isFile: false, isDirectory: true });
      const nested = await collectVaultEntries(fullPath, relativePath);
      if (!Array.isArray(nested)) {
        return nested;
      }
      entries.push(...nested);
      continue;
    }

    entries.push({ relativePath, isFile: stats.isFile(), isDirectory: false });
  }

  return entries;
}

export async function preflightVault(
  vaultPath: string,
  dedicated: boolean,
  getProvenancePaths: () => Iterable<string> | Promise<Iterable<string>>
): Promise<VaultPreflightResult> {
  const collected = await collectVaultEntries(vaultPath);
  if (!Array.isArray(collected)) {
    return collected;
  }

  const files = collected.filter((entry) => entry.isFile).map((entry) => entry.relativePath);

  if (!dedicated && files.length > 0) {
    return {
      ok: false,
      code: 'VAULT_NOT_EMPTY',
      message: `Vault '${vaultPath}' is not empty; apply requires an empty or dedicated vault`,
      blocks: [],
    };
  }

  if (!dedicated) {
    return { ok: true, blocks: [] };
  }

  const provenance = new Set(await getProvenancePaths());
  const blocks = files
    .filter((relativePath) => !provenance.has(relativePath))
    .map((relativePath) => ({
      path: relativePath,
      code: 'UNPROVEN_LOCAL_FILE',
      message: `Existing vault file '${relativePath}' has no provenance row and will not be overwritten`,
    }));

  if (blocks.length > 0) {
    return {
      ok: false,
      code: 'UNPROVEN_LOCAL_FILE',
      message: 'Dedicated vault contains existing files without provenance; those paths are blocked',
      blocks,
    };
  }

  return { ok: true, blocks: [] };
}
