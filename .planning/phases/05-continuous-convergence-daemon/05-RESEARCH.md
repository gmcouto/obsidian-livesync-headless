# Phase 5: Continuous Convergence Daemon - Research

**Researched:** 2026-09-06  
**Domain:** Obsidian Self-Hosted LiveSync — Continuous Convergence Daemon, Local Filesystem Watching (Chokidar), CouchDB `_changes` Streaming Feed, Invalidation Hints, Per-File Work Serialization, Self-Reflection Loop Suppression, Durable Checkpointing, and Graceful Signal Shutdown  
**Confidence:** HIGH  

---

## Executive Summary

Phase 5 delivers the continuous synchronization runtime for `obsidian-livesync-headless`. Building on the guarded admission of Phase 1, the all-leaf verified pull engine of Phase 2, the crash-safe recoverable quarantine of Phase 3, and the armed bidirectional one-shot synchronization engine of Phase 4, Phase 5 converts the proven finite synchronization engine into an unattended, continuously running daemon.

A continuous synchronization daemon operating against a shared multi-client CouchDB database faces distinct hazards:
1. **Self-Reflection Loops (Ping-Pong Effect)**: Writing pulled remote files to local disk triggers filesystem watcher events; writing pushed local files to CouchDB triggers changes feed events. Without strict loop suppression, the daemon enters an infinite feedback loop.
2. **Race Conditions and Concurrent File Mutations**: Concurrent edits to the same file or rapid save bursts (e.g. editor temp-file replacement) can produce torn reads, interleaved push/pull operations, and revision conflicts.
3. **Loss of Invalidation Events vs. False Authority**: Filesystem events and changes-feed streams can drop, coalesce, or deliver out-of-order notifications during high I/O or network reconnects. Treating watcher events as ground truth leads to state corruption.
4. **Premature Checkpoint Advancement**: Advancing a remote sequence checkpoint past an unresolved conflict or failed transfer permanently loses track of unverified work.
5. **Divergence During Remote Outages**: Temporary network disconnects or CouchDB restarts must not crash the daemon or cause silent desynchronization.

Phase 5 addresses these hazards with a robust architectural design:
- **Admission & Write Grant Validation (DAEM-01)**: The daemon refuses to start or drops to read-only if admission negotiation fails or write grants are missing/revoked.
- **Finite Pull-First Catch-Up (DAEM-02)**: The daemon executes a complete one-shot reconciliation pass before opening live event intake streams.
- **Invalidation Hints & Authoritative Re-reads (DAEM-03)**: Watcher and change events are treated strictly as *hints*. The daemon always re-reads ground truth from disk, CouchDB, and SQLite provenance before deciding an action.
- **Per-File Work Serialization & Loop Suppression (DAEM-04)**: Per-file asynchronous mutex queues prevent concurrent execution on the same path; content SHA-256 and remote revision matching suppress reflection echoes.
- **Durable Checkpoints & Fencing (DAEM-05)**: Opaque sequence tokens are persisted in SQLite only after all changes up to that sequence have been verified.
- **Resilient Reconnection & Periodic Scans (DAEM-06)**: Jittered exponential backoff handles network drops; periodic and post-error scans guarantee eventual convergence.
- **Fail-Closed Degraded State (DAEM-07)**: Security, compatibility, or configuration drift triggers immediate fallback to degraded read-only or blocked states.
- **Deterministic Graceful Shutdown (DAEM-08)**: Process signals (`SIGINT`, `SIGTERM`) cleanly halt intake, drain active file tasks, persist state, and exit with code 0.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Supporting Tier | Responsibility |
|---|---|---|---|
| **Daemon Orchestrator** | Domain (`src/domain/daemon-orchestrator.ts`) | CLI (`src/cli/commands/daemon.ts`) | Manages the full daemon lifecycle: admission -> catch-up -> live intake -> shutdown. |
| **Filesystem Watcher** | Filesystem (`src/daemon/fs-watcher.ts`) | Third-party (`chokidar@5.0.0`) | Watches local vault, filters internal files, debounces bursts, emits invalidation hints. |
| **CouchDB Changes Feed** | LiveSync (`src/daemon/changes-consumer.ts`) | Transport Guard (`src/security/transport-guard.ts`) | Consumes `/{db}/_changes` stream, handles reconnections, emits remote invalidation hints. |
| **Work Queue & Serializer** | Domain (`src/daemon/file-worker-pool.ts`) | Concurrency (`src/daemon/task-queue.ts`) | Per-file serialized task queues, bounded concurrency pool, backpressure controls. |
| **Single-File Reconciler** | Domain (`src/daemon/file-reconciler.ts`) | One-Shot Engine (`src/domain/sync-plan.ts`) | Authoritatively inspects single file (disk, DB, provenance) and executes atomic sync action. |
| **Loop Suppressor** | Domain (`src/daemon/loop-suppressor.ts`) | Storage (`src/storage/provenance-repo.ts`) | Filters out self-generated echoes using content hash and remote revision comparisons. |
| **Checkpoint Manager** | Storage (`src/storage/checkpoint-repo.ts`) | Database Schema (`src/storage/sqlite.ts`) | Manages monotonic opaque sequence progression, ensuring unverified work is never skipped. |
| **Signal & Lifecycle Handler** | Process (`src/cli/commands/daemon.ts`) | Node runtime (`node:process`) | Intercepts `SIGINT`/`SIGTERM`, coordinates orderly intake shutdown, queue draining, and DB close. |

---

## Standard Stack & Package Evaluation

### Core Runtime Dependencies
| Library / Module | Version | Purpose | Evaluation & Justification |
|---|---|---|---|
| `chokidar` | `^5.0.0` | Local filesystem event monitoring | Rewritten in pure TypeScript, zero runtime dependencies, robust cross-platform event handling (Linux `inotify`, macOS `fsevents`, Windows `ReadDirectoryChangesW`). Standard for node file watching. [VERIFIED] |
| `node:sqlite` | Node 24 Built-in | Checkpoint, provenance, grant storage | Built-in zero-dependency SQLite storage with WAL mode, ensuring atomic checkpoint commits during daemon operation. [VERIFIED] |
| `@vrtmrz/livesync-commonlib` | `0.1.21` exact | Chunk hashing, encryption, path decoding | Upstream LiveSync compatibility engine. Used for decoding note paths and verifying document shapes. [VERIFIED] |
| `node:crypto` | Node 24 Built-in | SHA-256 hash calculation, jitter generation | High-performance content hashing for loop suppression and cryptographic jitter. [VERIFIED] |
| `node:events` | Node 24 Built-in | EventEmitter / AbortController | Standard event bus for decoupled daemon event distribution and cancellable async operations. [VERIFIED] |

### Development & Test Stack
| Library | Version | Purpose | Justification |
|---|---|---|---|
| `@testcontainers/couchdb` | `12.1.0` exact | Real CouchDB 3.5.2 testing | Validates continuous changes stream, live reconnection, and multi-client convergence against live CouchDB instance. [VERIFIED] |
| `vitest` | `4.1.11` exact | Test execution & mock timers | Fast unit testing with fake timers for debounce, backoff, and periodic scan tests. [VERIFIED] |

---

## Phase Requirements & Traceability Matrix

<phase_requirements>
| Requirement ID | Specification | Research Support & Technical Strategy |
|---|---|---|
| **DAEM-01** | Admission & Write Grant Validation | Verify configuration, perform remote admission negotiation, and check active 5-tuple write grant before starting daemon. If in write mode and grant is invalid, fail closed immediately. |
| **DAEM-02** | Finite Pull-First Catch-Up | Run complete `SyncCoordinator.sync()` pass before attaching live watcher or changes feed. Only transition to live streaming once initial convergence is verified. |
| **DAEM-03** | Invalidation Hints & Authoritative Re-reads | All events (FS or CouchDB) emit normalized path hints. The reconciler re-reads local stat/hash, remote doc/leaves, and SQLite provenance to determine ground truth. |
| **DAEM-04** | Per-File Serialization & Loop Suppression | Per-file async locks serialize operations on the same path. Self-reflection echoes are discarded by comparing content SHA-256 and remote `_rev` against SQLite provenance. Worker pool concurrency and queue depth are strictly bounded. |
| **DAEM-05** | Durable Checkpoints & Work Fencing | CouchDB `_changes` sequence tokens are tracked per-batch. Checkpoints are committed to SQLite `pull_checkpoints` only after all prior file tasks succeed without blockers. |
| **DAEM-06** | Resilient Reconnection & Periodic Scans | Changes feed reconnects using jittered exponential backoff (`min: 500ms, max: 30s, jitter: ±25%`). Configurable periodic full-reconciliation scan (e.g. 300s) and post-error scans catch any dropped events. |
| **DAEM-07** | Fail-Closed & Degraded Read-Only State | If remote settings hash drifts, fingerprint changes, or write grant is revoked during runtime, daemon immediately drops write capability, logs `SAFE-06` alert, and operates in read-only or blocked mode. |
| **DAEM-08** | Graceful Signal Shutdown | Intercepts `SIGINT`/`SIGTERM`, closes watcher and changes stream intake, drains in-flight file tasks within a timeout (e.g. 10s), persists final checkpoints, and exits with code 0. |
</phase_requirements>

---

## Deep Dive Technical Topics

### 1. Local Filesystem Watching & Invalidation Engine (Chokidar 5.0.0)

#### A. Event Normalization & Atomic Write Handling
Modern editors (Obsidian, VS Code, vim) write files using atomic save strategies:
- Write content to a temporary file (`.file.tmp` or `file.tmp.1234`).
- Rename temp file over target file (`rename(tmp, target)`).
- Or delete original and recreate.

These patterns emit rapid burst sequences: `add` -> `change` -> `unlink` or `add` -> `rename`.
To handle this:
1. **Event Filtering**: Ignore hidden files (`.obsidian-livesync-state/**`, `.git/**`, `.ols-tmp-*`, temporary editor swap files).
2. **Path Normalization**: Map local absolute path to vault-relative POSIX path (`path.relative(vaultRoot, filePath).split(path.sep).join('/')`).
3. **Per-Path Trailing Debounce**: Maintain a debounce map with a 300ms window. Subsequent events on the same path reset the debounce timer. When the timer expires, exactly one `LOCAL_INVALIDATION` hint is dispatched to the work queue.
4. **Invalidation Hint Model (DAEM-03)**: The event payload is discarded. The reconciler does not care whether Chokidar emitted `add`, `change`, or `unlink`; it executes an authoritative `fs.stat` and `fs.readFile` to determine current reality.

```typescript
// Conceptual Invalidation Event
export interface InvalidationHint {
  readonly path: string;
  readonly source: 'local_fs' | 'remote_changes' | 'periodic_scan' | 'retry';
  readonly remoteSeq?: string;
  readonly timestamp: number;
}
```

---

### 2. CouchDB Changes Feed Consumer & Resilient Streaming

#### A. Endpoint & Parameters
CouchDB's `_changes` endpoint provides real-time notifications of database updates:
- URL: `/{db}/_changes?feed=continuous&since={since}&heartbeat=25000&timeout=60000`
- Headers: `Accept: application/json`, `Authorization: Basic ...`
- Format: Continuous NDJSON (Newline-Delimited JSON) stream:
  ```json
  {"seq":"1-g1AAA...","id":"h:abc123","changes":[{"rev":"1-xyz"}],"deleted":true}
  {"seq":"2-g1AAA...","id":"notes/example.md","changes":[{"rev":"1-abc"}]}
  ```
- Keepalive heartbeats: Empty newlines `\n` sent every 25 seconds prevent proxy/NAT timeout drops.

#### B. Stream Chunk Framing & NDJSON Parsing
Network chunks received from `fetch` stream reader do not align with JSON line breaks. A robust line buffer accumulator splits chunks on `\n`, buffering partial lines until the next chunk arrives.

```typescript
// Buffer handling pattern
let buffer = '';
for await (const chunk of stream) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? ''; // Keep incomplete trailing fragment
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // Heartbeat line
    const event = JSON.parse(trimmed);
    processChangeEvent(event);
  }
}
```

#### C. Filtering & Path Resolution
1. **Chunk Documents**: Documents with prefix `h:` or `e:` or `chunk:` are content chunks. If a chunk document changes, it does not directly trigger file reconciliation; note document updates will reference required chunks.
2. **Metadata Documents**: LiveSync note documents have paths either as `_id` (unobfuscated) or encrypted/obfuscated in the document body. For obfuscated setups, we query document metadata or decode the path.
3. **Sequence Tracking**: Each event includes an opaque sequence string `seq`. The consumer tracks the highest received sequence and passes it to the Checkpoint Manager.

#### D. Reconnection Strategy with Jittered Exponential Backoff
When the HTTP stream drops, errors out (e.g. 503, connection reset), or CouchDB restarts:
```typescript
function calculateBackoff(attempt: number, baseMs = 500, maxMs = 30000, jitterFactor = 0.25): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitterRange = exponential * jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(baseMs, Math.round(exponential + jitter));
}
```
Upon reconnection, the changes feed is reopened with `since: lastVerifiedSeq`.

---

### 3. Continuous Convergence Engine & Per-File Serialization

#### A. Per-File Async Mutex & Invalidation Coalescing (DAEM-04)
To avoid race conditions, only one reconciliation operation may execute on a given file path at any time.

```
       [Local FS Watcher]          [Remote Changes Feed]          [Periodic Timer]
               │                              │                           │
               ▼                              ▼                           ▼
        (Debounce 300ms)               (Filter & Map)                     │
               │                              │                           │
               └──────────────► [ Work Queue ] ◄──────────────────────────┘
                                      │
                                      ▼
                       [ Per-File Serializer / Mutex ]
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
           [File A Active]                       [File B Active]
          (Reconcile & Apply)                   (Reconcile & Apply)
                   │                                     │
         (If marked dirty while                (If marked dirty while
           busy, rerun once)                     busy, rerun once)
                   │                                     │
                   ▼                                     ▼
          [Release Mutex &                      [Release Mutex &
         Advance Checkpoint]                   Advance Checkpoint]
```

#### B. Queue Bounding & Backpressure
- Maximum queue capacity: 10,000 items.
- Concurrency limit: 4 concurrent file workers.
- If queue reaches 80% capacity: log backpressure warning.
- If queue overflows: coalesce all pending path hints into a single `TRIGGER_FULL_RESCAN` action, preventing memory exhaustion.

---

### 4. Self-Reflection Loop Suppression Mechanics

A critical challenge in bidirectional synchronization is preventing self-reflection loops:
- **Local -> Remote -> Local**: Local edit pushed to CouchDB -> CouchDB emits `_changes` -> Daemon pulls file -> Filesystem emits `change` -> Repeat forever.
- **Remote -> Local -> Remote**: Remote edit pulled to disk -> Filesystem emits `change` -> Daemon pushes to CouchDB -> Repeat forever.

#### Loop Suppression Strategy (DAEM-04)
The daemon relies on ground-truth provenance stored in SQLite (`file_provenance` table):
1. **Local FS Event Suppression**:
   - When a local file event triggers reconciliation for `path`:
   - Read local file from disk, calculate `localSha256 = sha256(bytes)`.
   - Read `provenance = getProvenance(path)`.
   - If `provenance` exists and `localSha256 === provenance.contentSha256`:
     - The file on disk has identical content to the last verified synchronization.
     - Action: **NO-OP**. Discard event immediately.
2. **Remote Changes Event Suppression**:
   - When a remote change event triggers reconciliation for `path` with `rev`:
   - Read `provenance = getProvenance(path)`.
   - If `provenance` exists and `provenance.remoteRevision === rev`:
     - The remote revision is the exact revision pushed by this client.
     - Action: **NO-OP**. Discard event immediately.
3. **Mtime Tolerance**:
   - Atomic disk writes during pull update the filesystem `mtime`. When saving provenance after pull reflection, the daemon records `fileStat.mtimeMs`. Minor timestamp updates without content changes are recognized as clean no-ops.

---

### 5. Checkpoint Integrity & Unverified Work Fencing (DAEM-05)

#### Checkpoint Rule
The remote sequence checkpoint (`last_update_seq`) must **never advance past blocked, conflicted, or unverified work**.

#### Opaque Sequence Windowing
CouchDB sequence tokens are opaque strings (e.g. `"1-g1AAA..."`, `"42-g1AAA..."`). They cannot be numerically sorted or incremented.
- The Checkpoint Manager maintains a pending sequence window:
  - Sequence tokens received from `_changes` are attached to their corresponding file invalidation tasks.
  - When a task completes with verified reflection / push, its sequence is marked verified.
  - The checkpoint is persisted to SQLite `pull_checkpoints` using the highest verified sequence token *for which all preceding sequences in the continuous stream have also completed*.
- If a task fails or halts on a conflict:
  - The sequence token remains unverified.
  - The persisted checkpoint in SQLite does not advance past that point.
  - On restart, the daemon reconnects using the persisted sequence, ensuring all unverified changes are re-evaluated.

---

### 6. Resilience, Reconnection & Periodic Reconciliation (DAEM-06)

#### A. Periodic Convergence Scans
Filesystem watchers (inotify/fsevents) can drop events under high load, disk buffer saturation, or OS resource exhaustion. To guarantee ultimate convergence:
- A periodic scan timer fires every `reconciliationInterval` (default: 300 seconds / 5 minutes).
- The periodic scan performs a fast local and remote metadata diff (identical to Phase 4 `SyncCoordinator.sync()`).
- Any missed file additions, modifications, or deletions are picked up and resolved.

#### B. Post-Error Reconciliation
Following any network disconnect, changes feed stream abort, or worker pool error recovery, the daemon schedules an immediate reconciliation scan once connectivity is restored.

---

### 7. Fail-Closed & Degraded Read-Only Transitions (DAEM-07)

The daemon continuously verifies runtime safety invariants:
1. **Write Grant Validity Check**:
   - On periodic intervals and before every push batch, check active write grant in SQLite.
   - If the grant has been revoked, or if remote settings hash / fingerprint / bootstrap generation drifted:
     - **Transition to DEGRADED_READ_ONLY**.
     - Drop all write capability tokens (`WriteCapability`, `ArmedSyncCapability`).
     - Cease all push actions.
     - Emit high-severity diagnostic alert (`MUTATION_VIOLATION` or `INCOMPATIBLE`).
2. **Corruption & Path Traversal Guard**:
   - Any attempt to access forbidden paths, malformed documents, or unsafe symlinks halts the affected file without corrupting the broader vault.
   - If database-level incompatibility or remote lock is detected, transition to **BLOCKED** state.

```
       ┌───────────────────────────────────────────────────────────┐
       │                     DAEMON ADMISSION                      │
       └─────────────────────────────┬─────────────────────────────┘
                                     │
                     ┌───────────────┴───────────────┐
                     ▼                               ▼
             [Write Mode Armed]              [Read-Only Mode]
                     │                               │
                     ▼                               ▼
          ┌─────────────────────┐         ┌─────────────────────┐
          │   STATE: HEALTHY    │         │   STATE: READ_ONLY  │
          │ (Bidirectional Live)│         │     (Pull Only)     │
          └──────────┬──────────┘         └──────────┬──────────┘
                     │                               │
        Grant Revoked / Evidence Drift               │ Corruption / Lock
                     │                               │
                     ▼                               ▼
          ┌─────────────────────┐         ┌─────────────────────┐
          │   STATE: DEGRADED   │────────►│   STATE: BLOCKED    │
          │ (Fallback Read-Only)│         │  (Halt Processing)  │
          └─────────────────────┘         └─────────────────────┘
```

---

### 8. Signal Handling & Graceful Shutdown (DAEM-08)

#### Orderly Shutdown Sequence
When `SIGINT` (Ctrl+C) or `SIGTERM` is received:
1. **Log Shutdown Initiation**: Log structured message with signal name.
2. **Halt Intake Streams**:
   - Close Chokidar watcher (`watcher.close()`).
   - Abort CouchDB changes feed stream via `AbortController`.
   - Disallow new invalidation hints into the work queue.
3. **Drain In-Flight Work**:
   - Allow currently executing file reconciler tasks to finish.
   - Enforce a hard shutdown deadline (e.g. 10,000ms). If tasks exceed deadline, abort remaining tasks.
4. **Persist Final State**:
   - Commit all completed file provenance and sequence checkpoints to SQLite.
5. **Close Resources**:
   - Close SQLite database connections (`db.close()`).
6. **Deterministic Exit**: Exit process with code `0`.

---

## Proposed Component Structure & File Map

```
src/
├── cli/
│   ├── commands/
│   │   ├── arm.ts                     # Phase 4 write arming command
│   │   ├── daemon.ts                  # [NEW] Phase 5 daemon entry command & CLI parser
│   │   ├── inspect.ts                 # Phase 1 inspect command
│   │   ├── pull.ts                    # Phase 2/3 pull command
│   │   └── sync.ts                    # Phase 4 one-shot sync command
│   └── index.ts                       # CLI argument router (adds 'daemon' command)
├── daemon/
│   ├── changes-consumer.ts            # [NEW] CouchDB _changes NDJSON streaming client
│   ├── continuous-engine.ts           # [NEW] Main daemon coordination engine
│   ├── daemon-state.ts                # [NEW] Daemon state machine (HEALTHY, DEGRADED, BLOCKED)
│   ├── file-reconciler.ts             # [NEW] Single-file authoritative reader & sync executor
│   ├── file-worker-pool.ts            # [NEW] Bounded concurrency pool & per-path async mutex
│   ├── fs-watcher.ts                  # [NEW] Chokidar 5.0.0 integration & event debouncer
│   ├── loop-suppressor.ts             # [NEW] Content SHA-256 and rev echo filtering
│   ├── reconnection-manager.ts        # [NEW] Backoff timer with jitter & retry manager
│   └── shutdown-handler.ts            # [NEW] SIGINT/SIGTERM listener, queue drain & cleanup
├── domain/
│   ├── path-policy.ts                 # Path validation & normalization
│   ├── rename-detector.ts             # Rename detection logic
│   ├── sync-coordinator.ts            # One-shot sync coordinator (used for catch-up)
│   └── sync-plan.ts                   # Sync planning & action definitions
├── storage/
│   ├── admission-repo.ts              # Admission records
│   ├── checkpoint-repo.ts             # Remote sequence checkpoints
│   ├── provenance-repo.ts             # File provenance records
│   ├── quarantine-repo.ts             # Quarantine records
│   ├── sqlite.ts                      # Database connection & migrations
│   └── write-grant-repo.ts            # Write grant issuance & validation
```

---

## Validation Architecture & Test Strategy

### 1. Unit Tests (`tests/unit/`)
- `fs-watcher.test.ts`:
  - Verify event filtering for `.obsidian-livesync-state/`, `.git/`, `.ols-tmp-*`.
  - Verify 300ms trailing debounce coalesces multiple burst events into a single hint.
  - Verify path normalization on Linux, macOS, and Windows separators.
- `changes-consumer.test.ts`:
  - Test NDJSON stream chunk fragmentation (splitting lines across arbitrary chunk boundaries).
  - Verify heartbeat newline handling without JSON parse errors.
  - Verify filtering of chunk documents (`h:...`, `e:...`) and extraction of note doc IDs.
- `loop-suppressor.test.ts`:
  - Verify local event with matching provenance SHA-256 is suppressed (returns NO-OP).
  - Verify remote change with matching provenance `_rev` is suppressed (returns NO-OP).
  - Verify genuinely new content or modified remote revision is admitted for processing.
- `file-worker-pool.test.ts`:
  - Test per-file serialized execution: two rapid hints for `doc.md` execute strictly sequentially.
  - Verify concurrency bound (e.g. max 4 active tasks at once).
  - Test dirty-bit re-evaluation when a hint arrives while file is currently active.
- `reconnection-manager.test.ts`:
  - Test exponential backoff calculation and jitter bounds across attempts 1..10.
  - Verify cap at maximum delay (30s).
- `daemon-state.test.ts`:
  - Verify state transitions: `HEALTHY` -> `DEGRADED_READ_ONLY` on write grant revocation.
  - Verify transition to `BLOCKED` on fatal corruption or schema incompatibility.
- `shutdown-handler.test.ts`:
  - Test orderly shutdown sequence: stops intake, drains active jobs, persists DB state, exits cleanly.

### 2. Integration Tests (`tests/integration/`) against Real CouchDB (Testcontainers 3.5.2)
- `daemon-lifecycle.test.ts`:
  - Test complete daemon admission, finite pull-first catch-up (DAEM-01, DAEM-02), and live state transition.
- `daemon-continuous-sync.test.ts`:
  - Create file locally -> Verify daemon pushes chunk-first to CouchDB within 1-2s (DAEM-03, DAEM-04).
  - Update file remotely in CouchDB -> Verify daemon reflects to local vault atomically (DAEM-03, DAEM-04).
  - Verify zero ping-pong loop: no continuous repeated revision generation after settling.
- `daemon-reconnection.test.ts`:
  - Simulate network interruption / CouchDB pause -> Verify daemon reconnects with jittered backoff and catches up missed changes from checkpoint (DAEM-05, DAEM-06).
- `daemon-degraded-mode.test.ts`:
  - Revoke write grant during live daemon operation -> Verify daemon transitions to degraded read-only, rejects local push writes, but continues pulling remote changes (DAEM-07).
- `daemon-graceful-shutdown.test.ts`:
  - Send `SIGTERM` to running daemon process -> Verify all in-flight file writes complete, checkpoints are saved, and process exits with code 0 (DAEM-08).

---

## Risks, Traps & Mitigation Strategies

| Risk / Trap | Impact | Severity | Mitigation Strategy |
|---|---|---|---|
| **Ping-Pong Loop** | Infinite revision creation, CouchDB disk explosion, network flooding | CRITICAL | Compare content SHA-256 and remote `_rev` against SQLite provenance before every transfer action. Discard identical states. |
| **Torn File Reads During Editor Save** | Pushing half-written file chunks to CouchDB | HIGH | Debounce watcher events by 300ms; re-read file stat/size before reading bytes; handle transient read errors with retry. |
| **Lost Invalidation Events** | Out-of-sync vault if OS drops inotify events | MEDIUM | Periodic full-reconciliation scan (every 300s) and post-error scans ensure eventual convergence regardless of watcher drops. |
| **Premature Checkpoint Advancement** | Missed remote changes if daemon crashes during processing | HIGH | Sequence checkpoints in SQLite are updated only when all preceding change tasks in the batch have durably verified. |
| **Unbounded Queue Memory Growth** | Out-of-memory crash during massive bulk edits | MEDIUM | Queue depth capped at 10,000 hints. If reached, pending hints coalesce into a single full-vault rescan flag. |
| **Zombie Process on Signal** | Process hangs indefinitely if worker promise blocks | MEDIUM | Graceful shutdown handler sets a 10-second drain deadline. If unfulfilled, forces clean abort and exit. |

---

## Plan Breakdown Recommendation for Phase 5

To ensure structured, test-driven implementation, Phase 5 is best executed across 4 sequential plans:

1. **Plan 05-01: Local Filesystem Watcher & Event Debouncing Engine**
   - Install and configure `chokidar@5.0.0`.
   - Implement `FsWatcher` (`src/daemon/fs-watcher.ts`) with path normalization, ignore rules, and trailing debouncer.
   - Implement `LoopSuppressor` (`src/daemon/loop-suppressor.ts`) using SQLite provenance comparisons.
   - Comprehensive unit test suite (`tests/unit/fs-watcher.test.ts`, `tests/unit/loop-suppressor.test.ts`).

2. **Plan 05-02: CouchDB Changes Feed Consumer & Resilient Reconnection**
   - Implement `ChangesConsumer` (`src/daemon/changes-consumer.ts`) consuming continuous NDJSON stream via guarded fetch.
   - Implement `ReconnectionManager` (`src/daemon/reconnection-manager.ts`) with jittered exponential backoff.
   - Implement Checkpoint Window Manager ensuring monotonic verified sequence advancement (DAEM-05).
   - Comprehensive unit test suite with mock streams and backoff timers.

3. **Plan 05-03: Continuous Engine, Worker Pool, and Single-File Reconciler**
   - Implement `FileWorkerPool` (`src/daemon/file-worker-pool.ts`) with per-path async mutex and concurrency limits.
   - Implement `FileReconciler` (`src/daemon/file-reconciler.ts`) for single-file authoritative re-reads and execution.
   - Implement `DaemonStateMachine` (`src/daemon/daemon-state.ts`) managing HEALTHY, DEGRADED, BLOCKED transitions (DAEM-07).
   - Implement `ContinuousEngine` (`src/daemon/continuous-engine.ts`) orchestrating admission (DAEM-01), finite catch-up (DAEM-02), and periodic scans (DAEM-06).

4. **Plan 05-04: CLI Command, Graceful Shutdown, and CouchDB Integration Suite**
   - Implement `ShutdownHandler` (`src/daemon/shutdown-handler.ts`) for `SIGINT`/`SIGTERM` coordination (DAEM-08).
   - Add `daemon` command to CLI (`src/cli/commands/daemon.ts`, `src/cli/index.ts`).
   - End-to-end integration test suites against Testcontainers CouchDB 3.5.2 (`daemon-lifecycle.test.ts`, `daemon-continuous-sync.test.ts`, `daemon-reconnection.test.ts`, `daemon-shutdown.test.ts`).
