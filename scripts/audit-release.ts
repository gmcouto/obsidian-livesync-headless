import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AuditViolation {
  readonly rule: 'FORBIDDEN_METHOD' | 'UNREDACTED_SECRET' | 'FORBIDDEN_PROVIDER' | 'UNPINNED_DEPENDENCY';
  readonly file: string;
  readonly message: string;
}

/**
 * Verifies exact version pins on direct dependencies and required overrides in package.json.
 */
export function auditPackageJson(packageJsonPath: string): AuditViolation[] {
  const violations: AuditViolation[] = [];

  if (!fs.existsSync(packageJsonPath)) {
    violations.push({
      rule: 'UNPINNED_DEPENDENCY',
      file: packageJsonPath,
      message: `package.json not found at ${packageJsonPath}`,
    });
    return violations;
  }

  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    violations.push({
      rule: 'UNPINNED_DEPENDENCY',
      file: packageJsonPath,
      message: `Failed to parse JSON in ${packageJsonPath}: ${String(err)}`,
    });
    return violations;
  }

  // 1. Check direct dependencies for loose semver ranges (^, ~, *, >, <, latest, next)
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  for (const [name, version] of Object.entries(deps)) {
    if (
      version.startsWith('^') ||
      version.startsWith('~') ||
      version.startsWith('*') ||
      version.startsWith('>') ||
      version.startsWith('<') ||
      version === 'latest' ||
      version === 'next'
    ) {
      violations.push({
        rule: 'UNPINNED_DEPENDENCY',
        file: packageJsonPath,
        message: `Dependency "${name}" has unpinned version range "${version}". Must use exact version pin.`,
      });
    }
  }

  // 2. Check overrides for pouchdb-core and pouchdb-utils -> uuid: 11.1.1
  const overrides = (pkg.overrides ?? {}) as Record<string, Record<string, string> | string>;
  const coreUuid = typeof overrides['pouchdb-core'] === 'object' ? overrides['pouchdb-core']?.uuid : undefined;
  const utilsUuid = typeof overrides['pouchdb-utils'] === 'object' ? overrides['pouchdb-utils']?.uuid : undefined;

  if (coreUuid !== '11.1.1') {
    violations.push({
      rule: 'UNPINNED_DEPENDENCY',
      file: packageJsonPath,
      message: `Missing or incorrect override for pouchdb-core.uuid (expected "11.1.1", found "${coreUuid ?? 'none'}").`,
    });
  }

  if (utilsUuid !== '11.1.1') {
    violations.push({
      rule: 'UNPINNED_DEPENDENCY',
      file: packageJsonPath,
      message: `Missing or incorrect override for pouchdb-utils.uuid (expected "11.1.1", found "${utilsUuid ?? 'none'}").`,
    });
  }

  return violations;
}

const FORBIDDEN_PROVIDERS_PATTERN = /(['"])(@aws-sdk|aws-sdk|webdav|dropbox|googleapis|simple-peer|webrtc|peerjs|@libp2p)([\/'"])/i;

const FORBIDDEN_METHODS_PATTERN = /(?:['"`])(?:\/?(?:_compact|_purge|_view_cleanup|_revs_limit|_security))\b/i;

const DESTRUCTIVE_DB_PATTERN = /\b(?:db|pouchdb|pouch)\.destroy\s*\(/i;

const HARDCODED_SECRETS_PATTERN = /(?:ghp_[A-Za-z0-9]{36}|sk_live_[A-Za-z0-9]{24}|sk_test_[A-Za-z0-9]{24}|-----BEGIN (?:RSA )?PRIVATE KEY-----)/;

const UNMASKED_ASSIGNMENT_PATTERN = /(?:password|passphrase|secret_key|api_key)\s*[:=]\s*['"`]([A-Za-z0-9!@#$%^&*()_+=-]{8,})['"`]/i;

/**
 * Scans TypeScript / JavaScript source files in srcDir for forbidden maintenance endpoints,
 * unauthorized cloud/P2P storage providers, and unredacted secrets.
 */
export function auditSourceTree(srcDir: string): AuditViolation[] {
  const violations: AuditViolation[] = [];

  if (!fs.existsSync(srcDir)) {
    violations.push({
      rule: 'FORBIDDEN_METHOD',
      file: srcDir,
      message: `Source directory ${srcDir} does not exist.`,
    });
    return violations;
  }

  function walk(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walk(fullPath));
      } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const files = walk(srcDir);

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const isTransportGuard = file.endsWith('transport-guard.ts') || file.endsWith('transport-guard.js');

    // 1. Out-of-scope storage providers check
    const providerMatch = content.match(FORBIDDEN_PROVIDERS_PATTERN);
    if (providerMatch) {
      violations.push({
        rule: 'FORBIDDEN_PROVIDER',
        file,
        message: `Forbidden cloud or P2P provider reference: "${providerMatch[2]}". Only CouchDB is permitted.`,
      });
    }

    // 2. Forbidden CouchDB maintenance endpoints (allowed only as denylist filter constants in transport guard)
    if (!isTransportGuard) {
      const endpointMatch = content.match(FORBIDDEN_METHODS_PATTERN);
      if (endpointMatch) {
        violations.push({
          rule: 'FORBIDDEN_METHOD',
          file,
          message: `Forbidden CouchDB administrative endpoint reference detected in source: "${endpointMatch[0]}".`,
        });
      }

      if (DESTRUCTIVE_DB_PATTERN.test(content)) {
        violations.push({
          rule: 'FORBIDDEN_METHOD',
          file,
          message: `Forbidden destructive database operation detected: db.destroy().`,
        });
      }
    }

    // 3. Unredacted secrets check
    if (HARDCODED_SECRETS_PATTERN.test(content)) {
      violations.push({
        rule: 'UNREDACTED_SECRET',
        file,
        message: 'High-entropy secret token or private key pattern detected in source code.',
      });
    }

    const unmaskedAssignment = content.match(UNMASKED_ASSIGNMENT_PATTERN);
    if (unmaskedAssignment && !unmaskedAssignment[1].includes('[REDACTED]')) {
      violations.push({
        rule: 'UNREDACTED_SECRET',
        file,
        message: `Unmasked secret assignment detected: "${unmaskedAssignment[0]}".`,
      });
    }
  }

  return violations;
}

/**
 * Scans the bundled CJS release artifact (dist/bundle.cjs) for administrative calls,
 * unauthorized providers, and hardcoded test keys.
 */
export function auditBundle(bundlePath: string): AuditViolation[] {
  const violations: AuditViolation[] = [];

  if (!fs.existsSync(bundlePath)) {
    violations.push({
      rule: 'FORBIDDEN_METHOD',
      file: bundlePath,
      message: `Release bundle not found at ${bundlePath}. Run npm run build:sea before auditing.`,
    });
    return violations;
  }

  const content = fs.readFileSync(bundlePath, 'utf8');

  // Check forbidden cloud / P2P providers bundled into CJS
  const providerMatch = content.match(FORBIDDEN_PROVIDERS_PATTERN);
  if (providerMatch) {
    violations.push({
      rule: 'FORBIDDEN_PROVIDER',
      file: bundlePath,
      message: `Forbidden cloud or P2P provider bundled in release: "${providerMatch[2]}".`,
    });
  }

  // Check high-entropy tokens or keys in bundle
  if (HARDCODED_SECRETS_PATTERN.test(content)) {
    violations.push({
      rule: 'UNREDACTED_SECRET',
      file: bundlePath,
      message: 'High-entropy secret token or private key pattern detected in bundled release artifact.',
    });
  }

  return violations;
}

/**
 * Standalone CLI runner when executed directly via `tsx scripts/audit-release.ts` or `npm run audit:release`.
 */
export async function runReleaseAudit(projectRoot = process.cwd()): Promise<number> {
  const pkgPath = path.join(projectRoot, 'package.json');
  const srcDir = path.join(projectRoot, 'src');
  const bundlePath = path.join(projectRoot, 'dist', 'bundle.cjs');

  console.log('═'.repeat(70));
  console.log('  OBSIDIAN LIVESYNC HEADLESS — RELEASE SAFETY AUDITOR');
  console.log('═'.repeat(70));

  const allViolations: AuditViolation[] = [];

  // 1. Audit package.json
  process.stdout.write('  [1/3] Auditing dependency pinning & overrides in package.json... ');
  const pkgViolations = auditPackageJson(pkgPath);
  if (pkgViolations.length === 0) {
    console.log('✓ PASS');
  } else {
    console.log(`✗ FAIL (${pkgViolations.length} violations)`);
    allViolations.push(...pkgViolations);
  }

  // 2. Audit src/ tree
  process.stdout.write('  [2/3] Auditing source tree for forbidden endpoints & secrets... ');
  const srcViolations = auditSourceTree(srcDir);
  if (srcViolations.length === 0) {
    console.log('✓ PASS');
  } else {
    console.log(`✗ FAIL (${srcViolations.length} violations)`);
    allViolations.push(...srcViolations);
  }

  // 3. Audit dist/bundle.cjs (if exists)
  process.stdout.write('  [3/3] Auditing packaged bundle (dist/bundle.cjs)... ');
  if (fs.existsSync(bundlePath)) {
    const bundleViolations = auditBundle(bundlePath);
    if (bundleViolations.length === 0) {
      console.log('✓ PASS');
    } else {
      console.log(`✗ FAIL (${bundleViolations.length} violations)`);
      allViolations.push(...bundleViolations);
    }
  } else {
    console.log('⚠ SKIPPED (dist/bundle.cjs not built)');
  }

  console.log('─'.repeat(70));
  if (allViolations.length === 0) {
    console.log('  🎉 RELEASE SAFETY AUDIT PASSED: 0 violations found.');
    console.log('═'.repeat(70));
    return 0;
  } else {
    console.error(`  ❌ RELEASE SAFETY AUDIT FAILED: ${allViolations.length} violation(s) detected:`);
    for (const v of allViolations) {
      console.error(`    • [${v.rule}] ${v.file}: ${v.message}`);
    }
    console.log('═'.repeat(70));
    return 1;
  }
}

// Check if running as script directly
const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFilePath === currentFilePath || invokedFilePath.endsWith('audit-release.ts')) {
  runReleaseAudit().then((exitCode) => {
    process.exit(exitCode);
  }).catch((err) => {
    console.error('Fatal auditor error:', err);
    process.exit(1);
  });
}
