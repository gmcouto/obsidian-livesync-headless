# Phase 6: Packaged Mixed-Client Release Gate - Pattern Map

**Mapped:** 2026-09-06  
**Files Analyzed:** 35+  
**Scope:** Single-Executable Application (Node SEA & postject) packaging, pinned build & compatibility identity, local status command, entrypoint warning suppression, mixed-client upstream interoperability harness with disposable CouchDB 3.5.2, and static release safety audits.

---

## 1. File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/diagnostics/identity.ts` | diagnostics / utility | static & runtime metadata aggregation | `src/diagnostics/formatters.ts`, `package.json` | exact |
| `src/cli/commands/status.ts` | controller / CLI command | query SQLite state & format output | `src/cli/commands/inspect.ts`, `src/cli/commands/arm.ts` | exact |
| `src/cli/index.ts` | CLI entrypoint / parser | command dispatch, options parsing | `src/cli/index.ts` (extend in place) | exact |
| `src/bin.ts` | binary entrypoint | process warning filter & CLI runner | `src/cli/index.ts` (lines 216–221) | exact |
| `scripts/build-sea.mjs` | build script | esbuild bundle -> sea config -> node copy -> postject injection | `package.json` build workflow | role-match |
| `scripts/audit-release.ts` | security / static analysis | AST / regex scan for methods, secrets, dependencies | `src/security/transport-guard.ts`, `src/security/redaction.ts` | role-match |
| `tests/unit/identity.test.ts` | unit test | assert build identity metadata, overrides, version strings | `tests/unit/config.test.ts` | exact |
| `tests/unit/status-command.test.ts` | unit test | mock SQLite state & assert human/JSON status output | `tests/unit/daemon-command.test.ts` | exact |
| `tests/unit/release-audit.test.ts` | unit test | execute release safety scanners against codebase & bundle | `tests/unit/armed-transport-guard.test.ts`, `tests/unit/redaction.test.ts` | exact |
| `tests/integration/packaged-binary.test.ts` | integration test | spawn packaged SEA binary in isolated `PATH` subshell | `tests/unit/daemon-command.test.ts`, `tests/integration/inspect-command.test.ts` | exact |
| `tests/integration/mixed-client-interop.test.ts` | integration test | bidirectional interoperability against CouchDB 3.5.2 container | `tests/integration/sync-bidirectional.test.ts`, `tests/integration/daemon-continuous-sync.test.ts` | exact |

---

## 2. Pattern Assignments & Implementation Blueprints

### 2.1 Pinned Version & Build Identity (`src/diagnostics/identity.ts`)
**Analog:** [formatters.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/diagnostics/formatters.ts#L3-L98) and [package.json](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/package.json#L1-L36)

Defines the inspectable compatibility contract fulfilling requirement **DIST-03**:
- Pinned Obsidian LiveSync compatibility version (`1.0.23`)
- Pinned Commonlib version (`0.1.21`)
- Target CouchDB version (`3.5.2`)
- Package version (`0.1.0`)
- Dependency overrides (`pouchdb-core`, `pouchdb-utils` to `uuid: 11.1.1`)
- Git commit SHA and build timestamp
- Runtime execution environment (Node version, platform, architecture, SEA flag)

```typescript
export interface BuildIdentity {
  readonly name: 'obsidian-livesync-headless';
  readonly version: string;
  readonly liveSyncCompatibility: string;
  readonly commonlibVersion: string;
  readonly targetCouchDbVersion: string;
  readonly gitCommit: string;
  readonly buildTimestamp: string;
  readonly dependencyOverrides: {
    readonly 'pouchdb-core': { readonly uuid: string };
    readonly 'pouchdb-utils': { readonly uuid: string };
  };
  readonly runtime: {
    readonly nodeVersion: string;
    readonly platform: string;
    readonly arch: string;
    readonly sea: boolean;
  };
}

export function getBuildIdentity(): BuildIdentity {
  return {
    name: 'obsidian-livesync-headless',
    version: '0.1.0',
    liveSyncCompatibility: '1.0.23',
    commonlibVersion: '0.1.21',
    targetCouchDbVersion: '3.5.2',
    gitCommit: process.env.GIT_COMMIT || 'release',
    buildTimestamp: process.env.BUILD_TIMESTAMP || '2026-09-06T00:00:00.000Z',
    dependencyOverrides: {
      'pouchdb-core': { uuid: '11.1.1' },
      'pouchdb-utils': { uuid: '11.1.1' },
    },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      sea: Boolean((process as unknown as { isSea?: () => boolean }).isSea?.()),
    },
  };
}

export function formatIdentityHuman(identity: BuildIdentity): string {
  const lines: string[] = [];
  const divider = '─'.repeat(70);
  lines.push(divider);
  lines.push(`  OBSIDIAN LIVESYNC HEADLESS — BUILD & COMPATIBILITY IDENTITY`);
  lines.push(divider);
  lines.push(`  Client Version:           v${identity.version}`);
  lines.push(`  LiveSync Compatibility:   ${identity.liveSyncCompatibility}`);
  lines.push(`  Commonlib Version:        ${identity.commonlibVersion}`);
  lines.push(`  Target CouchDB:           ${identity.targetCouchDbVersion}`);
  lines.push(`  Git Commit:               ${identity.gitCommit}`);
  lines.push(`  Build Timestamp:          ${identity.buildTimestamp}`);
  lines.push(`  Runtime:                  Node ${identity.runtime.nodeVersion} (${identity.runtime.platform} ${identity.runtime.arch}, SEA=${identity.runtime.sea})`);
  lines.push(`  Dependency Overrides:`);
  lines.push(`    • pouchdb-core -> uuid: ${identity.dependencyOverrides['pouchdb-core'].uuid}`);
  lines.push(`    • pouchdb-utils -> uuid: ${identity.dependencyOverrides['pouchdb-utils'].uuid}`);
  lines.push(divider);
  return lines.join('\n') + '\n';
}

export function formatIdentityJson(identity: BuildIdentity): string {
  return JSON.stringify({ type: 'version_identity', ...identity }) + '\n';
}
```

---

### 2.2 Local Status Inspection Command (`src/cli/commands/status.ts`)
**Analog:** [inspect.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/cli/commands/inspect.ts#L32-L76) and [arm.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/cli/commands/arm.ts#L12-L65)

Inspects local SQLite state without performing remote mutation or requiring network connectivity:
1. Loads configuration to resolve vault path and state database path.
2. Checks SQLite existence and runs read-only queries against:
   - `AdmissionRepository` (latest admission record, remote fingerprint, couchdb URL, negotiated settings hash)
   - `WriteGrantRepo` (active grant validity, grant ID, bootstrap generation, revocation status)
   - `CheckpointRepository` (last pull update_seq and completion timestamp)
   - `file_provenance` (count of tracked files and revisions)
   - `quarantine` (count of quarantined files)
3. Emits structured human-readable tabular text or JSON Lines output.

```typescript
export interface StatusReport {
  readonly type: 'status_report';
  readonly outcome: OutcomeCategory;
  readonly vaultPath: string;
  readonly statePath: string;
  readonly databaseExists: boolean;
  readonly admission: {
    readonly admitted: boolean;
    readonly remoteFingerprint?: string;
    readonly couchdbUrl?: string;
    readonly databaseName?: string;
    readonly couchdbVersion?: string;
    readonly settingsHash?: string;
    readonly admittedAt?: string;
  };
  readonly writeGrant: {
    readonly active: boolean;
    readonly grantId?: string;
    readonly bootstrapGeneration?: string;
    readonly issuedAt?: string;
  };
  readonly checkpoint: {
    readonly hasCheckpoint: boolean;
    readonly lastUpdateSeq?: string;
    readonly completedAt?: string;
  };
  readonly stats: {
    readonly trackedFilesCount: number;
    readonly quarantineFilesCount: number;
  };
}

export async function runStatusCommand(options: StatusCommandOptions): Promise<number>;
```

---

### 2.3 CLI Dispatcher & Argument Parser Extensions (`src/cli/index.ts`)
**Analog:** [src/cli/index.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/cli/index.ts#L29-L215)

1. Update `CLI_HELP` to document all command flows: `inspect`, `pull`, `arm`, `sync`, `daemon`, `status`, `version`.
2. Support `version` sub-command alongside `-v` / `--version`, including `--json` support for structured parsing.
3. Route `status` command to `runStatusCommand`.
4. Suppress experimental `node:sqlite` warnings cleanly at the entrypoint.

```typescript
export const CLI_HELP = `obsidian-livesync-headless [command] [options]

Commands:
  inspect                     Safely inspect and negotiate compatibility with CouchDB
  pull                        Materialize verified remote LiveSync files into a vault
  arm                         Issue or revoke durable 5-tuple write grant for vault & remote
  sync                        Bidirectional synchronization with chunk-first push and guard
  daemon                      Continuous unattended convergence daemon
  status                      Inspect local vault state, write grants, and pull checkpoints
  version                     Show build and compatibility identity

Options:
  -c, --config <path>         Path to YAML configuration file
      --write                 Enable bidirectional synchronization in daemon mode (requires active write grant)
      --periodic-scan-sec <n> Periodic full reconciliation interval in seconds (default: 300)
      --concurrency <n>       Max concurrent file workers (default: 4)
      --debounce-ms <n>       Local filesystem watcher debounce window in ms (default: 300)
      --json                  Output structured JSON Lines report
      --dry-run               Preview synchronization actions without mutation
      --revoke                Revoke active write grant for the vault (arm command)
  -h, --help                  Show help and usage information
  -v, --version               Show version and compatibility information
`;
```

---

### 2.4 Standalone Binary Entrypoint (`src/bin.ts`)
**Analog:** [src/cli/index.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/cli/index.ts#L216-L221)

Provides a clean entrypoint for Single Executable Application (SEA) bundling, installing the warning interceptor before importing CLI components:

```typescript
#!/usr/bin/env node

// Intercept and suppress experimental SQLite notices in standalone mode
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
    return;
  }
});

import { main } from './cli/index.js';

main().then((exitCode) => {
  process.exit(exitCode);
}).catch((error) => {
  process.stderr.write(`Fatal execution error: ${error.message}\n`);
  process.exit(1);
});
```

---

### 2.5 SEA Packaging Pipeline (`scripts/build-sea.mjs`)
**Analog:** Node.js SEA documentation & `esbuild` build pattern

Automates the four-stage packaging pipeline:
1. **Bundle (esbuild)**: Compiles `src/bin.ts` into a self-contained CommonJS bundle (`dist/bundle.cjs`) targeting Node 24 with bundled dependencies (`@vrtmrz/livesync-commonlib`, `yaml`, `zod`, `chokidar`, `octagonal-wheels`).
2. **SEA Config Blob**: Generates `dist/sea-prep.blob` via `node --experimental-sea-config sea-config.json` with `disableExperimentalSEAWarning: true`.
3. **Binary Copy**: Resolves the host `node` binary path (`process.execPath`) and copies it to `dist/obsidian-livesync-headless`.
4. **Postject Resource Injection**: Uses `postject` (or `node:sea` tooling) with fuse `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` to inject the blob into the ELF / Mach-O / PE binary, followed by `chmod +x`.

```javascript
import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const distDir = path.resolve('dist');
fs.mkdirSync(distDir, { recursive: true });

// 1. Bundle TypeScript to CommonJS
esbuild.buildSync({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'dist/bundle.cjs',
  external: ['node:*'],
  sourcemap: 'inline',
});

// 2. Generate SEA config & blob
const seaConfig = {
  main: 'dist/bundle.cjs',
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
};
fs.writeFileSync('dist/sea-config.json', JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json'], { stdio: 'inherit' });

// 3. Copy host Node binary
const targetBinary = path.join(distDir, 'obsidian-livesync-headless');
fs.copyFileSync(process.execPath, targetBinary);

// 4. Inject blob with postject
const postjectBin = path.resolve('node_modules/.bin/postject');
execFileSync(postjectBin, [
  targetBinary,
  'NODE_SEA_BLOB',
  'dist/sea-prep.blob',
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });

fs.chmodSync(targetBinary, 0o755);
```

---

### 2.6 Release Safety Static Auditor (`scripts/audit-release.ts` & `tests/unit/release-audit.test.ts`)
**Analog:** [armed-transport-guard.test.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/tests/unit/armed-transport-guard.test.ts#L58-L84) and [redaction.test.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/tests/unit/redaction.test.ts#L1-L100)

Enforces zero-defect release criteria (DIST-05):
1. **Forbidden Remote Capabilities**: Scans all source and bundle files to confirm no calls to `_compact`, `_purge`, `_view_cleanup`, `_security`, `_revs_limit`, or database-level `DELETE`.
2. **Secret Redaction Audit**: Scans codebase and sample output logs to verify passphrases, auth tokens, and setup URIs are properly masked with `[REDACTED]`.
3. **Out-of-Scope Provider Audit**: Verifies zero imports or dependencies on AWS S3, WebDAV, Google Drive, Dropbox, or WebRTC/P2P.
4. **Dependency Pinning Audit**: Verifies `package.json` contains exact version pins for direct dependencies and the required overrides for `pouchdb-core` / `pouchdb-utils`.

```typescript
export interface AuditViolation {
  readonly rule: 'FORBIDDEN_METHOD' | 'UNREDACTED_SECRET' | 'FORBIDDEN_PROVIDER' | 'UNPINNED_DEPENDENCY';
  readonly file: string;
  readonly message: string;
}

export function auditPackageJson(packageJsonPath: string): AuditViolation[];
export function auditSourceTree(srcDir: string): AuditViolation[];
export function auditBundle(bundlePath: string): AuditViolation[];
```

---

### 2.7 Mixed-Client Interoperability Test Suite (`tests/integration/mixed-client-interop.test.ts`)
**Analog:** [sync-bidirectional.test.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/tests/integration/sync-bidirectional.test.ts#L12-L215) and [couchdb-harness.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/tests/integration/couchdb-harness.ts#L149-L370)

Validates bidirectional compatibility across all LiveSync features against real CouchDB 3.5.2 containers:
1. **Plain Notes**: Upstream commonlib write -> headless pull -> local match; headless sync -> upstream verification.
2. **Chunked Files**: Multi-chunk binary / markdown files assembled and verified byte-for-byte.
3. **E2EE V2 Encryption**: HKDF-encrypted data and paths (`/\\:...`) decrypted and validated.
4. **Obfuscated Paths**: Commonlib `path2id_base` obfuscation decrypted without path corruption.
5. **Logical Deletions**: Deletions recorded as `deleted: true` child revisions with intact CouchDB revision tree.
6. **Concurrent Edits & Conflicts**: Upstream and headless edit simultaneously -> produces CouchDB conflict leaves -> headless detects ambiguous conflict, preserves local file, halts fail-closed without silent overwrite.
7. **Renames**: Case-only and cross-path renames round-trip without data loss.
8. **Daemon Convergence**: Continuous changes stream convergence within debounce window.

```typescript
describe('Mixed-Client Interoperability & Coexistence (CouchDB 3.5.2 & Commonlib)', () => {
  const harness = new CouchDbTestHarness();

  beforeAll(async () => {
    await harness.start();
  }, 120000);

  afterAll(async () => {
    await harness.stop();
  }, 60000);

  it('interoperates bidirectionally with upstream plain and chunked notes', async () => { ... });
  it('interoperates bidirectionally with upstream E2EE V2 encrypted notes', async () => { ... });
  it('interoperates bidirectionally with upstream path-obfuscated notes', async () => { ... });
  it('handles simultaneous edits producing conflict leaves without silent loss', async () => { ... });
  it('converges in real-time under continuous daemon mode upon upstream writes', async () => { ... });
});
```

---

## 3. Invariants & Security Boundaries

### 3.1 Release & Packaging Invariants
1. **Zero External Runtime Dependency (DIST-01)**: The packaged SEA binary must execute cleanly in an isolated environment with restricted `PATH` (`/usr/bin:/bin`) and no external Node.js or npm packages available.
2. **Zero Mutation Remote Safety (DIST-05, SEC-01)**: Under no configuration or command flow can the client emit CouchDB administrative or destructive requests (`_compact`, `_purge`, `_view_cleanup`, database `DELETE`).
3. **Durable 5-Tuple Arming Gate (CONF-07, DIST-02)**: All write-capable commands (`sync`, `daemon --write`) strictly require a pre-issued, active, un-revoked write grant matching the 5-tuple (`remoteFingerprint`, `vaultRoot`, `settingsHash`, `commonlibVersion`, `bootstrapGeneration`).
4. **Inspectable Build Identity (DIST-03)**: `version` command and `--version` flag must output the exact compatibility contract (`1.0.23`, `0.1.21`, `3.5.2`, commit SHA, overrides).
5. **Zero Secret Leakage (DIST-05, SEC-03)**: Passwords, HKDF passphrases, and auth tokens are masked with `[REDACTED]` in all human and JSON Lines logs, reports, and error traces.

---

## 4. Test Blueprint & Validation Strategy

```
tests/
├── unit/
│   ├── identity.test.ts          # DIST-03: Build identity, version reporting, dependency overrides
│   ├── status-command.test.ts    # DIST-02: Status command querying local SQLite state
│   └── release-audit.test.ts     # DIST-05: Static checks for forbidden methods, secrets, providers
├── integration/
│   ├── packaged-binary.test.ts   # DIST-01, DIST-02: SEA binary execution in isolated PATH
│   └── mixed-client-interop.test.ts # COMP-07, DIST-04: Upstream client coexistence with CouchDB 3.5.2
└── scripts/
    ├── build-sea.mjs             # Packaging script (esbuild + sea-config + postject)
    └── audit-release.ts          # CLI audit validator for pre-release verification
```

### Validation Strategy & Verification Commands
- `npm run test:unit`: Verifies identity formatting, status command logic, and release audit rules.
- `node scripts/build-sea.mjs`: Compiles the standalone executable `dist/obsidian-livesync-headless`.
- `vitest run tests/integration/packaged-binary.test.ts`: Runs standalone binary smoke and CLI flow tests in restricted environment.
- `vitest run tests/integration/mixed-client-interop.test.ts`: Runs full mixed-client compatibility matrix against Testcontainers CouchDB 3.5.2.
- `npx tsx scripts/audit-release.ts`: Runs static analysis release safety gate.
