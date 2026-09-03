# Architecture Patterns

**Domain:** Headless Self-hosted LiveSync-compatible file synchronization
**Researched:** 2026-09-03
**Overall confidence:** MEDIUM (the research seam's tier for cross-verified web retrieval; evidence is strongest for synchronization semantics and weakest for final packaging)

## Recommended Architecture

Build a **single-process modular monolith with ports and adapters**. Keep synchronization policy in project-owned application/domain modules, but delegate LiveSync wire-format behavior and CouchDB revision replication to pinned official primitives. The process owns two independent local persistence layers: a PouchDB protocol replica and a transactional application-state database.

```text
                     CLI commands / daemon supervisor
                                  |
                     Bootstrap + sync coordinators
                                  |
              SafetyPolicy issues scoped capabilities
         RemoteRead | VaultWrite | LocalDBWrite | RemotePush
                  /               |                 \
      Read-only admission    Reconciliation      Operation journal
             |                    engine                |
             |                 /          \             |
   LiveSync compatibility   pull/reflection  local/change planning
          adapter               |                   |
             |             Atomic filesystem   Chokidar hints
             |                reflector        + full scans
             |                    |                   |
       PouchDB replication ------+-------------------+
       /                 \
 local LevelDB replica    remote HTTP CouchDB (skip_setup)

 Shared truth: CouchDB revision trees and chunks
 Protocol cache: local PouchDB, including revision trees/checkpoints
 Process truth: SQLite admission, provenance, gates, intents, journal
 User truth: vault files, never assumed to have revision ancestry by themselves
```

This is deliberately not a set of networked services. The safety decisions require atomic coordination between admission, exact revision provenance, filesystem effects, and push enablement. Internal ports preserve testability and allow storage or packaging adapters to change without weakening those invariants.

### Core design decisions

1. **Use a full local PouchDB replica.** Follow the official CLI's proven shape rather than building on `DirectFileManipulatorV2`. The latter is useful for narrow direct operations, but Commonlib still documents incomplete or unstable enumeration, watch checkpoint, failure, conflict, concurrency, readiness, and disposal semantics.
2. **Pin `livesync-commonlib` exactly and wrap it.** Use official document types, path/ID conversion, encryption/compression, chunk assembly, revision/conflict helpers, and database file services where their semantics match. Do not allow `compat/*` imports outside `adapters/livesync/`; Commonlib is pre-1.0 and identifies compatibility exports as migration-oriented.
3. **Make first contact structurally incapable of remote writes.** The remote PouchDB uses `skip_setup: true`, but that option alone only prevents database creation. Put admission and pull traffic through a transport-policy adapter that rejects remote-mutating HTTP methods/endpoints and permits only the read and replication-probe requests required by PouchDB pull. Admission uses raw reads of existing compatibility records. It must not call `checkRemoteVersion`, `ensureDatabaseIsCompatible`, `SyncParamsHandler` initialization, or preferred-tweak helpers that transitively invoke those functions, because current implementations can create or update remote records. Where operations permit, run first contact with read-only CouchDB credentials as defense in depth.
4. **Separate protocol state from application state.** PouchDB owns replicated documents and replication checkpoints. SQLite owns the synchronizer's admission result, exact revision provenance, durable operation journal, watcher intents, and write gates. Do not put these concerns into vault files or infer them from mtimes.
5. **Treat watchers and `_changes` as invalidation feeds, not history.** Both can coalesce or omit intermediate events. Re-read authoritative current state before acting, and use complete scans at startup and periodically.
6. **Make write permission a durable, scoped capability.** A boolean setting is insufficient. The capability is bound to the canonical vault root, remote fingerprint, local replica identity, negotiated settings hash, Commonlib version, and successful bootstrap generation. Any mismatch invalidates it.

## State Ownership

| State | Owner | Contents | Rules |
|---|---|---|---|
| Shared LiveSync state | Remote CouchDB | Metadata documents, chunks, revision trees, conflicts, version information | Read and replicate only through non-administrative database APIs; never create, drop, purge, compact, rebuild, or garbage-collect the database |
| Protocol replica | Local PouchDB/LevelDB | Exact replicated documents, branch histories, local replication checkpoints | Disposable only through an explicit future recovery workflow; never treated as application bookkeeping |
| Application state | SQLite | Schema version, remote admission snapshot, bootstrap generations, gates, provenance, operation journal, durable watcher intents, quarantine index | Transactional; no passwords, bearer tokens, document plaintext, or chunk plaintext |
| Configuration | Explicit config plus secret provider | Vault/state paths, remote URL/database, non-secret options, references to runtime secrets | Credentials come from environment, file descriptor, or secret manager; status output redacts them |
| Materialized state | Vault filesystem | User files only | Never assume a file has ancestry unless exact revision provenance is recorded or uniquely reconstructed from byte equality |
| Recovery artifacts | State root plus same-directory temporary files | Quarantine copies, diagnostics, staged-write metadata | Never synchronized; temporary replacement files are on the target filesystem so rename is atomic |

Recommended application-state records:

- `instance`: stable client/node ID, canonical vault root, local-replica UUID, Commonlib version.
- `remote_admission`: normalized remote fingerprint; `_rev` and validated values/hashes for version, milestone, sync-parameters, preferred tweaks, and syncinfo verification; timestamps are diagnostic only.
- `bootstrap_run`: generation, state, pull result, counts, unresolved items, verified completion.
- `write_grant`: capability scope, bootstrap generation, negotiated-settings hash, grant time, revocation reason.
- `provenance`: canonical path to exact LiveSync document revision, optional observed mtime, and content digest. Revision is authoritative; mtime and digest accelerate checks.
- `operation`: deterministic operation ID, direction, path, source/base/target revisions, target precondition, staging path, phase, attempts, and error.
- `filesystem_intent`: coalesced path, event class, first/last observation, processing state. The event is only a request to inspect the path.
- `quarantine`: source path/revision, preserved artifact, reason, and operator disposition.

## Component Boundaries

| Component | Responsibility | May communicate with | Must not do |
|---|---|---|---|
| CLI | Parse commands, choose one-shot or daemon coordinator, render stable machine/human output and exit codes | Application coordinators | Import PouchDB/Commonlib, decide conflicts, expose database administration |
| Bootstrap state machine | Acquire lock, recover, admit remote, pull, decode, plan, materialize, verify, and publish readiness | Safety policy and ports | Skip states, enable push, silently accept partial completion |
| Safety policy / gate authority | Evaluate invariants and issue/revoke unforgeable in-process capabilities | Coordinators and state store | Perform I/O itself or infer safety from elapsed time |
| LiveSync compatibility adapter | Own all Commonlib imports; translate official types/outcomes into project domain types | Replica and reconciliation ports | Own process lifecycle, persist gates, hide unknown document types, or silently migrate remote metadata |
| Read-only remote inspector | Fetch and validate existing version, milestone, sync-parameters, preferred tweaks, and syncinfo | Remote HTTP/PouchDB read methods and compatibility decoder | Call any helper with create/update behavior; write checkpoints remotely |
| Remote transport policy | Enforce an audited HTTP method/endpoint allowlist for admission and pull-only modes | Remote inspector and PouchDB HTTP adapter | Treat `skip_setup` or a naming convention as proof that a request cannot write |
| Replica gateway | Open local LevelDB and remote HTTP PouchDB, run directional replication, expose exact revisions and conflicts | Compatibility adapter and coordinators | Resolve conflicts, parse sequence tokens, reflect files, auto-create remote DB |
| Reconciliation engine | Convert authoritative observations into deterministic `NoOp`, `Reflect`, `ExtendBranch`, `LogicalDelete`, `Preserve`, or `Block` decisions | Compatibility, state, filesystem metadata | Perform side effects or use newest-mtime-wins |
| Filesystem reflector | Rooted path validation, same-filesystem staged replacement, flush, rename, verification, preservation/quarantine | Journal and filesystem port | Follow symlinks, overwrite unproven divergent content, update provenance before verification |
| Filesystem scanner | Enumerate eligible files and produce current observations | Filesystem and reconciliation | Mutate files or infer missed changes from watcher cursors |
| Watch supervisor | Normalize Chokidar hints, durably enqueue affected paths, schedule scrub scans | Intent store and daemon coordinator | Write database documents directly or suppress loops solely by timers |
| Operation journal / recovery | Persist side-effect phases and resume or safely stop after crashes | State, reflector, compatibility adapter | Delete ambiguous artifacts to make recovery appear clean |
| Daemon supervisor | Start ordered workers, control backoff/cancellation, revoke gates on fatal compatibility changes, shut down cleanly | Coordinators and lifecycle ports | Start write-producing watchers before eligibility |
| Secret provider | Resolve credentials/passphrase just in time | Composition root and adapters | Persist secrets in SQLite, logs, process status, or crash reports |

The composition root is the only layer allowed to instantiate concrete adapters. Domain and application modules operate on typed ports and cannot reach raw CouchDB/PouchDB handles.

## LiveSync Compatibility Boundary

### Reuse directly

Pin the exact Commonlib version used by the supported official LiveSync release (currently `0.1.21`) and reuse:

- LiveSync document/chunk/settings types and constants.
- Path-to-document-ID and document-ID-to-path behavior, including obfuscation and case handling.
- Encryption, PBKDF2/salt, compression, chunk splitting/assembly, and syncinfo decode validation.
- Database file access and revision-aware storage helpers, including exact-live-base writes where their result is surfaced rather than coerced.
- Conflict traversal and common-ancestor primitives used by the official CLI/plugin.
- Offline scanner pair-state concepts: restore pending intent, revalidate exact path, then perform a full scan.

### Wrap or replace

- Wrap every Commonlib return type in project-owned result types such as `Compatible`, `Mismatch`, `UnsupportedFuture`, `Corrupt`, `Conflict`, and `TransientFailure`. Do not collapse them into booleans.
- Replace direct/manipulator watch behavior with local PouchDB changes plus a durable application processing cursor. Never rely on a cursor held only in memory.
- Add a project-owned atomic reflector; the current rooted Node storage's target-truncating write is not a crash-atomic materialization protocol.
- Implement a read-only admission inspector because official compatibility setup helpers can write version, milestone, node-info, tweak, salt, or connection metadata.
- Reproduce no remote administration feature. The compatibility adapter should not even expose an operation corresponding to database creation/destruction, purge, compaction, rebuild, or chunk garbage collection.

### Remote compatibility records

Admission must validate, at minimum:

| Record | Location | Validation |
|---|---|---|
| LiveSync version document | Regular database document | Present, recognized type/version, not newer than supported contract |
| Milestone | Remote `_local` document | Present, parseable, supported chunk range, not in an unsafe locked/cleaned transition, preferred tweak values exactly acceptable |
| Sync parameters | Remote `_local` document | Present, supported protocol version, expected salt fields available |
| Syncinfo | Regular encrypted document | Can be decoded using negotiated settings and supplied passphrase; expected sentinel shape |

Remote `_local` documents do not replicate, so inspect them directly on every startup and before promoting a push gate. For an existing database, a missing compatibility record is a hard block, not permission to initialize one. This is stricter than normal interactive setup and is intentional.

## Startup and Bootstrap State Machine

```text
STARTING
  -> LOCAL_READY
  -> REMOTE_READ_ONLY_ADMITTED
  -> SETTINGS_NEGOTIATED
  -> PULLING
  -> DECODE_VERIFIED
  -> MATERIALIZING
  -> BASELINE_VERIFIED
  -> READ_ONLY_READY
  -> WRITE_ELIGIBLE       (explicit grant + fresh admission check)
  -> ACTIVE

Any invariant failure -> BLOCKED
Fatal runtime compatibility/path/provenance failure -> DEGRADED_READ_ONLY
Transient transport failure -> current safe state + retry/backoff, never gate promotion
```

Detailed startup sequence:

1. **Lock and local validation.** Acquire one exclusive lock per canonical `(vault root, state root)`. Reject overlapping roots, unsafe permissions where detectable, path aliases, and symlink traversal. Open/migrate SQLite and local PouchDB; mark the run unclean until orderly shutdown.
2. **Recover before observing new events.** Replay incomplete journal operations, restore durable watcher intents, and verify the local replica identity. Ambiguous recovery blocks only the affected path and prevents push eligibility; it is not silently discarded.
3. **Open remote read-only.** Construct remote PouchDB with `skip_setup: true` behind the read-only transport policy; verify that the named database already exists and is readable. The policy must reject all document/configuration writes while allowing only the tested read/probe calls needed for pull replication. Do not request administrator privileges.
4. **Admit compatibility without mutation.** Directly read the four compatibility records above, classify the exact reason for any rejection, bind the result to their revisions/values, and redact all secrets.
5. **Negotiate and prove decoding.** Configure pinned official transforms from the remote settings, salt, and runtime secret. Decode syncinfo before pulling arbitrary user data.
6. **Pull only.** Replicate remote to local with conflict leaves preserved and `checkpoint: "target"`, so bootstrap checkpoint writes stay local. Treat CouchDB sequence tokens as opaque. Do not start the reverse replicator.
7. **Validate the replica.** Inspect metadata IDs against path-derived IDs, document types, case collisions, path traversal, all branch leaves, required chunks, chunk hashes, and complete decode. Preserve unknown records in the replica and report them; never delete them.
8. **Plan and materialize.** For every eligible remote file, produce a journaled plan. An absent file may be created. An existing byte-identical file may adopt provenance. A divergent or ambiguous existing file is preserved and blocks that path; no overwrite is justified merely because the vault is expected to be new.
9. **Verify baseline.** Re-read materialized bytes, verify every successful path against its exact source revision, run a complete filesystem/replica reconciliation, and ensure there are no failed or safety-relevant skipped items. Re-read remote admission records; if they changed, repeat admission/pull/verification.
10. **Publish read-only readiness.** Persist `READ_ONLY_READY`. The first vertical slice stops here. Re-running it must be idempotent.
11. **Grant writes separately.** A later explicit `enable-writes` command rechecks remote identity/settings and baseline generation. Only then may the process perform any compatibility registration that writes node metadata, translate filesystem changes into local revisions, and start local-to-remote replication.

The official CLI's staged initialization and full scan are good precedent, but do not copy its daemon shortcut that disables configuration-mismatch checking or its initial bidirectional replication. This project needs a pull-only admission boundary.

## Write Gates

Represent capabilities as opaque objects created only by `SafetyPolicy`; do not pass `boolean canWrite` flags.

| Capability | Earliest state | Permitted effects |
|---|---|---|
| `RemoteRead` | `REMOTE_READ_ONLY_ADMITTED` | Existing-document reads and remote-to-local replication |
| `LocalReplicaReceive` | `PULLING` | PouchDB replication writes into the local protocol replica |
| `VaultReflect` | `MATERIALIZING` | Journaled remote-to-vault effects for admitted revisions |
| `LocalRevisionWrite` | `WRITE_ELIGIBLE` | Revision-aware filesystem-to-local-PouchDB writes |
| `RemotePush` | `WRITE_ELIGIBLE` after a fresh admission check | Local-to-remote PouchDB replication only |

Revoke `LocalRevisionWrite` and `RemotePush` when any of these occur:

- remote database fingerprint or compatibility-record revision/value no longer matches the grant;
- future or unsupported protocol/tweak/chunk settings appear;
- syncinfo decryption, chunk validation, path rooting, or case-collision checks fail;
- a local file cannot be tied to an exact revision and the conflict cannot be proven through exact bytes and branch ancestry;
- the local replica is replaced, the vault root changes, Commonlib changes, or state migration invalidates the grant;
- an operation remains ambiguous after crash recovery.

Network unavailability alone does not erase the grant, but no queued writes are pushed until admission is refreshed. A degraded daemon may continue safe pulls/materialization only when the failure does not undermine decode, path, or provenance invariants.

## Revision-Aware Data Flows

### Remote to filesystem

```text
CouchDB revision tree
  -> PouchDB pull replication (new_edits=false semantics handled by replicator)
  -> local change invalidation
  -> fetch exact current revision + all conflict leaves
  -> decode metadata and every referenced chunk through Commonlib
  -> reconciliation decision using exact path provenance
  -> durable operation plan
  -> same-filesystem temp write + flush + atomic rename + directory sync where supported
  -> read-back byte verification
  -> provenance commit for exact revision
  -> operation done / processing cursor advances
```

A duplicate change is a no-op when the target bytes and recorded exact revision already match. The application processing cursor advances only after the side effect or safe no-op is durable; PouchDB's replication checkpoint remains a separate concern.

If multiple leaves exist, do not equate CouchDB's deterministic winner with the user's latest or safest content. Automatic merge is allowed only when an exact common ancestor body is available and the official conflict logic can prove the relationship. Otherwise preserve all data, report the conflict, and block automatic local extension of that path.

### Filesystem to remote

```text
Chokidar event or full-scan delta
  -> durable coalesced path intent
  -> fresh rooted stat/read (event payload is never authoritative)
  -> compare bytes with exact revision provenance and local revision tree
  -> NoOp, Preserve/Block, or extend exact live base
  -> Commonlib chunk/encode + metadata write into local PouchDB
  -> verify resulting exact revision and commit provenance
  -> PouchDB push replication, only with RemotePush capability
  -> retain/retry on transport failure; re-admit on compatibility failure
```

If the exact base revision is stale, refresh and reclassify; do not retry as an unconditional write. If provenance is missing, reconstruct it only when current bytes match exactly one available revision body. A filesystem deletion produces a new LiveSync metadata revision with `deleted: true`; it is not a PouchDB `_deleted` tombstone. For rename, create/verify the target revision first, then logically delete the source. Losing local content is moved to a recoverable quarantine/trash area before any replacement or logical deletion is committed.

### Loop suppression

Correctness comes from exact state comparison, not timing:

- Remote reflection records exact target revision only after verified installation.
- The resulting watcher hint causes a re-read; matching bytes plus provenance yields `NoOp`.
- Operation IDs and temporary in-memory suppression windows are optimizations only.
- Full scans use the same reconciliation function as watcher events, preventing separate semantics from drifting.

## Crash Recovery and Idempotency

Every filesystem side effect uses a deterministic operation key such as `hash(direction, canonicalPath, sourceRevision, desiredAction)` and progresses transactionally:

```text
PLANNED -> STAGED -> INSTALLED -> VERIFIED -> PROVENANCE_COMMITTED -> DONE
```

- **Crash before install:** validate the staged bytes/chunks and target precondition, then resume; otherwise preserve and replan.
- **Crash after rename:** if target bytes equal the intended revision, verify and commit provenance without rewriting.
- **Target changed during recovery:** preserve both versions, mark the operation ambiguous, and block pushes for the path.
- **Crash after local document write:** search the revision tree for the exact intended bytes/parent. Adopt a unique match rather than creating another child; ambiguity becomes a conflict.
- **Crash during replication:** rely on PouchDB checkpoints and replay-safe replication. Do not maintain a competing numeric `_changes` sequence or assume sequence tokens are integers.
- **Missed watcher events:** replay durable intents, then run a complete startup scan. The scan is the authority.

On shutdown, stop accepting new work, close filesystem watchers, cancel both directional replicators, finish or persist in-flight journal transitions, flush SQLite/PouchDB, and release the lock. A timeout leaves the unclean marker set, forcing recovery on next start.

## Filesystem Reflection Rules

1. Canonicalize and validate every decoded path beneath the vault root; reject absolute paths, traversal, NULs, unsupported names, symlink components, and normalized/case-folded collisions.
2. Write a randomized sibling temporary file so installation remains on the same filesystem. Set intended mode, flush file contents, rename atomically, then sync the parent directory where the platform supports it.
3. Verify by re-reading bytes. Update revision provenance only after verification.
4. Before replacing divergent content, preserve it to quarantine and block unless exact ancestry proves the operation safe.
5. Treat file mtimes as presentation/diagnostic metadata, never ordering or ancestry evidence.
6. Exclude the external state root and temporary naming pattern from scans/watchers. Do not place SQLite, PouchDB, logs, or credentials inside the synchronized vault.
7. Use Chokidar for normalized event hints, but retain startup and periodic full scans because Node filesystem watching varies by OS/filesystem and can coalesce, omit, or ambiguously classify events.

## Concrete Project Structure

Recommended stack shape: TypeScript ESM on Node 24 LTS, exact-pinned `livesync-commonlib` 0.1.21, PouchDB 9 with local LevelDB and remote HTTP adapters, Chokidar 5, and SQLite for transactional application state. Prove the native-adapter/single-executable combination early; keep `ReplicaPort` and `StateStore` replaceable if packaging constraints require a different adapter without changing domain policy.

```text
src/
  index.ts
  composition/
    createApplication.ts
  cli/
    main.ts
    exitCodes.ts
    output.ts
    commands/
      inspect.ts
      pull.ts
      sync.ts
      daemon.ts
      status.ts
      enableWrites.ts
  application/
    bootstrap/
      BootstrapMachine.ts
      BootstrapStates.ts
    sync/
      PullCoordinator.ts
      PushCoordinator.ts
      OneShotCoordinator.ts
    daemon/
      DaemonSupervisor.ts
    lifecycle/
      Recovery.ts
      Shutdown.ts
    gates/
      GateAuthority.ts
      Capabilities.ts
  domain/
    model/
      RemoteAdmission.ts
      RevisionProvenance.ts
      ReconcileDecision.ts
      Operation.ts
    policy/
      SafetyPolicy.ts
      PathPolicy.ts
    reconcile/
      ReconciliationEngine.ts
      ConflictClassifier.ts
  ports/
    CompatibilityPort.ts
    ReplicaPort.ts
    StateStore.ts
    FileSystemPort.ts
    WatcherPort.ts
    SecretProvider.ts
    ProcessLock.ts
  adapters/
    livesync/
      CommonlibCompatibility.ts
      CommonlibTypes.ts
      ReadOnlyRemoteInspector.ts
    pouchdb/
      PouchFactory.ts
      LocalReplica.ts
      RemoteReplica.ts
      RemoteTransportPolicy.ts
      ReplicationController.ts
    state/
      SqliteStateStore.ts
      migrations/
    filesystem/
      RootedVault.ts
      AtomicReflector.ts
      FullScanner.ts
      QuarantineStore.ts
      ChokidarWatcher.ts
    config/
      ConfigLoader.ts
      RuntimeSecretProvider.ts
tests/
  unit/
  contract/          # Commonlib adapter fixtures and version pin behavior
  integration/       # local CouchDB + real PouchDB revision trees
  fault-injection/   # crash at every journal transition
  interoperability/ # official CLI/plugin-generated fixtures and mixed-client runs
```

Keep runtime data outside the vault:

```text
state-root/
  instance.lock
  replica/           # PouchDB LevelDB
  state.sqlite
  quarantine/
  diagnostics/
```

## Patterns to Follow

### Functional reconciliation core

Given an observed filesystem state, exact local revision tree, provenance, and policy, return a typed decision without side effects. One-shot scans, watcher events, startup recovery, and daemon processing all call the same function.

```typescript
type Decision =
  | { kind: "noop"; revision: string }
  | { kind: "reflect"; sourceRevision: string }
  | { kind: "extend-branch"; baseRevision: string; bytes: Uint8Array }
  | { kind: "logical-delete"; baseRevision: string }
  | { kind: "preserve"; reason: string }
  | { kind: "block"; reason: string };
```

### Capability-bearing side-effect ports

Require the appropriate opaque capability as an argument to every mutating adapter method. This converts an architectural rule into a compile-time and testable boundary.

```typescript
interface ReplicaPort {
  pull(cap: RemoteRead, options: { checkpoint: "target" }): Promise<PullResult>;
  putFromFilesystem(cap: LocalRevisionWrite, write: ExactBaseWrite): Promise<PutResult>;
  push(cap: RemotePush): Promise<PushResult>;
}
```

### Typed outcomes, not exception-only control flow

Classify expected operational results: stale revision, conflict, missing chunk, incompatible setting, wrong secret, transport unavailable, path unsafe, and unsupported document. Exceptions are reserved for violated program invariants. This prevents a generic retry loop from converting a safety failure into repeated writes.

### Exact version contract tests

At every Commonlib upgrade, run fixtures produced by the supported official plugin/CLI through decode, materialization, local edit, logical delete, rename, conflict, and mixed-client replication tests. The adapter is the upgrade blast boundary.

## Anti-Patterns to Avoid

### Direct remote-to-filesystem synchronization
**Why bad:** It loses durable revision trees, conflict leaves, replication checkpoints, and a recovery boundary.
**Instead:** Replicate into local PouchDB first; reflect only verified exact revisions.

### Calling mutating compatibility setup during admission
**Why bad:** Official setup helpers may create/update version, milestone, sync-parameter, node-info, tweak, or last-connected records before the project has granted writes.
**Instead:** Raw read-only inspection first; compatibility registration only after verified bootstrap and explicit write authorization.

### Last-write-wins by mtime or CouchDB winner
**Why bad:** Neither proves ancestry. CouchDB's winner is deterministic, not semantically latest, and mtimes are device-local metadata.
**Instead:** Exact revision provenance and shared-ancestor conflict logic.

### Watcher-driven truth
**Why bad:** Node watcher events are lossy and ambiguous, particularly across Docker bind mounts and network filesystems.
**Instead:** Durable hints plus revalidation, startup scan, and periodic scrub.

### One `syncEnabled` boolean
**Why bad:** Pull, vault reflection, local revision creation, and remote push have different risk levels and prerequisites.
**Instead:** Separately scoped capabilities tied to a durable admission/bootstrap identity.

### Retrying stale writes blindly
**Why bad:** Retrying after `409` against the new winner can overwrite a concurrent branch relationship.
**Instead:** Refresh the tree and run reconciliation again from exact state.

### PouchDB tombstones for user file deletion
**Why bad:** It bypasses LiveSync's visible logical deletion semantics and complicates branch-aware recovery.
**Instead:** Create a child metadata revision with `deleted: true` from the exact live base.

### Destructive cleanup as recovery
**Why bad:** Dropping a replica, purging branches, deleting unknown docs, or erasing divergent files hides evidence and risks irreversible loss.
**Instead:** Preserve, quarantine, report, and require a later explicit recovery design. No destructive database administration belongs in this product.

## Suggested Build Order as Vertical Slices

### Slice 1 — Guarded remote-to-vault bootstrap

Deliver `inspect`, `pull`, and `status`; process lock; SQLite state; pinned compatibility adapter; read-only remote admission; local PouchDB pull with target-only checkpointing; decode/chunk validation; atomic materialization; exact provenance; complete verification; and a machine-readable report. End in `READ_ONLY_READY`. There is no code path for local revision writes or remote push.

Acceptance evidence: bootstrap an empty vault from official LiveSync fixtures; reject wrong secret, missing/mismatched settings, unsafe paths, conflicts requiring judgment, and a non-empty divergent target; prove remote document/update sequence is unchanged except for reads.

### Slice 2 — Repeatability and crash recovery

Add deterministic journal operations, unclean-start recovery, idempotent re-pull/re-materialization, quarantine, full-scan reconciliation, and fault injection at every journal transition.

Acceptance evidence: kill the process at every phase, restart repeatedly, and obtain either exact verified materialization or a preserved/blocking result—never duplicate revisions or silent overwrite.

### Slice 3 — Local changes into the isolated replica

Add full scanner and Chokidar durable intents, exact-base branch extension, chunk/metadata encoding, loop suppression, logical deletions, target-first rename, and conflict preservation. Keep remote push absent or hard-disabled.

Acceptance evidence: local edits produce correct LiveSync documents/chunks in the local replica; stale provenance and concurrent branches block or preserve; no remote change occurs.

### Slice 4 — Guarded one-shot bidirectional sync

Add explicit `enable-writes`, fresh admission recheck, narrowly scoped compatibility registration, remote push replication, transport retries, and mixed-client interoperability tests against the official CLI/plugin.

Acceptance evidence: only a matching durable grant enables push; revocation stops it immediately; edits/deletes/renames round-trip between clients without timestamp-based loss.

### Slice 5 — Daemon lifecycle

Add continuous directional replicators, ordered worker startup, backoff, signal handling, bounded shutdown, periodic scrub scans, status/health output, and degraded-read-only behavior. Arm filesystem-to-database workers only after write eligibility.

Acceptance evidence: missed/coalesced watcher events converge through scans; disconnect/reconnect resumes from PouchDB checkpoints; incompatibility changes revoke push; two processes cannot own one vault.

### Slice 6 — Single-executable and operational hardening

Prove Node single-executable packaging with the chosen PouchDB LevelDB and SQLite implementations, bundled Commonlib assets, Linux filesystem variants, container bind mounts, upgrades, and rollback-compatible state migrations. This is an early technical spike during Slice 1 and a production hardening slice here.

Acceptance evidence: the same interoperability and crash suite passes from the packaged artifact; no credentials enter the executable, state database, or logs.

### Ordering rationale

Every later slice consumes trust established by the earlier one. Remote push depends on proven compatibility, exact local revision provenance, idempotent reflection, and recovery. Daemonization comes after one-shot semantics because continuous workers amplify any ambiguity. Packaging is spiked early because native adapters can affect feasibility, but finalized only after behavior is stable.

## Scalability Considerations

This project is primarily bounded by vault size, chunk count, filesystem latency, and conflict density—not user count.

| Concern | Small vault | Large vault | Very large / slow filesystem |
|---|---|---|---|
| Startup scan | Complete serial or modest concurrency | Bounded parallel stat/hash/decode | Incremental batches with durable cursor, but periodic complete scrub remains |
| Materialization | Direct journal queue | Per-path coalescing and bounded workers | Backpressure replication processing; never unbounded decoded-byte buffering |
| Change processing | Individual invalidations | Coalesce by canonical path/revision | Batch PouchDB reads while preserving per-path journal ordering |
| Memory | Decode whole small files | Stream/chunk assembly where Commonlib permits | Explicit byte budgets and spill staged bytes to disk |
| Conflicts | Block/report | Index unresolved paths | Never auto-resolve to improve throughput |
| Watchers | One recursive watcher | Chokidar plus periodic scrub | Expect bind/network mount lossiness; scan cadence is configurable but safety invariants are not |
| SQLite | WAL mode, simple transactions | Indexed operation/provenance tables | Prune only completed application journal records by retention policy; never prune LiveSync history |

## Research Flags

- **Slice 1 packaging spike — MEDIUM confidence:** Verify Node 24 single-executable handling of PouchDB's local LevelDB adapter and the selected SQLite implementation before those adapters become costly to replace.
- **Commonlib upgrade procedure — HIGH importance:** It is pre-1.0 and the project necessarily uses some compatibility surfaces. Pin exactly and require contract/interoperability review for every upgrade.
- **Remote identity fingerprint — phase-specific detail:** Prefer CouchDB database UUID/instance identity when available, plus normalized origin/database and compatibility-record revisions. Confirm behavior through proxies and restored databases.
- **Filesystem durability matrix — platform-specific:** Atomic rename and directory synchronization differ across Linux filesystems and container mounts. Fault-test every supported deployment environment.
- **Automatic text merge — defer:** Shared-ancestor detection is necessary but not sufficient for safe user-facing merge behavior. Preserve conflicts in the MVP rather than broadening scope.

## Confidence Assessment

| Area | Confidence | Basis |
|---|---|---|
| Commonlib/official CLI boundaries | MEDIUM | Current official source, package metadata, architecture notes, and CLI implementation were cross-checked; tier is capped by the research seam |
| LiveSync document/settings semantics | MEDIUM | Current official types, constants, SyncParams handler, CouchDB replicator, and conflict/offline-scanner documentation; tier is capped by the research seam |
| CouchDB/PouchDB revision flow | MEDIUM | Official CouchDB and PouchDB documentation plus official LiveSync usage; tier is capped by the research seam |
| Filesystem/watch safety | MEDIUM | Official Node documentation, Chokidar documentation, and Commonlib storage/scanner behavior; tier is capped by the research seam |
| Gate/state/journal architecture | MEDIUM | Derived design, constrained by the verified semantics above; requires implementation fault tests |
| Single-executable packaging | MEDIUM | Node supports the mechanism, but native adapter compatibility must be proven in the target artifact |

The research-provider confidence classifier returned **MEDIUM** even for cross-verified web retrieval. All findings retain that tier. Agreement between multiple current official primary sources and direct source inspection strengthens the evidence within the tier, while project-specific gate and journal design still requires implementation tests.

## Sources

Official LiveSync/Commonlib:

- [livesync-commonlib README and supported entry points](https://github.com/vrtmrz/livesync-commonlib/blob/main/readme.md)
- [Commonlib package metadata](https://github.com/vrtmrz/livesync-commonlib/blob/main/package.json)
- [DirectFileManipulatorV2 implementation](https://github.com/vrtmrz/livesync-commonlib/blob/main/src/API/DirectFileManipulatorV2.ts)
- [LiveSync document type definitions](https://github.com/vrtmrz/livesync-commonlib/blob/main/src/common/types.ts)
- [Database constants](https://github.com/vrtmrz/livesync-commonlib/blob/main/src/common/models/db.const.ts)
- [Tweak compatibility definitions](https://github.com/vrtmrz/livesync-commonlib/blob/main/src/common/models/tweak.definition.ts)
- [Sync parameter handler](https://github.com/vrtmrz/livesync-commonlib/blob/main/src/replication/SyncParamsHandler.ts)
- [CouchDB LiveSync replicator](https://github.com/vrtmrz/livesync-commonlib/blob/main/src/replication/couchdb/LiveSyncReplicator.ts)
- [Database lifecycle](https://github.com/vrtmrz/livesync-commonlib/blob/main/docs/database-lifecycle.md)
- [Offline scanner and recovery semantics](https://github.com/vrtmrz/livesync-commonlib/blob/main/docs/offline-scanner.md)
- [Conflict resolution and revision provenance](https://github.com/vrtmrz/livesync-commonlib/blob/main/docs/conflict-resolution.md)
- [Evidence for maintained consumers](https://github.com/vrtmrz/livesync-commonlib/blob/main/docs/proven-in-use.md)
- [Official LiveSync CLI](https://github.com/vrtmrz/obsidian-livesync/tree/main/src/apps/cli)
- [Official CLI daemon/run lifecycle](https://github.com/vrtmrz/obsidian-livesync/blob/main/src/apps/cli/commands/runCommand.ts)
- [Official setup guidance for subsequent devices](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/setup_own_server.md)

Official database/runtime documentation:

- [Apache CouchDB conflict model](https://docs.couchdb.org/en/stable/replication/conflicts.html)
- [Apache CouchDB replication protocol and checkpoints](https://docs.couchdb.org/en/stable/replication/protocol.html)
- [Apache CouchDB changes feed](https://docs.couchdb.org/en/stable/api/database/changes.html)
- [PouchDB API: adapters, revisions, replication, and checkpoints](https://pouchdb.com/api.html)
- [Node.js filesystem API and watch caveats](https://nodejs.org/docs/latest-v24.x/api/fs.html)
- [Chokidar watcher semantics](https://github.com/paulmillr/chokidar)
- [Node.js single executable applications](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html)
