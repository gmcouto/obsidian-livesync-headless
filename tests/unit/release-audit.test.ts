import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  auditPackageJson,
  auditSourceTree,
  auditBundle,
  runReleaseAudit,
} from '../../scripts/audit-release.js';
import {
  createGuardedFetch,
  createArmedGuardedFetch,
  MutationAttemptBlockedError,
  EndpointDisallowedError,
} from '../../src/security/transport-guard.js';

describe('Release Safety Auditor Suite (DIST-05)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-audit-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('auditPackageJson', () => {
    it('passes cleanly with the project package.json', () => {
      const pkgPath = path.resolve('package.json');
      const violations = auditPackageJson(pkgPath);
      expect(violations).toHaveLength(0);
    });

    it('detects unpinned dependency versions (caret, tilde, wildcard, latest)', () => {
      const mockPkg = {
        name: 'test-pkg',
        dependencies: {
          'chokidar': '^5.0.0',
          'yaml': '~2.9.0',
          'zod': '*',
          '@vrtmrz/livesync-commonlib': 'latest',
        },
        overrides: {
          'pouchdb-core': { uuid: '11.1.1' },
          'pouchdb-utils': { uuid: '11.1.1' },
        },
      };

      const mockPkgPath = path.join(tempDir, 'package.json');
      fs.writeFileSync(mockPkgPath, JSON.stringify(mockPkg, null, 2));

      const violations = auditPackageJson(mockPkgPath);
      expect(violations.length).toBe(4);
      expect(violations.every((v) => v.rule === 'UNPINNED_DEPENDENCY')).toBe(true);
      expect(violations.some((v) => v.message.includes('chokidar'))).toBe(true);
      expect(violations.some((v) => v.message.includes('yaml'))).toBe(true);
      expect(violations.some((v) => v.message.includes('zod'))).toBe(true);
      expect(violations.some((v) => v.message.includes('@vrtmrz/livesync-commonlib'))).toBe(true);
    });

    it('detects missing or invalid uuid 11.1.1 overrides', () => {
      const mockPkg = {
        name: 'test-pkg',
        dependencies: {
          'chokidar': '5.0.0',
        },
        overrides: {
          'pouchdb-core': { uuid: '9.0.0' },
          // missing pouchdb-utils
        },
      };

      const mockPkgPath = path.join(tempDir, 'package.json');
      fs.writeFileSync(mockPkgPath, JSON.stringify(mockPkg, null, 2));

      const violations = auditPackageJson(mockPkgPath);
      expect(violations.length).toBe(2);
      expect(violations.some((v) => v.message.includes('pouchdb-core.uuid'))).toBe(true);
      expect(violations.some((v) => v.message.includes('pouchdb-utils.uuid'))).toBe(true);
    });

    it('reports error when package.json does not exist or is invalid JSON', () => {
      const missingPath = path.join(tempDir, 'nonexistent.json');
      const violations = auditPackageJson(missingPath);
      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe('UNPINNED_DEPENDENCY');

      const invalidJsonPath = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(invalidJsonPath, '{ invalid json');
      const parseViolations = auditPackageJson(invalidJsonPath);
      expect(parseViolations.length).toBe(1);
    });
  });

  describe('auditSourceTree', () => {
    it('passes cleanly against the production src/ directory', () => {
      const srcDir = path.resolve('src');
      const violations = auditSourceTree(srcDir);
      expect(violations).toHaveLength(0);
    });

    it('detects forbidden CouchDB maintenance endpoints outside of transport guard', () => {
      const mockSrcDir = path.join(tempDir, 'src');
      fs.mkdirSync(mockSrcDir, { recursive: true });

      fs.writeFileSync(
        path.join(mockSrcDir, 'bad-service.ts'),
        `export async function runMaintenance(url: string) {\n  return fetch(url + '/_compact', { method: 'POST' });\n}`
      );

      const violations = auditSourceTree(mockSrcDir);
      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe('FORBIDDEN_METHOD');
      expect(violations[0].message).toContain('_compact');
    });

    it('detects forbidden database destruction calls', () => {
      const mockSrcDir = path.join(tempDir, 'src');
      fs.mkdirSync(mockSrcDir, { recursive: true });

      fs.writeFileSync(
        path.join(mockSrcDir, 'destructive.ts'),
        `export async function clearDb(db: any) {\n  await db.destroy();\n}`
      );

      const violations = auditSourceTree(mockSrcDir);
      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe('FORBIDDEN_METHOD');
      expect(violations[0].message).toContain('db.destroy()');
    });

    it('detects forbidden out-of-scope cloud and P2P storage provider imports', () => {
      const mockSrcDir = path.join(tempDir, 'src');
      fs.mkdirSync(mockSrcDir, { recursive: true });

      fs.writeFileSync(
        path.join(mockSrcDir, 's3-adapter.ts'),
        `import { S3Client } from '@aws-sdk/client-s3';\nexport const s3 = new S3Client({});`
      );

      fs.writeFileSync(
        path.join(mockSrcDir, 'p2p-sync.ts'),
        `import Peer from 'simple-peer';\nexport const peer = new Peer();`
      );

      const violations = auditSourceTree(mockSrcDir);
      expect(violations.length).toBe(2);
      expect(violations.every((v) => v.rule === 'FORBIDDEN_PROVIDER')).toBe(true);
    });

    it('detects hardcoded secret tokens and unmasked credentials', () => {
      const mockSrcDir = path.join(tempDir, 'src');
      fs.mkdirSync(mockSrcDir, { recursive: true });

      fs.writeFileSync(
        path.join(mockSrcDir, 'leaked-key.ts'),
        `export const githubToken = 'ghp_111122223333444455556666777788889999';`
      );

      fs.writeFileSync(
        path.join(mockSrcDir, 'leaked-pass.ts'),
        `export const config = {\n  password: 'superSecretPassword123!',\n};`
      );

      const violations = auditSourceTree(mockSrcDir);
      expect(violations.length).toBe(2);
      expect(violations.every((v) => v.rule === 'UNREDACTED_SECRET')).toBe(true);
    });

    it('permits transport-guard.ts to define forbidden subpaths as security filters', () => {
      const mockSrcDir = path.join(tempDir, 'src', 'security');
      fs.mkdirSync(mockSrcDir, { recursive: true });

      fs.writeFileSync(
        path.join(mockSrcDir, 'transport-guard.ts'),
        `const FORBIDDEN_SUBPATHS = ['/_purge', '/_compact', '/_security', '/_revs_limit'];`
      );

      const violations = auditSourceTree(path.join(tempDir, 'src'));
      expect(violations).toHaveLength(0);
    });
  });

  describe('auditBundle', () => {
    it('passes cleanly against the compiled release bundle if built', () => {
      const bundlePath = path.resolve('dist', 'bundle.cjs');
      if (fs.existsSync(bundlePath)) {
        const violations = auditBundle(bundlePath);
        expect(violations).toHaveLength(0);
      }
    });

    it('detects forbidden cloud providers or high-entropy tokens in bundle', () => {
      const mockBundlePath = path.join(tempDir, 'bundle.cjs');
      fs.writeFileSync(
        mockBundlePath,
        `"use strict";\nconst s3 = require('@aws-sdk/client-s3');\nconst key = "REDACTED_FAKE_KEY_FOR_TESTING";\n`
      );

      const violations = auditBundle(mockBundlePath);
      expect(violations.length).toBe(2);
      expect(violations.some((v) => v.rule === 'FORBIDDEN_PROVIDER')).toBe(true);
      expect(violations.some((v) => v.rule === 'UNREDACTED_SECRET')).toBe(true);
    });

    it('reports violation when bundle file does not exist', () => {
      const missingBundle = path.join(tempDir, 'nonexistent-bundle.cjs');
      const violations = auditBundle(missingBundle);
      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe('FORBIDDEN_METHOD');
      expect(violations[0].message).toContain('not found');
    });
  });

  describe('runReleaseAudit runner', () => {
    it('returns exit code 0 for the clean project repository', async () => {
      const exitCode = await runReleaseAudit(process.cwd());
      expect(exitCode).toBe(0);
    });

    it('returns exit code 1 when violations exist in target root', async () => {
      const mockRoot = tempDir;
      fs.writeFileSync(
        path.join(mockRoot, 'package.json'),
        JSON.stringify({ dependencies: { zod: '^4.0.0' } })
      );
      fs.mkdirSync(path.join(mockRoot, 'src'), { recursive: true });

      const exitCode = await runReleaseAudit(mockRoot);
      expect(exitCode).toBe(1);
    });
  });

  describe('Runtime Guard Safety Enforcement (SAFE-01, SAFE-02, SAFE-03)', () => {
    const guardOptions = {
      allowedBaseUrl: new URL('http://couchdb.local:5984'),
      databaseName: 'vault',
    };

    it('read-only guardedFetch strictly blocks PUT, POST, and DELETE methods', async () => {
      const mockFetch = vi.fn();
      const guardedFetch = createGuardedFetch(guardOptions, mockFetch);

      await expect(
        guardedFetch('http://couchdb.local:5984/vault/doc1', { method: 'PUT', body: '{}' })
      ).rejects.toThrow(MutationAttemptBlockedError);

      await expect(
        guardedFetch('http://couchdb.local:5984/vault/_bulk_docs', { method: 'POST', body: '{}' })
      ).rejects.toThrow(MutationAttemptBlockedError);

      await expect(
        guardedFetch('http://couchdb.local:5984/vault/doc1', { method: 'DELETE' })
      ).rejects.toThrow(MutationAttemptBlockedError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('armed guardedFetch strictly blocks DELETE, PATCH, and administrative subpaths', async () => {
      const mockFetch = vi.fn();
      const armedFetch = createArmedGuardedFetch(guardOptions, mockFetch);

      // DELETE blocked
      await expect(
        armedFetch('http://couchdb.local:5984/vault/doc1', { method: 'DELETE' })
      ).rejects.toThrow(MutationAttemptBlockedError);

      // _compact blocked
      await expect(
        armedFetch('http://couchdb.local:5984/vault/_compact', { method: 'POST' })
      ).rejects.toThrow(EndpointDisallowedError);

      // _purge blocked
      await expect(
        armedFetch('http://couchdb.local:5984/vault/_purge', { method: 'POST' })
      ).rejects.toThrow(EndpointDisallowedError);

      // _security blocked
      await expect(
        armedFetch('http://couchdb.local:5984/vault/_security', { method: 'PUT', body: '{}' })
      ).rejects.toThrow(EndpointDisallowedError);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
