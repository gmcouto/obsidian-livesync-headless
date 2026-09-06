# Phase 3: Recoverable Pull Operations - Pattern Map

**Mapped:** 2026-09-05  
**Files Analyzed:** 30+  
**Scope:** Storage migrations (003, 004), SQLite repositories, collision-safe quarantine store, pull planning with provenance reconciliation, atomic orphan cleanup, pull coordinator execution, and recovery integration tests.

---

## 1. File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/storage/sqlite.ts` | migration | schema | `src/storage/sqlite.ts` (extend migrations) | exact |
| `src/storage/quarantine-repo.ts` | model | CRUD | `src/storage/provenance-repo.ts` | exact |
| `src/storage/checkpoint-repo.ts` | model | CRUD | `src/storage/provenance-repo.ts` | exact |
| `src/storage/provenance-repo.ts` | model | CRUD | `src/storage/provenance-repo.ts` (extend in place) | exact |
| `src/filesystem/quarantine-store.ts` | service | file-I/O | `src/filesystem/atomic-reflector.ts` | role-match |
| `src/filesystem/orphan-cleanup.ts` | utility | file-I/O | `src/filesystem/vault-preflight.ts` | role-match |
| `src/filesystem/vault-preflight.ts` | service | file-I/O | `src/filesystem/vault-preflight.ts` (extend with orphan cleanup) | exact |
| `src/domain/pull-plan.ts` | domain | transform | `src/domain/pull-plan.ts` (extend actions & reconciliation) | exact |
| `src/cli/commands/pull.ts` | controller | orchestration | `src/cli/commands/pull.ts` (extend `applyVerifiedPull` & error flow) | exact |
| `src/diagnostics/formatters.ts` | utility | transform | `src/diagnostics/formatters.ts` (extend `formatPullHumanReport`) | exact |
| `tests/unit/quarantine-repo.test.ts` | test | CRUD | `tests/unit/provenance-repo.test.ts` | exact |
| `tests/unit/checkpoint-repo.test.ts` | test | CRUD | `tests/unit/provenance-repo.test.ts` | exact |
| `tests/unit/quarantine-store.test.ts` | test | file-I/O | `tests/unit/atomic-reflector.test.ts` | exact |
| `tests/unit/recoverable-pull-plan.test.ts` | test | transform | `tests/unit/pull-plan.test.ts` | exact |
| `tests/unit/orphan-cleanup.test.ts` | test | file-I/O | `tests/unit/vault-preflight.test.ts` | exact |
| `tests/unit/pull-coordinator.test.ts` | test | orchestration | `tests/unit/atomic-reflector.test.ts` | role-match |
| `tests/integration/couchdb-harness.ts` | test-helper | CRUD | `tests/integration/couchdb-harness.ts` (extend with tombstones) | exact |
| `tests/integration/pull-recovery.test.ts` | integration-test | end-to-end | `tests/integration/pull-apply.test.ts` | exact |

---

## 2. Pattern Assignments & Implementation Blueprints

### 2.1 Storage & Schema Migrations (`src/storage/sqlite.ts`)
**Analog:** [sqlite.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/storage/sqlite.ts#L5-L63)

Extend `runMigrations` to add migration 003 (`quarantine`) and migration 004 (`pull_checkpoints`), updating `CURRENT_SCHEMA_VERSION = 4`.

```typescript
export const CURRENT_SCHEMA_VERSION = 4;

export function runMigrations(db: DatabaseSync): void {
  // Existing migration 001 & 002...

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
}
```

---

### 2.2 Quarantine Repository (`src/storage/quarantine-repo.ts`)
**Analog:** [provenance-repo.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/storage/provenance-repo.ts#L3-L72)

Repository for inserting and querying quarantined file metadata outside the vault.

```typescript
import type { DatabaseSync } from 'node:sqlite';

export interface QuarantineRecord {
  readonly id?: number;
  readonly originalPath: string;
  readonly quarantinePath: string;
  readonly remoteRevision?: string | null;
  readonly contentSha256: string;
  readonly reason: 'REMOTE_DELETION' | 'DIVERGENT_DISPLACEMENT';
  readonly quarantinedAt: string;
}

export class QuarantineRepository {
  constructor(private readonly db: DatabaseSync) {}

  saveQuarantine(record: QuarantineRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO quarantine (
        original_path,
        quarantine_path,
        remote_revision,
        content_sha256,
        reason,
        quarantined_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      record.originalPath,
      record.quarantinePath,
      record.remoteRevision ?? null,
      record.contentSha256,
      record.reason,
      record.quarantinedAt
    );
    return Number(result.lastInsertRowid);
  }

  listByOriginalPath(originalPath: string): QuarantineRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, original_path, quarantine_path, remote_revision, content_sha256, reason, quarantined_at
      FROM quarantine
      WHERE original_path = ?
      ORDER BY id DESC
    `);
    const rows = stmt.all(originalPath) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      originalPath: String(row.original_path),
      quarantinePath: String(row.quarantine_path),
      remoteRevision: row.remote_revision ? String(row.remote_revision) : null,
      contentSha256: String(row.content_sha256),
      reason: row.reason as QuarantineRecord['reason'],
      quarantinedAt: String(row.quarantined_at),
    }));
  }
}
```

---

### 2.3 Checkpoint Repository (`src/storage/checkpoint-repo.ts`)
**Analog:** [admission-repo.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/storage/admission-repo.ts#L63-L99)

Persists opaque CouchDB `update_seq` strictly after a complete, unblocked pull operation.

```typescript
import type { DatabaseSync } from 'node:sqlite';

export interface CheckpointRecord {
  readonly remoteFingerprint: string;
  readonly lastUpdateSeq: string;
  readonly completedAt: string;
}

export class CheckpointRepository {
  constructor(private readonly db: DatabaseSync) {}

  saveCheckpoint(record: CheckpointRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO pull_checkpoints (
        remote_fingerprint,
        last_update_seq,
        completed_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(remote_fingerprint) DO UPDATE SET
        last_update_seq = excluded.last_update_seq,
        completed_at = excluded.completed_at;
    `);

    stmt.run(record.remoteFingerprint, record.lastUpdateSeq, record.completedAt);
  }

  getCheckpoint(remoteFingerprint: string): CheckpointRecord | null {
    const stmt = this.db.prepare(`
      SELECT remote_fingerprint, last_update_seq, completed_at
      FROM pull_checkpoints
      WHERE remote_fingerprint = ?
    `);

    const row = stmt.get(remoteFingerprint) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    return {
      remoteFingerprint: String(row.remote_fingerprint),
      lastUpdateSeq: String(row.last_update_seq),
      completedAt: String(row.completed_at),
    };
  }
}
```

---

### 2.4 Provenance Repository Extensions (`src/storage/provenance-repo.ts`)
**Analog:** [provenance-repo.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/storage/provenance-repo.ts#L12-L72)

Extend existing repository to support `deleteProvenance` (for deleted/quarantined files) and `getAllProvenance` / `getMap`.

```typescript
export class ProvenanceRepository {
  // Existing saveProvenance, getByPath...

  deleteProvenance(path: string): void {
    const stmt = this.db.prepare('DELETE FROM file_provenance WHERE path = ?');
    stmt.run(path);
  }

  getAllAsMap(): Map<string, ProvenanceRecord> {
    const stmt = this.db.prepare(`
      SELECT path, remote_revision, content_sha256, observed_mtime, remote_fingerprint, reflected_at
      FROM file_provenance
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    const map = new Map<string, ProvenanceRecord>();
    for (const row of rows) {
      const record: ProvenanceRecord = {
        path: String(row.path),
        remoteRevision: String(row.remote_revision),
        contentSha256: String(row.content_sha256),
        observedMtime: row.observed_mtime === null || row.observed_mtime === undefined
          ? null
          : Number(row.observed_mtime),
        remoteFingerprint: String(row.remote_fingerprint),
        reflectedAt: String(row.reflected_at),
      };
      map.set(record.path, record);
    }
    return map;
  }
}
```

---

### 2.5 Quarantine Store (`src/filesystem/quarantine-store.ts`)
**Analog:** [atomic-reflector.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/filesystem/atomic-reflector.ts#L45-L88)

Safe, collision-resistant quarantine mechanism:
1. Verify source file exists in vault.
2. Read bytes and compute SHA-256.
3. Generate collision-safe timestamped folder `<stateRoot>/quarantine/<timestamp>_<hash8>/<relativePath>`.
4. Write file and verify read-back bytes.
5. Record metadata in SQLite `quarantine` table.
6. Safely `unlink` from vault and delete from `file_provenance`.
7. Fail-closed: if step 2, 3, 4, or 5 fails, abort without deleting the file from the vault.

```typescript
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertSafeVaultRelativePath } from '../domain/path-policy.js';
import type { QuarantineRepository, QuarantineRecord } from '../storage/quarantine-repo.js';

export class QuarantineError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'QuarantineError';
  }
}

export async function quarantineVaultFile(
  vaultRoot: string,
  stateRoot: string,
  relativePath: string,
  remoteRevision: string | undefined | null,
  quarantineRepo: QuarantineRepository,
  options?: {
    reason?: QuarantineRecord['reason'];
    writeFileFn?: (path: string, data: Uint8Array) => Promise<void>;
    readFileFn?: (path: string) => Promise<Buffer | Uint8Array>;
    unlinkFn?: (path: string) => Promise<void>;
  }
): Promise<QuarantineRecord> {
  assertSafeVaultRelativePath(relativePath);

  const fullVaultPath = join(vaultRoot, relativePath);
  const doReadFile = options?.readFileFn ?? readFile;
  const doWriteFile = options?.writeFileFn ?? writeFile;
  const doUnlink = options?.unlinkFn ?? unlink;

  let fileBytes: Uint8Array;
  try {
    fileBytes = new Uint8Array(await doReadFile(fullVaultPath));
  } catch (err) {
    throw new QuarantineError(`Failed to read source file for quarantine: '${relativePath}'`, err);
  }

  const hash = createHash('sha256').update(fileBytes).digest('hex');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeUniqueSubdir = `${timestamp}_${hash.slice(0, 8)}`;
  const quarantineDir = join(stateRoot, 'quarantine', safeUniqueSubdir);
  const destQuarantinePath = join(quarantineDir, relativePath);

  try {
    await mkdir(dirname(destQuarantinePath), { recursive: true });
    await doWriteFile(destQuarantinePath, fileBytes);
    
    // Read-back verification
    const readBack = new Uint8Array(await doReadFile(destQuarantinePath));
    if (!Buffer.from(readBack).equals(Buffer.from(fileBytes))) {
      throw new Error(`Quarantine read-back verification failed for '${relativePath}'`);
    }

    const record: QuarantineRecord = {
      originalPath: relativePath,
      quarantinePath: destQuarantinePath,
      remoteRevision: remoteRevision ?? null,
      contentSha256: hash,
      reason: options?.reason ?? 'REMOTE_DELETION',
      quarantinedAt: new Date().toISOString(),
    };

    quarantineRepo.saveQuarantine(record);
    await doUnlink(fullVaultPath);
    return record;
  } catch (err) {
    throw new QuarantineError(`Failed to safely quarantine '${relativePath}'; file preserved in vault`, err);
  }
}
```

---

### 2.6 Orphan Staging File Cleanup (`src/filesystem/orphan-cleanup.ts`)
**Analog:** [vault-preflight.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/filesystem/vault-preflight.ts#L25-L81)

Scans the vault directory for leftover temporary staging files (`.ols-tmp-*`) generated by interrupted pull attempts, and unlinks them safely before preflight evaluation.

```typescript
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../diagnostics/logger.js';

export const OLS_TMP_PREFIX = '.ols-tmp-';

export async function cleanupOrphanStagingFiles(vaultPath: string, prefix = ''): Promise<number> {
  let cleanedCount = 0;
  let entries;
  try {
    entries = await readdir(vaultPath, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw err;
  }

  for (const entry of entries) {
    const fullPath = join(vaultPath, entry.name);
    if (entry.isDirectory()) {
      cleanedCount += await cleanupOrphanStagingFiles(fullPath, `${prefix}${entry.name}/`);
    } else if (entry.isFile() && entry.name.startsWith(OLS_TMP_PREFIX)) {
      try {
        await unlink(fullPath);
        cleanedCount += 1;
        logger.info('Cleaned orphan staging file', { path: `${prefix}${entry.name}` });
      } catch (err) {
        logger.warn('Failed to clean orphan staging file', {
          path: `${prefix}${entry.name}`,
          error: (err as Error).message,
        });
      }
    }
  }

  return cleanedCount;
}
```

---

### 2.7 Reconciled Pull Planning (`src/domain/pull-plan.ts`)
**Analog:** [pull-plan.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/domain/pull-plan.ts#L6-L174)

Extend `PullAction` union with `quarantine-delete` and `noop`. Implement `buildRecoverablePullPlan` which cross-references remote observations against local SQLite `ProvenanceRecord`s and filesystem existence.

```typescript
export type PullAction =
  | { kind: 'create'; path: string; sourceRevision: string; bytes: Uint8Array }
  | { kind: 'noop'; path: string; sourceRevision: string; contentSha256: string }
  | { kind: 'quarantine-delete'; path: string; sourceRevision?: string }
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

export interface LocalFileInspection {
  readonly exists: boolean;
  readonly contentSha256?: string;
}

export function buildRecoverablePullPlan(
  observations: readonly PullObservation[],
  existingProvenance: Map<string, ProvenanceRecord>,
  localFiles: Map<string, LocalFileInspection>
): PullAction[] {
  // 1. Process specials, ignored, blocks, and group note observations by path.
  // 2. If multiple live leaves -> block CONFLICT_LEAVES.
  // 3. If all leaves deleted:
  //    - If local file exists -> action: 'quarantine-delete'
  //    - If local file absent -> action: 'skip-logical-delete'
  // 4. If live leaf:
  //    - Compute incoming contentSha256
  //    - If local file exists AND local provenance matches rev & hash AND local file hash matches -> action: 'noop'
  //    - Else -> action: 'create'
}
```

---

### 2.8 Pull Coordinator Integration (`src/cli/commands/pull.ts`)
**Analog:** [pull.ts](file:///mnt/zfspool/appdata/code-server/workspace/obsidian-livesync-headless/src/cli/commands/pull.ts#L71-L107)

Update `applyVerifiedPull` and `runPullCommand`:
1. Execute `cleanupOrphanStagingFiles` at the start of pull preflight.
2. Load existing provenance map from SQLite outside the vault.
3. Compute recoverable pull plan (distinguishing `create`, `noop`, `quarantine-delete`).
4. In apply mode (guarded by `VaultReflectCapability`):
   - For `quarantine-delete`: Call `quarantineVaultFile`, then `provenanceRepo.deleteProvenance(action.path)`.
   - For `create`: Call `installAtomically`, read `stat`, and `provenanceRepo.saveProvenance`.
   - For `noop`: Log / record 0-write no-op.
   - On full success (0 block actions): Commit checkpoint in `CheckpointRepository` with remote `update_seq`.

---

## 3. Invariants & Security Boundaries

### 3.1 Critical Invariants
1. **Zero CouchDB Write:** Under no circumstance does `pull` perform HTTP `PUT`, `POST`, or `DELETE` on the CouchDB remote.
2. **Fail-Closed Before Unlink:** Quarantining a file MUST verify read-back bytes in `<stateRoot>/quarantine/` and commit SQLite metadata BEFORE calling `fs.unlink()` in the vault. If any prior step fails, the vault file is preserved intact.
3. **Outside Vault Isolation:** The SQLite state database (`livesync.db` / `admission.sqlite`) and `<stateRoot>/quarantine/` directories MUST strictly reside outside the vault root directory (`statePath !== vaultPath` and `!statePath.startsWith(vaultPath)`).
4. **Idempotent Reruns:** Running pull when remote revision and local provenance/hash match produces `noop` actions with 0 file writes and 0 metadata churn.
5. **Atomic Resumption:** Interrupted pull runs do not advance `pull_checkpoints`. Stale `.ols-tmp-*` staging files are safely cleaned upon startup without flagging as unproven local files.

---

## 4. Test Blueprint & Validation Strategy

```
tests/
├── unit/
│   ├── quarantine-repo.test.ts        # Table creation, CRUD, column security
│   ├── checkpoint-repo.test.ts        # Upsert, query, fingerprint matching
│   ├── quarantine-store.test.ts       # Collision-safe subdirs, read-back verify, fail-closed
│   ├── recoverable-pull-plan.test.ts  # noop, quarantine-delete, conflict leaves
│   ├── orphan-cleanup.test.ts         # .ols-tmp-* removal, preserving user files
│   └── pull-coordinator.test.ts       # Capability gating, apply sequence, rollback safety
└── integration/
    ├── couchdb-harness.ts             # Tombstone / deletion seed helpers
    └── pull-recovery.test.ts          # Idempotent rerun, deletion quarantine, crash recovery
```

---
