import fs from 'node:fs/promises';
import path from 'node:path';
import type { SecretRef } from './schema.js';

export async function resolveSecret(
  ref: SecretRef | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fallbackEnvVar?: string,
  baseDir?: string
): Promise<string | undefined> {
  if (typeof ref === 'string') {
    return ref;
  }

  if (ref && typeof ref === 'object') {
    if ('fromEnv' in ref && ref.fromEnv) {
      const val = env[ref.fromEnv];
      if (val === undefined || val === '') {
        throw new Error(`Secret environment variable '${ref.fromEnv}' is not set or empty.`);
      }
      return val;
    }

    if ('fromFile' in ref && ref.fromFile) {
      const targetPath = baseDir ? path.resolve(baseDir, ref.fromFile) : path.resolve(ref.fromFile);
      try {
        const content = await fs.readFile(targetPath, 'utf-8');
        return content.trimEnd();
      } catch (err) {
        throw new Error(`Failed to read secret file '${ref.fromFile}': ${(err as Error).message}`);
      }
    }
  }

  if (fallbackEnvVar && env[fallbackEnvVar]) {
    return env[fallbackEnvVar];
  }

  return undefined;
}
