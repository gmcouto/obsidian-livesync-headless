# Phase 3 Research: Recoverable Pull Operations

**Domain:** Obsidian Self-Hosted LiveSync — Crash-Safe Reflection, Recoverable Quarantine, Resumable Pull, and Idempotent Verification
**Status:** Completed
**Date:** 2026-09-05
**Author:** GSD Phase Researcher

---

## Executive Summary

Phase 3 builds directly upon the verified pull materialization foundation established in Phase 2 (decoding, chunk assembly, path policy, capability-gated atomic reflection, and post-verify SQLite provenance). The primary objective of Phase 3 is to make pull operations **fully recoverable, collision-safe, resumable, repeatably idempotent, and fail-closed against partial failures or crashes** before any remote write capability (Phase 4) is introduced.

Specifically, Phase 3 addresses four mandatory requirements:
- **PULL-04**: Displaced or remotely deleted local files move to collision-safe recoverable quarantine outside the vault, stopping before removal if recoverability cannot be guaranteed.
- **PULL-06**: Interrupted or partially blocked pull operations can be safely resumed without treating partial/temporary files as local edits or advancing checkpoints past unverified data.
- **PULL-08**: Rerunning a completed pull with no remote changes produces a deterministic, idempotent no-op without re-writing files or mutating provenance.
- **SAFE-05**: Durable state (admission records, revision provenance, quarantine index, operation journal, and checkpoints) is persisted transactionally in SQLite outside the vault namespace.

---

## 1. Architectural Responsibility Map

| Component / Subsystem | Primary Responsibility | Invariants & Constraints |
|---|---|---|
| **Storage (`src/storage/sqlite.ts`)** | Owns schema migrations (`schema_migrations`), WAL mode, and connection lifecycle. [VERIFIED: `src/storage/sqlite.ts:5-84`] | Must maintain strict schema versioning. Never stores secrets, passphrases, or plaintext file bodies in any table. |
| **Quarantine Storage (`src/storage/quarantine-repo.ts` & `src/filesystem/quarantine-store.ts`)** | Manages physical quarantine directory outside vault (`<stateRoot>/quarantine/`) and SQLite metadata index `quarantine`. | Quarantine move is transactional: copy & verify read-back in quarantine, insert index row in SQLite, and only then unlink vault file. Stops before unlink if quarantine fails. [VERIFIED: `src/storage/sqlite.ts:48-62`] |
| **Provenance Repository (`src/storage/provenance-repo.ts`)** | Tracks exact reflected remote revision, SHA-256 hash, and observed mtime. | Extended to support deletion (`deleteProvenance`) upon safe file quarantine, and batch inspection for diff comparison. [VERIFIED: `src/storage/provenance-repo.ts:15-72`] |
| **Checkpoint Repository (`src/storage/checkpoint-repo.ts`)** | Durably records opaque CouchDB `last_update_seq` per remote fingerprint only after a pull completes fully. | Never advances past unverified, skipped-conflict, or blocked documents. |
| **Atomic Reflector (`src/filesystem/atomic-reflector.ts`)** | Stages writes into same-directory temporary files (`.ols-tmp-*`), flushes, renames, and verifies read-back. [VERIFIED: `src/filesystem/atomic-reflector.ts:45-88`] | Orphan staging file cleanup ensures interrupted previous runs do not pollute the vault or trip preflight unproven file checks. |
| **Pull Planner (`src/domain/pull-plan.ts`)** | Compares remote inventory observations against local provenance and filesystem state to produce `create`, `noop`, `quarantine-delete`, `skip-*`, or `block` actions. [VERIFIED: `src/domain/pull-plan.ts:6-19`] | If remote revision and content hash match local provenance and file exists, yields `noop`. If remotely deleted and locally present, yields `quarantine-delete`. |
| **Vault Preflight (`src/filesystem/vault-preflight.ts`)** | Validates vault directory contents, detects symlinks, unproven files, and cleans leftover `.ols-tmp-*` files. [VERIFIED: `src/filesystem/vault-preflight.ts:83-127`] | Distinguishes known staging temporaries from unproven user files. |
| **Pull Command (`src/cli/commands/pull.ts`)** | Coordinates admission, inventory, planning, capability validation, recovery, and diagnostics. [VERIFIED: `src/cli/commands/pull.ts:71-107`] | Gated by `VaultReflectCapability`. Surfaces rich diagnostic counts (`created`, `quarantined`, `noop`, `blocked`, `skipped`). |

---

## 2. Standard Stack & Package Legitimacy Audit

### 2.1 Stack Components

- **Runtime:** Node.js 24 LTS (`node:sqlite` built-in `DatabaseSync`, `node:fs/promises`, `node:crypto`, `node:path`) [VERIFIED: `package.json:21`].
- **Core Library:** `@vrtmrz/livesync-commonlib` `0.1.21` (pinned, isolated to `src/livesync/decode-adapter.ts`) [VERIFIED: `package.json:15`].
- **Test Framework:** Vitest `4.1.11` with `@testcontainers/couchdb` `12.1.0` [VERIFIED: `package.json:20,25`].

### 2.2 Package Legitimacy Audit

- **Zero New Dependencies Required:** Phase 3 requires **0** additional npm dependencies. All requirements (WAL-mode SQLite tables, collision-safe file quarantine, sha256 content verification, atomic file reflection, and orphan cleanup) are implemented using standard Node.js 24 built-in modules (`node:sqlite`, `node:fs/promises`, `node:crypto`, `node:path`).
- **No Native Compiles:** `node:sqlite` is bundled in Node.js 24 LTS and requires no external native compilation (`better-sqlite3` or `sqlite3` packages are not needed).

---

## 3. Architecture Patterns & Diagrams

### 3.1 Recoverable Pull Lifecycle & State Machine

```text
+-------------------------------------------------------------------------------+
|                                PULL INITIATION                                |
+-------------------------------------------------------------------------------+
                                       |
                                       v
                     +-----------------------------------+
                     | 1. Config & Secret Resolution     |
                     |    State vs Vault path check      |
                     +-----------------------------------+
                                       |
                                       v
                     +-----------------------------------+
                     | 2. Startup Orphan Temp Cleanup    |
                     |    Purge stale .ols-tmp-* files   |
                     +-----------------------------------+
                                       |
                                       v
                     +-----------------------------------+
                     | 3. Read-Only Probe & Zero-Mutation|
                     |    Snapshot pre-probe update_seq  |
                     +-----------------------------------+
                                       |
                                       v
                     +-----------------------------------+
                     | 4. Compatibility Negotiation      |
                     |    Verify Syncinfo & Settings     |
                     +-----------------------------------+
                                       |
                                       v
                     +-----------------------------------+
                     | 5. Inventory & Decode Remote Docs |
                     |    Fetch chunks, decrypt leaves   |
                     +-----------------------------------+
                                       |
                                       v
                     +-----------------------------------+
                     | 6. Reconcile Plan vs Provenance   |
                     |    - Same rev & hash  -> NOOP     |
                     |    - New/Updated rev  -> CREATE   |
                     |    - Deleted & exists -> DELETE   |
                     |    - Multiple leaves  -> CONFLICT |
                     +-----------------------------------+
                                       |
                   +-------------------+-------------------+
                   |                                       |
                   v (Dry-Run / Blocks)                    v (Apply Mode, No Blocks)
       +-----------------------+              +-----------------------------------+
       | Emit Diagnostic Report|              | Issue VaultReflectCapability      |
       | Exit with status code |              +-----------------------------------+
       +-----------------------+                               |
                                                               v
                                              +-----------------------------------+
                                              | 7. Execute Actions:               |
                                              |    a) Quarantine Deletions:       |
                                              |       Copy -> DB Index -> Unlink  |
                                              |    b) Atomic Installations:       |
                                              |       Temp -> Sync -> Rename ->   |
                                              |       Readback Verify -> Save DB  |
                                              +-----------------------------------+
                                                               |
                                                               v
                                              +-----------------------------------+
                                              | 8. Commit Pull Checkpoint         |
                                              |    Record update_seq in SQLite    |
                                              +-----------------------------------+
                                                               |
                                                               v
                                              +-----------------------------------+
                                              | 9. Zero-Mutation Verification     |
                                              |    Assert CouchDB unmutated       |
                                              +-----------------------------------+
                                                               |
                                                               v
                                              +-----------------------------------+
                                              | 10. Emit Success Report (Exit 0)  |
                                              +-----------------------------------+
```

### 3.2 Collision-Safe Quarantine Architecture

```text
Local Vault Directory:                     External State Directory:
/path/to/vault/                            /path/to/state/
  ├── notes/                                 ├── livesync.db (SQLite WAL)
  │    └── OldNote.md (remotely deleted)     │     └── quarantine table
  └── ...                                    └── quarantine/
                                                   └── 20260905_143000_a1b2c3d4/
                                                         └── notes/OldNote.md

Step 1: Read OldNote.md -> compute content_sha256 = 'a1b2c3d4...'
Step 2: Create quarantine destination folder: quarantine/<timestamp>_<hash_prefix>/
Step 3: Copy OldNote.md to quarantine destination & verify read-back bytes
Step 4: Execute SQLite INSERT INTO quarantine (...)
Step 5: Unlink /path/to/vault/notes/OldNote.md & execute DELETE FROM file_provenance WHERE path = 'notes/OldNote.md'
Step 6: If Step 2, 3, or 4 fails, abort with error -> local file is PRESERVED in vault
```

---

## 4. Don't Hand-Roll & Common Pitfalls

### 4.1 Don't Hand-Roll

| Problem | Recommended Standard / Built-in | Why Hand-Rolling Fails |
|---|---|---|
| **Durable State Storage** | `node:sqlite` `DatabaseSync` with WAL mode [VERIFIED: `src/storage/sqlite.ts:74-84`] | Custom JSON state files are vulnerable to partial write corruptions, truncation on power loss, and race conditions. |
| **Content Integrity** | `node:crypto` `createHash('sha256')` [VERIFIED: `src/domain/pull-plan.ts:1`] | Comparing file size or mtime alone causes false negatives or missed corruptions. |
| **Path Traversal Protection** | Pinned `validateStoragePath` + `assertSafeVaultRelativePath` [VERIFIED: `src/domain/path-policy.ts:13-15`] | Custom regexes miss URL-encoded slashes, backslash variants on Windows, or UTF-8 normalize ambiguities. |
| **Quarantine Isolation** | Storing files strictly inside `<stateRoot>/quarantine/` with relative subpaths | Storing quarantined files inside the vault (e.g. `.trash` or `.quarantine`) pollutes user vault space and causes watcher feedback loops in Phase 5. |

### 4.2 Common Pitfalls in Phase 3

- **Pitfall 1: Unsafe File Unlink on Remote Deletion (PULL-04 Violation)**
  - *Risk:* Calling `fs.unlink()` directly when a remote deletion or tombstone is observed. If the remote deletion was accidental or uncoordinated, user data is irrecoverably destroyed.
  - *Mitigation:* Implement `QuarantineManager`. Every deletion moves the file to `<stateRoot>/quarantine/` with a unique collision-safe timestamp/hash prefix, inserts a record in SQLite `quarantine` table, and only then deletes the vault file. If quarantine creation fails, deletion is aborted.
- **Pitfall 2: Orphan Temp Staging Files Blocking Preflight on Resume (PULL-06 Violation)**
  - *Risk:* If a pull is killed via SIGINT/SIGKILL during atomic reflection, `.ols-tmp-*` sibling files remain in the vault. On the subsequent run, `preflightVault` scans all entries and blocks with `UNPROVEN_LOCAL_FILE`.
  - *Mitigation:* Add explicit orphan cleanup to preflight/startup: scan and safely unlink `.ols-tmp-*` files (which are strictly temporary staging buffers) before evaluating preflight rules.
- **Pitfall 3: Re-materializing Identical Files on Rerun (PULL-08 Violation)**
  - *Risk:* Running `pull` repeatedly on an unchanged vault re-stages, re-writes, and re-verifies every file on disk, wearing SSDs and triggering unnecessary filesystem events.
  - *Mitigation:* In `buildPullPlan`, cross-reference each remote leaf against SQLite `file_provenance`. If `remoteRevision` matches and local file exists with matching `content_sha256`, classify as `noop`. If all actions are `noop`, report `SUCCESS` with 0 creates and 0 deletes.
- **Pitfall 4: Advancing Checkpoints Across Partial Failures (SAFE-05 / PULL-06 Violation)**
  - *Risk:* Storing the remote `update_seq` checkpoint when some files failed decryption, had missing chunks, or had conflict leaves.
  - *Mitigation:* The checkpoint repository only updates `pull_checkpoints` when `blockActions.length === 0` and all planned operations have successfully completed and verified.
- **Pitfall 5: Database Mutation on Dry-Run (SAFE-01 / SAFE-02 Violation)**
  - *Risk:* Writing to SQLite `quarantine` or `file_provenance` during `--dry-run`.
  - *Mitigation:* Dry-run only reads SQLite state to compute the diff and formats the report; mutations require `VaultReflectCapability` which is strictly withheld during dry-run [VERIFIED: `src/cli/commands/pull.ts:451-463`].

---

## 5. In-Repo Discrete Values & Verbatim Citations

### 5.1 Diagnostic Exit Codes and Outcomes
From `src/diagnostics/outcomes.ts:1-25` [VERIFIED: `src/diagnostics/outcomes.ts:1-25`]:
```typescript
export const OutcomeCategory = {
  SUCCESS: 'SUCCESS',
  CONFIG_ERROR: 'CONFIG_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  INCOMPATIBLE: 'INCOMPATIBLE',
  NOT_FOUND: 'NOT_FOUND',
  TRANSIENT_OUTAGE: 'TRANSIENT_OUTAGE',
  MUTATION_VIOLATION: 'MUTATION_VIOLATION',
  CORRUPTION: 'CORRUPTION',
  CONFLICT: 'CONFLICT',
} as const;

export const EXIT_CODES: Record<OutcomeCategory, number> = {
  SUCCESS: 0,
  CONFIG_ERROR: 1,
  AUTHENTICATION_ERROR: 2,
  INCOMPATIBLE: 3,
  NOT_FOUND: 4,
  TRANSIENT_OUTAGE: 5,
  MUTATION_VIOLATION: 6,
  CORRUPTION: 7,
  CONFLICT: 8,
};
```

### 5.2 Current SQLite Schema Version and Tables
From `src/storage/sqlite.ts:5-63` [VERIFIED: `src/storage/sqlite.ts:5-63`]:
```typescript
export const CURRENT_SCHEMA_VERSION = 2;

// Migration 001: remote_admission table
// id INTEGER PRIMARY KEY AUTOINCREMENT, remote_fingerprint TEXT NOT NULL UNIQUE, couchdb_url, database_name, couchdb_version, version_info_rev, milestone_rev, sync_params_rev, negotiated_settings_hash, negotiated_settings_json, update_seq, admitted_at

// Migration 002: file_provenance table
// path TEXT PRIMARY KEY, remote_revision TEXT NOT NULL, content_sha256 TEXT NOT NULL, observed_mtime INTEGER, remote_fingerprint TEXT NOT NULL, reflected_at TEXT NOT NULL
```

### 5.3 Existing Pull Action Types
From `src/domain/pull-plan.ts:6-19` [VERIFIED: `src/domain/pull-plan.ts:6-19`]:
```typescript
export type PullAction =
  | { kind: 'create'; path: string; sourceRevision: string; bytes: Uint8Array }
  | { kind: 'skip-logical-delete'; path: string; sourceRevision: string }
  | { kind: 'skip-special'; id: string; type: string }
  | { kind: 'skip-ignored'; path: string }
  | {
      kind: 'block';
      path?: string;
      id: string;
      code: string;
      message: string;
      suggestion?: string;
    };
```

*(Note for Phase 3: We will extend `PullAction` to include `kind: 'quarantine-delete'` and `kind: 'noop'`)*.

### 5.4 Capability Branding
From `src/security/capabilities.ts:21-27,76-78` [VERIFIED: `src/security/capabilities.ts:21-27,76-78`]:
```typescript
export interface VaultReflectCapability {
  readonly [VaultReflectCapabilityBrand]: true;
  readonly baseUrl: URL;
  readonly databaseName: string;
  readonly vaultRoot: string;
  readonly issuedAt: Date;
}

export function isVaultReflectCapability(cap: unknown): cap is VaultReflectCapability {
  return Boolean(cap && typeof cap === 'object' && VaultReflectCapabilityBrand in cap);
}
```

---

## 6. Code Examples & Design Specifications

### 6.1 SQLite Migrations 003 and 004

```typescript
// Migration 003: quarantine index table
if (!appliedVersions.has(3)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_path TEXT NOT NULL,
      quarantine_path TEXT NOT NULL,
      remote_revision TEXT,
      content_sha256 TEXT NOT NULL,
      reason TEXT NOT NULL,
      quarantined_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quarantine_path ON quarantine(original_path);
  `);

  const stmt = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  stmt.run(3, new Date().toISOString());
}

// Migration 004: pull_checkpoints table
if (!appliedVersions.has(4)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pull_checkpoints (
      remote_fingerprint TEXT PRIMARY KEY,
      last_update_seq TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
  `);

  const stmt = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  stmt.run(4, new Date().toISOString());
}
```

### 6.2 Quarantine Manager

```typescript
export interface QuarantineRecord {
  readonly id?: number;
  readonly originalPath: string;
  readonly quarantinePath: string;
  readonly remoteRevision?: string;
  readonly contentSha256: string;
  readonly reason: 'REMOTE_DELETION' | 'DIVERGENT_DISPLACEMENT';
  readonly quarantinedAt: string;
}

export async function quarantineVaultFile(
  vaultRoot: string,
  stateRoot: string,
  relativePath: string,
  remoteRevision: string | undefined,
  quarantineRepo: QuarantineRepository
): Promise<QuarantineRecord> {
  const fullVaultPath = join(vaultRoot, relativePath);
  const fileBytes = await readFile(fullVaultPath);
  const hash = createHash('sha256').update(fileBytes).digest('hex');
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeUniqueSubdir = `${timestamp}_${hash.slice(0, 8)}`;
  const quarantineDir = join(stateRoot, 'quarantine', safeUniqueSubdir);
  await mkdir(quarantineDir, { recursive: true });

  const destQuarantinePath = join(quarantineDir, relativePath);
  await mkdir(dirname(destQuarantinePath), { recursive: true });
  
  // Write to quarantine and verify
  await writeFile(destQuarantinePath, fileBytes);
  const readBack = await readFile(destQuarantinePath);
  if (!Buffer.from(readBack).equals(Buffer.from(fileBytes))) {
    throw new Error(`Quarantine read-back verification failed for '${relativePath}'`);
  }

  // Record in SQLite
  const record: QuarantineRecord = {
    originalPath: relativePath,
    quarantinePath: destQuarantinePath,
    remoteRevision,
    contentSha256: hash,
    reason: 'REMOTE_DELETION',
    quarantinedAt: new Date().toISOString(),
  };
  quarantineRepo.saveQuarantine(record);

  // Now safely remove from vault
  await unlink(fullVaultPath);
  return record;
}
```

### 6.3 Reconciled Pull Planning with Provenance

```typescript
export function buildRecoverablePullPlan(
  observations: readonly PullObservation[],
  existingProvenance: Map<string, ProvenanceRecord>,
  existingVaultFiles: Set<string>
): PullAction[] {
  const actions: PullAction[] = [];
  // For each remote document group:
  // - If deleted remotely and exists locally -> quarantine-delete
  // - If deleted remotely and not in vault -> skip-logical-delete
  // - If live and matches existingProvenance (rev & sha256) and exists locally -> noop
  // - If live and new / updated rev -> create
  // - If multiple live non-deleted leaves -> block CONFLICT_LEAVES
  return actions;
}
```

---

## 7. Assumptions Log

| # | Assumption | Confidence | Validation Strategy |
|---|---|---|---|
| 1 | Quarantine destination on same filesystem or across volumes works reliably with explicit read-back check. | HIGH | Unit test `quarantineVaultFile` with mock and real filesystem writes + verify integrity check throws on corruption. |
| 2 | Cleaning leftover `.ols-tmp-*` sibling files during startup does not risk active writes when process lock is held. | HIGH | Verify process-exclusive run lock pattern and unit test cleanup of stale `.ols-tmp-*` files before preflight. |
| 3 | SQLite `DatabaseSync` in Node 24 handles table creations, foreign keys, and WAL transactions without locking issues. | HIGH | Verified across existing test suites (`tests/unit/provenance-repo.test.ts`, `tests/unit/admission-repo.test.ts`). |
| 4 | CouchDB testcontainers in integration test harness can cleanly simulate deleted revisions (`_deleted: true` and LiveSync `deleted: true`). | HIGH | Characterization tests in `couchdb-harness.ts` with `putDocument` and verify inventory returns tombstones. |

---

## 8. Validation Architecture

### 8.1 Test Suites & Test Harness

- **Runner:** Vitest 4.1.11 via `npm test` [VERIFIED: `package.json:10,25`].
- **Unit Tests (`tests/unit/`):**
  - `quarantine-store.test.ts`: Prove collision safety, read-back verification, fail-closed before unlink, and SQLite metadata indexing.
  - `checkpoint-repo.test.ts`: Prove checkpoint persistence, non-advancement on blocked actions, and fingerprint binding.
  - `recoverable-pull-plan.test.ts`: Prove `noop` generation on identical provenance/files, `quarantine-delete` generation on remote deletions, and conflict leaf isolation.
  - `orphan-cleanup.test.ts`: Prove stale `.ols-tmp-*` removal without touching user files.
- **Integration Tests (`tests/integration/`):**
  - `pull-recovery.test.ts`: Ephemeral CouchDB container tests:
    - Rerun completed pull: Assert 0 writes, outcome `SUCCESS`, idempotent output (PULL-08).
    - Remote deletion: Assert local file moved to quarantine directory, indexed in SQLite, removed from vault, and zero CouchDB mutation (PULL-04).
    - Interrupted pull simulation: Simulate crash after N files; verify restart resumes remaining files and completes cleanly without data corruption (PULL-06).
    - Durable state isolation: Verify all SQLite tables and quarantine files reside outside vault root (SAFE-05).

---

## 9. Security Domain (ASVS & STRIDE)

### 9.1 OWASP ASVS Alignment
- **V1 Architecture:** Separation of vault user files and external metadata state (`resolvedStatePath !== resolvedVaultPath`). Zero push permissions in pull commands.
- **V5 Input & Path Validation:** Relative path sanitization prevents directory traversal attacks escaping quarantine or vault directories.
- **V8 Data Protection:** Absolute zero secret or password persistence in SQLite tables (`quarantine`, `file_provenance`, `remote_admission`, `pull_checkpoints`).

### 9.2 STRIDE Threat Model

| Threat Category | Potential Attack / Failure Mode | Mitigation Strategy |
|---|---|---|
| **Spoofing** | Forging quarantine or provenance records. | SQLite state is protected by filesystem permissions outside the vault. |
| **Tampering** | Stale `.ols-tmp-*` staging file treated as valid user data after interrupted pull. | Preflight cleans temporary files; provenance is only written after full read-back verification. |
| **Repudiation** | Ambiguity about why a local file disappeared after remote deletion. | SQLite `quarantine` table durably records `original_path`, `quarantine_path`, `remote_revision`, `content_sha256`, and `quarantined_at`. |
| **Information Disclosure** | Plaintext encryption keys or remote credentials stored in quarantine or SQLite. | Sensitive parameters strictly redacted and excluded from all storage tables. |
| **Denial of Service** | Disk-full or permission error during quarantine causing partial or corrupt deletion. | Reflection stops immediately if quarantine write fails; local file remains untouched. |
| **Elevation of Privilege** | Path traversal in deleted file name attempting to escape quarantine root. | `assertSafeVaultRelativePath` sanitizes every relative path before quarantine destination resolution. |

---

## Conclusion & Plan Readiness

Phase 3 is technically unambiguous and ready for task decomposition into implementation plans:
1. **Plan 01:** Schema migrations (Quarantine & Checkpoints), `QuarantineRepository`, `CheckpointRepository`, and `quarantineVaultFile` implementation with unit tests.
2. **Plan 02:** Pull planner enhancement (reconciling with provenance for `noop` and `quarantine-delete`), orphan temp cleanup, and preflight update.
3. **Plan 03:** Pull coordinator integration (`applyVerifiedPull` handling quarantine and checkpoints, idempotent diagnostics, and error handling).
4. **Plan 04:** Comprehensive Testcontainers CouchDB integration test suite verifying PULL-04, PULL-06, PULL-08, and SAFE-05.
