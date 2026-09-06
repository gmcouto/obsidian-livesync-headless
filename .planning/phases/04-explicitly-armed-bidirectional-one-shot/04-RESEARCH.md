# Phase 4: Explicitly Armed Bidirectional One-Shot - Research

**Researched:** 2026-09-06  
**Domain:** Obsidian Self-Hosted LiveSync — Armed Write Authorization, Chunk-First Push, Logical Deletion, Case/Cross-Path Renames, Conflict Preservation, and Convergence Reconciliation  
**Confidence:** HIGH  

## Summary

Phase 4 introduces bidirectional synchronization capability to `obsidian-livesync-headless`. Building upon the admission and read-only negotiation of Phase 1, the all-leaf chunk-assembled materialization of Phase 2, and the recoverable quarantine, resume, and idempotent verification of Phase 3, Phase 4 enables **controlled, fail-safe remote write operations** alongside local reflection.

Writing to a live CouchDB database shared with active Obsidian LiveSync clients carries severe risks: document corruption, clobbered conflict leaves, orphaned chunks, resurrecting deleted files, and remote state drift. Phase 4 mitigates these risks through a strict preservation-first architecture:
1. **Explicit Write Arming & Auto-Revocation (CONF-07, CONF-08)**: Remote write capabilities are never implicitly granted. A write grant token must be explicitly generated after verified bootstrap and is cryptographically bound to 5 exact tuples: remote fingerprint, canonical vault root, negotiated settings hash, commonlib compatibility version, and bootstrap generation. If any bound evidence drifts, the grant is revoked automatically.
2. **Restricted Write Transport Guard (SAFE-03)**: Even when armed, remote traffic is restricted to the minimum required file document operations (`GET`, `HEAD`, `PUT`, and `POST` for `_all_docs`/`_bulk_docs`). Forbidden HTTP verbs (`DELETE`, `COPY`) and administrative/destructive subpaths (`/_purge`, `/_compact`, `/_security`, `/_revs_limit`, `/_replicator`, `/_design`, etc.) are blocked at the transport layer before network dispatch.
3. **Finite One-Shot Lifecycle & Convergence (SYNC-01, SYNC-09)**: Execution follows a rigid 6-step lifecycle: Preflight & Orphan Cleanup -> Remote Catch-Up (Pull) -> Local Scan -> Safe Reconciliation & Planning -> Chunk-First Push -> Final Convergence Verification.
4. **Chunk-First Push & Proven Ancestry (SYNC-02, SYNC-03, SYNC-04)**: New and modified files split into chunks, encrypt/compress per negotiated parameters, and persist every chunk in CouchDB before the file metadata document referencing those chunks is written. Metadata updates and logical deletions extend only proven live base revisions (`_rev: baseRev`).
5. **Rename Lineage & Conflict Preservation (SYNC-05, SYNC-06, SYNC-07)**: Case-only renames stay in the same revision tree; cross-path renames verify target installation before logically deleting the source branch; byte-identical conflict leaves collapse cleanly, while ambiguous ancestry, delete-vs-modify, and differing content branches are strictly preserved and surfaced as diagnostics.
6. **Backup Warning Banner (SAFE-07)**: Every sync invocation surfaces an unmissable warning that synchronization propagates additions and deletions and is not an independent backup.

**Primary recommendation:** Implement write arming via SQLite `write_grants` table (Migration 005), introduce `createArmedGuardedFetch` for least-privilege CouchDB write traffic, construct `PushAdapter` and `DeletionWriter` extending proven revisions, and build `SyncCoordinator` executing the finite 6-stage lifecycle.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Write Grant Storage | Storage (`src/storage/write-grant-repo.ts`) | Database Schema (`src/storage/sqlite.ts`) | Persistent durable SQLite table storing 5-tuple arming grants and revocation flags. |
| Write Traffic Guard | Security (`src/security/transport-guard.ts`) | Network Transport (`globalThis.fetch`) | Intercepts all write-capable HTTP traffic; allows only GET/HEAD/PUT/POST to `/{db}/*`. Blocks DELETE/admin paths. |
| Write Capability Minting | Security (`src/security/capabilities.ts`) | Admission Verification | Grants capability tokens only after validating active 5-tuple grant against live probe. |
| Local Vault Scanning | Filesystem (`src/filesystem/vault-scanner.ts`) | Domain Policy (`src/domain/path-policy.ts`) | Recursively scans vault, computes SHA-256 hashes, applies ignore policy. Read-only. |
| Remote Push Adapter | LiveSync Protocol (`src/livesync/push-adapter.ts`) | Encryption/Compression Codecs | Encodes vault content into LiveSync chunks and metadata docs; chunk-first PUT before metadata PUT. |
| Logical Deletion | LiveSync Protocol (`src/livesync/deletion-writer.ts`) | Transport Guard | Writes `{ deleted: true, _rev: baseRev }` documents. Never uses HTTP DELETE. |
| Rename & Conflict Logic | Domain Logic (`src/domain/rename-detector.ts`, `sync-plan.ts`) | Storage (`src/storage/provenance-repo.ts`) | Reconciles local changes vs remote inventory; preserves revision lineage on renames and collapses byte-identical leaves. |
| Sync Coordination | Orchestration (`src/domain/sync-coordinator.ts`) | CLI Command (`src/cli/commands/sync.ts`) | Executes 6-stage one-shot sync lifecycle, rollback on error, and final convergence check. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---|---|---|---|
| `node:sqlite` | Node 24 Built-in | Schema migration 005 and `write_grants` persistence | Built-in SQLite DatabaseSync provides zero-dependency, crash-safe atomic transactions. |
| `@vrtmrz/livesync-commonlib` | 0.1.21 exact | Path-to-document ID, chunk splitting, HKDF/V1 cipher, compression | Pinned upstream LiveSync standard library ensuring 100% wire and storage compatibility. |
| `node:crypto` | Node 24 Built-in | SHA-256 vault file hashing, token IDs, settings hash | Built-in high performance cryptographic functions. |
| `node:fs/promises` | Node 24 Built-in | Vault reading, atomic reflection, quarantine moves | Asynchronous, atomic filesystem operations. |

### Supporting
| Library | Version | Purpose | When to Use |
|---|---|---|---|
| `@testcontainers/couchdb` | 12.1.0 exact | Real CouchDB 3.5.2 testing | Integration tests for bidirectional sync, conflicts, and write arming. |
| `vitest` | 4.1.11 exact | Unit and integration test runner | Running fast unit and real-container integration suites. |

## Phase Requirements

<phase_requirements>
| ID | Description | Research Support |
|---|---|---|
| CONF-07 | Explicit write arming bound to 5 tuples | SQLite `write_grants` table + `arm` command verifying remote fingerprint, vault root, settings hash, commonlib version, bootstrap generation. |
| CONF-08 | Automatic grant revocation upon evidence drift | Grant validator checks live 5-tuple state on every mutating command; auto-revokes upon any divergence. |
| SYNC-01 | Bidirectional one-shot lifecycle & convergence check | `SyncCoordinator` running 6-stage lifecycle (preflight -> pull -> scan -> reconcile -> push -> verify convergence). |
| SYNC-02 | Local edits extend proven LiveSync revision base | `PushPlanner` references `_rev: baseRevision` from SQLite provenance; creates start root revision. |
| SYNC-03 | Chunk-first storage before file metadata update | `PushAdapter` uploads and verifies all missing chunk docs (`h:.../`e:...`) before writing note document. |
| SYNC-04 | Intentional local deletion creates LiveSync logical deletion | `DeletionWriter` writes `{ deleted: true, _rev: baseRev, mtime: now }`. Never invokes HTTP DELETE. |
| SYNC-05 | Case-only and cross-path rename preservation | `RenameDetector` preserves revision tree on case rename; verifies target write before source deletion on cross-path move. |
| SYNC-06 | Ambiguous conflict preservation and byte-identical collapse | Compares leaf content hashes: collapses identical leaves, preserves divergent leaves and reports conflict. |
| SYNC-07 | Preserve unsynchronized local content | Unmatched local files remain in vault without remote clobbering; quarantine protects local changes. |
| SYNC-08 | Enforceable bidirectional dry-run preview | `sync --dry-run` outputs full execution plan with 0 remote network writes and 0 vault mutations. |
| SYNC-09 | Idempotent safe reruns | Deterministic reconciliation yields 0 operations on clean state; interrupted runs resume safely without duplicate revs. |
| SAFE-03 | Minimum allowed write-capable HTTP traffic | `createArmedGuardedFetch` allows only GET/HEAD/PUT/POST to `/{db}/*`; blocks DELETE and administrative subpaths. |
| SAFE-07 | Backup disclaimer warning banner | `emitBackupWarningBanner()` displays prominent warning that sync is not a backup. |
</phase_requirements>

## Architecture Patterns

### System Architecture Diagram

```
[Operator CLI] -> [Backup Warning Banner] (SAFE-07)
       │
       ▼
[Write Arming Validator] (CONF-07, CONF-08) -> [write_grants SQLite Table]
       │
       ▼
[Sync Coordinator (6-Stage Finite Lifecycle)] (SYNC-01)
       │
       ├─► 1. Preflight & Staging Orphan Cleanup
       │
       ├─► 2. Remote Catch-Up (Pull Phase) -> [Vault Atomic Reflector / Quarantine]
       │
       ├─► 3. Local Vault Scanner -> [Recursive SHA-256 Hashing]
       │
       ├─► 4. Bidirectional Planner & Rename/Conflict Reconciler (SYNC-05, SYNC-06)
       │         │
       │         ├── [Dry-Run Mode] -> Emit Plan & Exit (SYNC-08)
       │         └── [Apply Mode]   -> Continue
       │
       ├─► 5. Push Execution (SYNC-02, SYNC-03, SYNC-04)
       │         │
       │         ├── a. Chunk-First Upload (PUT h:... / e:...) -> [Armed Guarded Fetch] (SAFE-03)
       │         ├── b. Note Metadata Upload (PUT path _rev: baseRev)
       │         ├── c. Logical Deletions (PUT path deleted: true)
       │         └── d. Commit SQLite Provenance
       │
       └─► 6. Final Convergence Verification (SYNC-09)
```

### Recommended Project Structure

```
src/
├── cli/
│   ├── commands/
│   │   ├── arm.ts                 # CLI command: write arming token generation & revocation
│   │   ├── inspect.ts             # Phase 1 inspect command
│   │   ├── pull.ts                # Phase 2/3 pull command
│   │   └── sync.ts                # Phase 4 bidirectional one-shot command (arm check, dry-run, apply)
│   └── index.ts                   # CLI entry router & argument parser
├── domain/
│   ├── path-policy.ts             # LiveSync path validation & normalization
│   ├── pull-plan.ts               # Pull reconciliation planner
│   ├── rename-detector.ts         # Case-only and cross-path rename reconciliation (SYNC-05)
│   ├── sync-coordinator.ts        # 6-stage one-shot sync engine (SYNC-01, SYNC-09)
│   └── sync-plan.ts               # Bidirectional reconciliation planner (SYNC-01, SYNC-08)
├── filesystem/
│   ├── atomic-reflector.ts        # Atomic vault file writes & readback verification
│   ├── orphan-cleanup.ts          # Staging file cleanup
│   ├── quarantine-store.ts        # Collision-safe quarantine directory store
│   ├── vault-preflight.ts         # Vault validation & safety preflight
│   └── vault-scanner.ts           # Recursive local vault hashing & change detection
├── livesync/
│   ├── decode-adapter.ts          # Commonlib read/decode adapter
│   ├── deletion-writer.ts         # Logical deletion builder extending proven rev (SYNC-04)
│   ├── inspector.ts               # Read-only CouchDB probe
│   ├── inventory.ts               # All-leaf document inventory
│   ├── negotiation.ts             # Settings negotiation & capability matching
│   ├── push-adapter.ts            # Chunk-first upload & note metadata writer (SYNC-02, SYNC-03)
│   └── syncinfo.ts                # Sync parameters decoder/encoder
├── security/
│   ├── capabilities.ts            # WriteCapability & ArmedSyncCapability types
│   ├── redaction.ts               # Secret redaction utility
│   └── transport-guard.ts         # Armed guarded fetch: allows GET/HEAD/PUT/POST, blocks DELETE/admin
└── storage/
    ├── admission-repo.ts          # Admission records in SQLite
    ├── checkpoint-repo.ts         # Pull & sync checkpoints
    ├── provenance-repo.ts         # Exact file revision & hash tracking
    ├── quarantine-repo.ts         # Quarantine index in SQLite
    ├── sqlite.ts                  # Schema migrations 001..005 (adding write_grants)
    └── write-grant-repo.ts        # Write arming grant repository (CONF-07, CONF-08)
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Chunk Splitting & Hashing | Custom rolling checksum or string chunker | Upstream LiveSync splitter algorithm (`chunkSplitterVersion` from `@vrtmrz/livesync-commonlib`) | LiveSync clients deduplicate chunks by hash; diverging splitter logic breaks deduplication and client compatibility. |
| E2EE HKDF & V1 Encryption | Custom AES-GCM or crypto implementations | `octagonal-wheels/encryption/hkdf` and `octagonal-wheels/encryption` | Encrypted chunk headers, salts, IV handling, and metadata serialization must match upstream byte-for-byte. |
| Path to Document ID | Custom URI encoding or MD5 hashing | `path2id_base` / `id2path_base` from `@vrtmrz/livesync-commonlib` | LiveSync has intricate handling for Unicode normalization, case sensitivity, and prefixing (`h:`, `i:`, `ix:`, `_`). |
| SQLite Persistence | External npm packages (`better-sqlite3`, `sqlite3`) | Node.js 24 built-in `node:sqlite` (`DatabaseSync`) | Retains single-executable SEA compatibility without native `.node` addons or external binary toolchains. |

## Common Pitfalls

### Pitfall 1: Split-Brain Revision Overwrites
**What goes wrong:** Local edit overwrites newer remote edit or creates orphaned conflict forks.  
**Why it happens:** Writing without providing proven `_rev: baseRevision`.  
**How to avoid:** Always pass `_rev: baseRevision` from SQLite provenance. Handle CouchDB `409 Conflict` by stopping and reporting divergent branches.

### Pitfall 2: Orphaned Remote Chunks / Half-Written Documents
**What goes wrong:** Note document is written referencing chunks that failed to upload, leaving file unreadable.  
**Why it happens:** Writing metadata doc concurrently or before chunk writes are confirmed.  
**How to avoid:** Strict chunk-first sequencing. Verify HTTP 201/200 OK for every single chunk doc before issuing PUT for note document.

### Pitfall 3: Destructive HTTP DELETE
**What goes wrong:** Remote document history is purged or replication triggers client exceptions.  
**Why it happens:** Using CouchDB HTTP `DELETE` verb.  
**How to avoid:** LiveSync requires logical deletion (`deleted: true`). Block HTTP `DELETE` at transport guard level.

### Pitfall 4: Case-Only Renames
**What goes wrong:** File is clobbered or duplicate document IDs are created on case-insensitive filesystems.  
**Why it happens:** Assuming case change is a delete + create.  
**How to avoid:** Use `handleFilenameCaseSensitive` setting; update `path` property on existing note document under same revision lineage.

## Code Examples

### SQLite Migration 005 (`write_grants`)
```typescript
if (!appliedVersions.has(5)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS write_grants (
      grant_id TEXT PRIMARY KEY,
      remote_fingerprint TEXT NOT NULL,
      vault_root TEXT NOT NULL,
      settings_hash TEXT NOT NULL,
      commonlib_version TEXT NOT NULL,
      bootstrap_generation TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      revocation_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_write_grants_active 
      ON write_grants(remote_fingerprint, vault_root, revoked);
  `);

  const stmt = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  stmt.run(5, new Date().toISOString());
}
```

### Armed Transport Guard (SAFE-03)
```typescript
const ARMED_ALLOWED_METHODS = new Set(['GET', 'HEAD', 'PUT', 'POST']);
const ARMED_FORBIDDEN_SUBPATHS = [
  '/_purge', '/_compact', '/_security', '/_revs_limit',
  '/_replicator', '/_design', '/_index', '/_node',
  '/_users', '/_config', '/_restart', '/_up'
];

export function createArmedGuardedFetch(
  options: { allowedBaseUrl: URL; databaseName: string },
  baseFetch: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  const allowedDbPath = `/${options.databaseName}`;
  return async function armedGuardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const targetUrl = new URL(rawUrl, options.allowedBaseUrl);
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')).toUpperCase();

    if (!ARMED_ALLOWED_METHODS.has(method)) {
      throw new MutationAttemptBlockedError(method, targetUrl.href);
    }
    if (targetUrl.origin !== options.allowedBaseUrl.origin) {
      throw new EndpointDisallowedError(targetUrl.href);
    }
    const path = targetUrl.pathname;
    const isRoot = path === '/' || path === '';
    const isDbTarget = path === allowedDbPath || path.startsWith(`${allowedDbPath}/`);
    if (!isRoot && !isDbTarget) {
      throw new EndpointDisallowedError(targetUrl.pathname);
    }
    const lowerPath = path.toLowerCase();
    if (ARMED_FORBIDDEN_SUBPATHS.some((sub) => lowerPath.includes(sub))) {
      throw new EndpointDisallowedError(targetUrl.pathname);
    }
    return baseFetch(input, { ...init, redirect: 'manual' });
  };
}
```

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | Built-in Node.js 24 crypto and commonlib chunk splitter support all standard LiveSync vault sizes | Standard Stack | Extremely large binary files (>100MB) may need memory-conscious chunk streaming. |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| Node.js | Core Runtime | ✓ | 24.20.0 | — |
| npm | Package Manager | ✓ | 11.19.0 | — |
| CouchDB (Testcontainers) | Integration Testing | ✓ | 3.5.2 | — |

## Validation Architecture

### Test Framework
| Property | Value |
|---|---|
| Framework | Vitest 4.1.11 |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run tests/unit/write-grant-repo.test.ts tests/unit/sync-plan.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| CONF-07 | Explicit write arming bound to 5 tuples | unit | `npx vitest run tests/unit/write-grant-repo.test.ts` | ❌ Wave 0 |
| CONF-08 | Auto-revocation on evidence drift | unit | `npx vitest run tests/unit/write-grant-repo.test.ts` | ❌ Wave 0 |
| SYNC-01 | 6-stage lifecycle & convergence | integration | `npx vitest run tests/integration/sync-bidirectional.test.ts` | ❌ Wave 0 |
| SYNC-02 | Local edits extend proven revision | unit/integration | `npx vitest run tests/unit/sync-plan.test.ts` | ❌ Wave 0 |
| SYNC-03 | Chunk-first storage before note PUT | integration | `npx vitest run tests/integration/sync-bidirectional.test.ts` | ❌ Wave 0 |
| SYNC-04 | Logical deletion on proven branch | unit | `npx vitest run tests/unit/deletion-writer.test.ts` | ❌ Wave 0 |
| SYNC-05 | Case and cross-path renames | unit | `npx vitest run tests/unit/rename-detector.test.ts` | ❌ Wave 0 |
| SYNC-06 | Ambiguous conflict preservation & collapse | unit | `npx vitest run tests/unit/conflict-reconciler.test.ts` | ❌ Wave 0 |
| SYNC-07 | Preserve unmatched local bytes | integration | `npx vitest run tests/integration/sync-bidirectional.test.ts` | ❌ Wave 0 |
| SYNC-08 | Enforceable dry-run preview | integration | `npx vitest run tests/integration/sync-dry-run.test.ts` | ❌ Wave 0 |
| SYNC-09 | Idempotent safe reruns & resume | integration | `npx vitest run tests/integration/sync-recovery-rerun.test.ts` | ❌ Wave 0 |
| SAFE-03 | Armed transport guard restrictions | unit | `npx vitest run tests/unit/armed-transport-guard.test.ts` | ❌ Wave 0 |
| SAFE-07 | Backup warning banner display | unit | `npx vitest run tests/unit/sync-command.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/unit/write-grant-repo.test.ts tests/unit/sync-plan.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/unit/write-grant-repo.test.ts` — covers CONF-07, CONF-08
- [ ] `tests/unit/armed-transport-guard.test.ts` — covers SAFE-03
- [ ] `tests/unit/sync-plan.test.ts` — covers SYNC-01, SYNC-02, SYNC-08
- [ ] `tests/unit/rename-detector.test.ts` — covers SYNC-05
- [ ] `tests/unit/deletion-writer.test.ts` — covers SYNC-04
- [ ] `tests/unit/conflict-reconciler.test.ts` — covers SYNC-06, SYNC-07
- [ ] `tests/unit/sync-command.test.ts` — covers SAFE-07
- [ ] `tests/integration/sync-bidirectional.test.ts` — covers SYNC-01..SYNC-07
- [ ] `tests/integration/sync-dry-run.test.ts` — covers SYNC-08
- [ ] `tests/integration/sync-recovery-rerun.test.ts` — covers SYNC-09

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | yes | Ephemeral Basic Auth / Bearer over guarded fetch |
| V4 Access Control | yes | Restricted write transport guard denying HTTP DELETE and admin endpoints |
| V5 Input Validation | yes | Strict path policy and Zod config validation |
| V6 Cryptography | yes | Verified LiveSync HKDF/V1 crypto from Commonlib, no hand-rolled crypto |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Accidental Database Purge | Tampering | Deny HTTP DELETE and administrative paths in transport guard (SAFE-03) |
| Unauthorized Remote Writes | Elevation of Privilege | Explicit 5-tuple bound write grant with auto-revocation (CONF-07, CONF-08) |
| Secret Leakage in Logs/Dry-Run | Information Disclosure | Mandatory redaction of credentials, passphrases, and ciphertext in all outputs |
