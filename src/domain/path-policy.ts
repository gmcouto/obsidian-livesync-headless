import {
  validateStoragePath,
  shouldBeIgnored,
  FlagFilesOriginal,
  FlagFilesHumanReadable,
} from '../livesync/decode-adapter.js';

const RESERVED_FLAG_NAMES = new Set<string>([
  ...Object.values(FlagFilesOriginal),
  ...Object.values(FlagFilesHumanReadable),
]);

export function assertSafeVaultRelativePath(storagePath: string): string {
  return validateStoragePath(storagePath, false);
}

export function isReservedOrIgnoredPath(storagePath: string): boolean {
  if (shouldBeIgnored(storagePath)) {
    return true;
  }
  const baseName = storagePath.split('/').pop() ?? storagePath;
  if (baseName !== storagePath && shouldBeIgnored(baseName)) {
    return true;
  }
  return RESERVED_FLAG_NAMES.has(storagePath) || RESERVED_FLAG_NAMES.has(baseName);
}

export function findCaseFoldCollisions(
  paths: readonly string[],
  caseInsensitive: boolean
): string[][] {
  if (!caseInsensitive) {
    return [];
  }

  const groups = new Map<string, string[]>();
  for (const candidate of paths) {
    const folded = candidate.toLowerCase();
    const group = groups.get(folded) ?? [];
    group.push(candidate);
    groups.set(folded, group);
  }

  return [...groups.values()].filter((group) => group.length >= 2);
}
