# Pitfalls Research

**Domain:** Headless Self-hosted LiveSync-compatible filesystem synchronizer
**Project:** obsidian-livesync-headless
**Researched:** 2026-09-03
**Confidence:** MEDIUM — findings were verified against current upstream LiveSync/Commonlib source and official CouchDB/PouchDB documentation; the GSD confidence seam rates verified web-derived evidence MEDIUM, and Commonlib remains pre-1.0.

## Safety Position

This client should prefer a recoverable duplicate, unresolved conflict, retained tombstone, or stopped daemon over any guessed overwrite or deletion. Existing Self-hosted LiveSync clients and the existing remote database define the compatibility contract. The headless client is not entitled to “repair” remote state merely because it cannot understand or materialize it.

The most dangerous category error is to treat LiveSync as a timestamp-based file mirror. It is a revision-tree protocol whose file bodies are assembled from separately replicated, possibly encrypted chunks. Correctness depends on exact document identity, exact branch ancestry, remote-only configuration documents, durable device-local provenance, and operation ordering.

## Non-Negotiable Fail-Closed Invariants

These invariants should be implemented before any bidirectional synchronization feature:

1. **No write-capable first contact.** A new remote starts in `UNVERIFIED_READ_ONLY`. Only side-effect-free reads are allowed until version, sync parameters, milestone state, tweak values, encryption mode, path identity policy, and supported document shapes have been validated. A missing marker on a non-empty database is ambiguity, not permission to initialize it.
2. **No implicit remote initialization.** Discovery must not create `obsydian_livesync_version`, `_local/obsidian_livesync_sync_parameters`, `_local/obsidian_livesync_milestone`, `syncinfo`, design documents, indexes, or any other document. Current upstream helpers can create or update some of these while “checking”; do not call those helpers from the read-only probe.
3. **No push before a complete safe pull/materialization gate.** The first local scan cannot infer deletions, and filesystem absence cannot become a remote deletion, until the remote has been pulled, every selected live Metadata revision has either been materialized or explicitly quarantined, and durable provenance has been recorded.
4. **Never guess a branch.** Every edit, deletion, and same-document rename must extend the exact revision known to have produced the local file. The deterministic PouchDB winner, largest generation, newest `mtime`, path, size, or a coincidental content match across several revisions is not proof.
5. **Unknown means preserve.** Unknown document type, malformed-but-retained metadata, missing chunk, decryption failure, future version, future settings schema, identity mismatch, ambiguous case fold, unavailable ancestor, 409, partial bulk result, watcher overflow, or failed local write must stop or quarantine the affected path without deleting remote or local evidence.
6. **Chunks precede Metadata.** A writer persists and verifies every referenced chunk before publishing Metadata. A reader still tolerates Metadata-before-chunk visibility and does not classify the Metadata as corrupt or deleted while a chunk may still arrive.
7. **A file becomes visible atomically.** Remote bytes are fully assembled, decrypted, decoded, length-checked, and staged before replacing a destination. Provenance and loop-suppression state are committed only after replacement succeeds.
8. **Source before cleanup, target before source deletion.** Cross-path rename and identity repair write and verify the target first. Failure may leave a duplicate; it must not remove the only copy.
9. **Checkpoints follow durability.** An opaque CouchDB sequence is stored only after all preceding rows and every per-document bulk result are durable. Replayed changes must be idempotent.
10. **No remote maintenance capability.** Drop, reset, rebuild, purge, compaction, garbage collection, revision-limit changes, security changes, and server-side replication are absent from the application capability graph, not merely hidden behind a flag.
11. **No destructive retry.** A retry re-reads current state and repeats an idempotent operation. It never converts a conflict, timeout, parse error, or missing response into a forced overwrite or deletion.
12. **Tests cannot address a real database.** Integration tests require an ephemeral CouchDB instance and unique database identity created by the external test harness. The application under test receives only database-member credentials and no ability to administer the server.

## Denylisted Remote Operations

Enforce this at three layers: do not expose methods in application interfaces; reject them in the CouchDB transport before sending; and use credentials without server/database-admin authority. URL checks must parse and canonicalize the configured database path rather than rely on substring matching.

### Hard denylist

| Operation | Examples | Why it must be unreachable |
|-----------|----------|----------------------------|
| Create or delete a database | `PUT /{db}`, `DELETE /{db}` | Creation can initialize the wrong target; deletion is catastrophic. Existing-database absence is a bootstrap failure. |
| Purge revisions | `POST /{db}/_purge`; PouchDB/Couch purge APIs | Purge removes revision-tree evidence and can allow stale replicas to reintroduce data or lose convergence history. |
| Compact database or views | `POST /{db}/_compact`, `POST /{db}/_compact/{ddoc}`, `POST /{db}/_view_cleanup`; `.compact()`, auto-compaction | Compaction discards non-leaf bodies needed for history inspection and conservative merge. This project explicitly does not trade recoverability for space. |
| Reset, rebuild, or garbage-collect remote | Commonlib/LiveSync rebuild, clean, GC, remote reset, “overwrite server” paths | These workflows choose an authoritative copy and remove remote-only evidence; that choice is outside project authority. |
| Change retention or purge settings | `PUT /{db}/_revs_limit`, `PUT /{db}/_purged_infos_limit` | Changes how much ancestry/purge evidence survives and can break later recovery. |
| Change database/server security or configuration | `PUT /{db}/_security`, `/_node/*/_config`, `/_cluster_setup`, shard/placement endpoints | Broadens authority and can alter durability, access, or topology. |
| Create/update/delete design documents or indexes | `/{db}/_design/*`, `/{db}/_index/*` | Not required for v1 file synchronization and needs elevated authority. Avoid legacy helper paths that install chunk views. |
| Start server-managed replication | `POST /_replicate`, writes to `/_replicator` | Can mutate an unintended target outside the guarded client lifecycle. |
| Direct remote document deletion | `DELETE /{db}/{docid}` | Ordinary user deletion is a LiveSync Metadata revision with `deleted: true`; branch tombstones, when explicitly required, should flow through the reviewed local revision operation and normal replication. |

### Write-gated operations

These are not globally deniable because normal CouchDB/PouchDB replication needs them, but only a narrowly owned replication component may issue them after `WRITE_ENABLED`:

| Operation | Gate |
|-----------|------|
| `POST /{db}/_bulk_docs` | Only normal reviewed replication; inspect every result. `new_edits:false` is allowed only to preserve source revision ancestry, never to fabricate revisions. |
| `PUT`/`POST` normal documents | Only validated LiveSync document shapes, with exact `_rev` CAS semantics and a current compatibility lease. |
| Writes to remote `_local` sync/milestone documents | Never during discovery. Later writes require exact schema/version support, current `_rev`, and proof that the headless client is entitled to register/update only its own node data. |
| Conflict-leaf `_deleted` revisions | Only an explicit, provenance-checked conflict-resolution operation. Never ordinary file deletion, missing-chunk handling, bootstrap, or automatic cleanup. |

Any redirect must be revalidated against the configured scheme, authority, and database path. Never forward `Authorization` across an authority change.

## Critical Pitfalls

### Pitfall 1: A “compatibility check” mutates the remote during bootstrap

**Confidence:** MEDIUM (current upstream source, cross-checked across negotiation and replication paths)

**What goes wrong:**
The first run writes version, sync-parameter, milestone, preferred-tweak, or node documents before the operator has proven that the database, passphrase, and path policy are compatible. A wrong database URL can be silently initialized. Two new clients can race to choose different PBKDF2 salts. A future or damaged database can be stamped as current. An empty local vault can then be treated as authoritative and delete or overwrite remote data.

**Why it happens:**
Upstream `checkRemoteVersion()` creates the typo-preserved version document when absent; `SyncParamsHandler` creates and salts missing remote sync parameters; `ensureRemoteIsCompatible()` may update the remote milestone before returning mismatch/lock status. These are valid inside upstream’s owned setup flow but are not pure discovery functions.

**Warning signs:**

- HTTP `PUT`/`POST` appears in a supposed connection test.
- A read-only credential makes “inspect” fail even though all required GETs succeed.
- Remote `update_seq`, `doc_count`, version document, or `_local` documents change during dry-run.
- A missing marker is automatically filled rather than reported.
- Watchers or push replication start before remote configuration has been persisted locally and reviewed.

**Concrete prevention:**

- Build a separate pure probe from GET/HEAD calls; do not instantiate a push-capable replicator.
- Capture database UUID/info, version document, remote-only sync parameters, milestone, lock/cleaned state, accepted-node ranges, preferred tweaks, and representative document shapes without writing defaults.
- Distinguish “missing because this is a genuinely new empty test database” from “missing on an existing database.” v1 should support only an existing initialized LiveSync database and fail the former too.
- Persist a signed/hashed compatibility snapshot locally and recheck the relevant remote revisions immediately before enabling writes.
- Test that bootstrap succeeds with read-only credentials and that `update_seq` is unchanged.

**Recovery:**
Stop all synchronization. Back up the remote and every vault/local PouchDB. Compare changed marker revisions with a healthy client or backup. Do not delete the accidental markers or reset the database automatically; restore only through an operator-reviewed additive revision or server backup. If competing security seeds were written, preserve both states and recover from a known-good client/backup rather than guessing a passphrase/salt pair.

**Phase to address:** Phase 0 (safety capability boundary) and Phase 1 (read-only discovery) — must block all later phases.

---

### Pitfall 2: Treating the deterministic winner as the displayed or authoritative revision

**Confidence:** MEDIUM (LiveSync conflict specification, Commonlib implementation, CouchDB/PouchDB conflict docs)

**What goes wrong:**
A local edit, deletion, or rename is attached to the PouchDB winner even though the file shown on that device came from another live leaf. The real branch is silently abandoned, a deletion can erase the wrong side, and a stale device can recreate a conflict or overwrite a resolved result.

**Why it happens:**
PouchDB returns one deterministic winner by default. Winner selection gives replicas a consistent read result; it does not encode recency, safety, peer origin, or what bytes were reflected to the filesystem. CouchDB also does not retain which peer originated a replicated revision.

**Warning signs:**

- Writes use only `_id` and current winning `_rev`.
- Code compares revision generation or `mtime` to select a branch.
- `_conflicts`, `open_revs=all`, or exact-revision reads never appear in tests.
- Provenance is updated on scan/read rather than only after successful reflection/write.
- Resetting local state causes edits to move to another branch without review.

**Concrete prevention:**

- Persist device-local `path -> exact displayed revision` provenance in a durable store opened before scanning, watching, or replication.
- Extend that exact revision through ordinary CAS. Re-read all current leaves before mutation and reject stale bases.
- Reconstruct missing provenance only when current file bytes match exactly one available revision body. Zero or multiple matches remain unresolved.
- Compare exact bytes, not size/path/time/hash alone. A content hash may prove equality but not branch identity when several revisions share content.
- On unproven edit, preserve bytes as a separately reviewable branch only if ancestry can be represented without invention; on unproven delete, preserve every remote branch.

**Recovery:**
Pause writers and enumerate every live leaf plus available ancestry. Copy each readable version out of the vault/database. Restore the intended bytes as a new child of an explicitly selected live revision; do not force-rewrite the winner. If provenance cannot be reconstructed, retain all leaves and require manual selection.

**Phase to address:** Phase 0 (revision fixtures), Phase 3 (bidirectional writes), and Phase 4 (conflicts/provenance).

---

### Pitfall 3: Collapsing LiveSync logical deletion, CouchDB `_deleted`, and purge into one concept

**Confidence:** MEDIUM (LiveSync data structures/conflict spec and official CouchDB/PouchDB deletion docs)

**What goes wrong:**
An ordinary filesystem deletion becomes a CouchDB tombstone, a conflict resolution deletes every live leaf, or a “cleanup” purges history. Deleted content may disappear from conflict review, fail to participate as a live branch, or later be resurrected by another replica. Conversely, ignoring LiveSync’s `deleted: true` field can rematerialize files users intentionally deleted.

**Why it happens:**
There are three distinct semantics:

- LiveSync Metadata `deleted: true` is a current logical-deletion revision with enough document structure to remain a visible branch.
- CouchDB/PouchDB `_deleted: true` is a replication tombstone and typically removes the document body from normal reads.
- Purge removes revisions outside normal replicated-deletion semantics.

Upstream may use `_deleted` for explicit losing-leaf removal, legacy entries, expired deletion history, or chunk GC, but those are not ordinary user file deletion.

**Warning signs:**

- `db.remove()` or remote HTTP DELETE handles filesystem unlink events.
- A missing local file causes all conflict leaves to be tombstoned.
- Code filters `_deleted` but never checks LiveSync `deleted`.
- “Free space” or “vacuum” code exists in the synchronizer.
- A stale client recreates files after another client deleted them.

**Concrete prevention:**

- Represent user deletion as `deleted: true` on a child of the proven displayed Metadata revision; retain path/type/chunk references as required by the current contract.
- Treat `_deleted` only as a protocol tombstone. Never convert between the two generically.
- Never purge. Never expire deletion history in this project.
- An absent file without proven prior local existence/provenance is not a deletion event, especially during bootstrap.
- Apply a remote logical deletion locally through recoverable trash/quarantine where available; record success only after the move/removal is verified.

**Recovery:**
For a mistaken tombstone, retrieve an available pre-tombstone revision or healthy-replica copy and write its bytes as a new, reviewed live successor. If purge occurred, stop replication to prevent propagation/reintroduction surprises and restore from an unaffected replica or backup; the purged database alone may no longer contain recoverable evidence.

**Phase to address:** Phase 0 (semantic model), Phase 3 (deletion writes), Phase 4 (conflict deletion), Phase 6 (destructive-operation audit).

---

### Pitfall 4: Assuming Metadata and chunks arrive atomically or that “unreferenced” chunks are disposable

**Confidence:** MEDIUM (LiveSync chunk specifications, Commonlib tests, CouchDB replication semantics)

**What goes wrong:**
A Metadata revision is reflected before all `children` chunks exist locally, yielding a truncated/empty file. A missing chunk is treated as proof that the Metadata is corrupt and the revision is deleted. A naive reachability scan deletes chunks still required by a conflict leaf, shared file, or merge ancestor. Historical revisions remain but become unreadable.

**Why it happens:**
Writers save chunks before Metadata, but CouchDB transfers documents independently and offers no cross-document transaction. On-demand chunk mode intentionally excludes chunks from ordinary pull replication. Chunks are content-addressed and shared. Current LiveSync GC protects winners, all conflict leaves, divergence ancestry, and nearest available common ancestors—but this project must not run GC at all.

**Warning signs:**

- File reflection begins after reading Metadata without validating all child IDs.
- Missing chunks trigger deletion, zero-byte output, or checkpoint advance.
- Metadata is uploaded before chunk write results are checked.
- Code counts references only from winners.
- Any feature is named cleanup, orphan removal, chunk vacuum, or compact.

**Concrete prevention:**

- Persist and verify every chunk before Metadata publication.
- On pull, fetch all chunks by exact ID, tolerate delayed arrival, and distinguish explicit remote absence from timeout/transport failure.
- Validate chunk shape, decryption, concatenation order, decoded byte length, Metadata type (`plain` versus `newnote`), and recorded size before staging a file.
- Keep unreadable revisions and report exact missing IDs. Never emit raw decrypted content in diagnostics.
- Do not implement chunk deletion, reachability GC, or compaction. Reachability analysis may exist only as a read-only diagnostic.

**Recovery:**
Pause replication and locate missing chunks in another synchronized local PouchDB, an un-compacted remote/backup, or a vault containing the exact bytes. Recreating identical bytes under the same negotiated hash/encryption settings can recreate a content-addressed chunk, but does not automatically restore an old revision. Preserve the unreadable Metadata leaf until recovery is complete or the operator explicitly resolves it.

**Phase to address:** Phase 2 (pull/materialization), Phase 3 (upload ordering), Phase 4 (unreadable conflicts), Phase 6 (denylist verification).

---

### Pitfall 5: Decrypting, hashing, or deriving paths with the wrong compatibility settings

**Confidence:** MEDIUM (current Commonlib encryption/path/hash source and LiveSync settings/data-structure docs)

**What goes wrong:**
The client cannot find Metadata, generates different chunk IDs, writes undecryptable chunks, exposes encrypted path blobs as filenames, or mistakes decryption failure for missing/deleted data. Changing passphrase, E2EE algorithm, dynamic-iteration policy, path obfuscation, or case handling mid-database can create a parallel namespace and apparent mass deletion.

**Why it happens:**
Chunk IDs depend on content, hash algorithm, encryption state, and a passphrase-derived value. Metadata IDs depend on normalized path, case policy, underscore escaping, and optional path obfuscation. E2EE V2 uses AES-GCM/HKDF behavior plus the PBKDF2 salt in remote `_local/obsidian_livesync_sync_parameters`; V1 compatibility has different headers/fallback behavior. Under V2 property encryption, the path field carries encrypted metadata while visible `mtime`, `ctime`, `size`, and `children` may be zero/empty until decryption.

**Warning signs:**

- Many Metadata IDs appear absent while `f:` documents exist.
- Chunk IDs change for unchanged bytes after restart/config change.
- `e_`, `%`, `%=`, `f:`, or `/\\:` markers are ignored or treated as user paths.
- Decryption failures are converted to 404/missing.
- A client writes a new security seed when a read failed.
- Passphrases or decrypted paths appear in logs.

**Concrete prevention:**

- Fetch and validate remote sync parameters before decrypting or hashing; never regenerate a missing/failed seed on an existing remote.
- Negotiate exact E2EE algorithm, `encrypt`, dynamic iteration behavior, hash algorithm, path obfuscation, and case policy before write enablement.
- Use upstream-reviewed primitives pinned to an exact Commonlib version; add golden fixtures for V1, V2, encrypted chunks, encrypted Metadata properties, obfuscated paths, binary data, and wrong-passphrase failures.
- Treat authentication/decryption/tag/JSON failures as terminal for the affected operation. Preserve ciphertext and Metadata unchanged.
- Separate CouchDB credentials from E2EE passphrase and redact both.

**Recovery:**
Stop writes immediately. Restore the last known compatible settings and security seed from a healthy client/config backup, then retry read-only decoding. Do not “fix” ciphertext, rewrite paths, or rotate passphrases in place. If settings were changed and parallel IDs were written, preserve both namespaces and use an operator-chosen authoritative vault plus a separately reviewed migration/recovery workflow outside v1.

**Phase to address:** Phase 1 (remote negotiation), Phase 2 (read/decrypt fixtures), Phase 3 (hash/write fixtures), Phase 6 (security review).

---

### Pitfall 6: Ignoring remote database version, milestone state, or tweak mismatch

**Confidence:** MEDIUM (current LiveSync/Commonlib source and release compatibility ADR)

**What goes wrong:**
The client writes documents a current Obsidian client cannot decode, uses an incompatible path namespace, generates inefficient/incompatible chunks, joins a remote that is locked after rebuild/cleanup, or overwrites the preferred remote settings with local defaults.

**Why it happens:**
LiveSync has independent version dimensions: plugin SemVer, settings schema, internal database `VER`, accepted chunk-version ranges, sync protocol version, and remote tweak values. At the reviewed commit, internal `VER` is 12, but hard-coding that number without pinning source is unsafe. Current tweak classification treats encryption, path obfuscation, dynamic iteration, and case sensitivity as incompatible; hash algorithm, custom chunk size, and splitter version are compatible-but-lossy and may be aligned by timestamp policy in current clients.

**Warning signs:**

- Code compares only plugin/package SemVer.
- `obsydian_livesync_version` is “corrected” to a differently spelled ID.
- `disableCheckingConfigMismatch` or `ignoreVersionCheck` is enabled by default.
- Missing/failed milestone reads are treated as empty defaults.
- The client updates `PREFERRED` tweaks before proving compatibility.
- `locked`, `cleaned`, `accepted_nodes`, or chunk version ranges are ignored.

**Concrete prevention:**

- Pin the exact Commonlib/LiveSync contract and derive constants from it.
- Read remote version, remote-only milestone, sync parameters, and preferred tweaks separately; do not expect CouchDB `_local` documents to replicate into local PouchDB.
- Block future version/schema, non-overlapping chunk ranges, lock/cleaned state, unavailable configuration, and incompatible tweaks.
- For compatible-but-lossy differences, follow the current upstream selection rule exactly only after tests prove interoperation; otherwise stop and require configuration. Never auto-accept an incompatible difference.
- Revalidate marker revisions before enabling push and whenever those documents change.

**Recovery:**
Pause this client and inspect with a compatible current Obsidian LiveSync client. Restore the client configuration from remote values only after explicit review. Do not downgrade version documents or unlock/clear milestone state. If the remote was rebuilt/cleaned by another client, preserve the local vault separately and perform a pull-only comparison before any merge decision.

**Phase to address:** Phase 1 (compatibility gate), with regression fixtures refreshed in Phase 6 for every pinned upstream upgrade.

---

### Pitfall 7: Miscomputing document identity across case rules, path obfuscation, and renames

**Confidence:** MEDIUM (LiveSync data structure, metadata-ID repair specification, path service source)

**What goes wrong:**
Two local paths map to one document ID, one path maps to two IDs across clients, a leading underscore enters the reserved namespace, or a case-only rename is implemented as delete+create. Folder case changes and case-fold collisions can cause oscillation, duplicates, failed reflection, or deletion of a still-live document.

**Why it happens:**
Current identity derivation normalizes the path, lowercases when case-sensitive handling is disabled, escapes leading `_` with `/`, and optionally obfuscates. In case-insensitive mode a case-only file rename remains in one revision tree; a cross-path rename uses a new document ID. Current settings documentation does not support folder case-only rename through the same handling. A Linux filesystem can physically hold names that a case-insensitive LiveSync namespace cannot distinguish.

**Warning signs:**

- `A.md` and `a.md` both exist while case-insensitive handling is configured.
- Actual `_id` differs from `path2id(decrypted path)`.
- Rename code always emits independent delete/create operations.
- Folder-only case changes repeatedly reappear.
- Path derivation is duplicated instead of using one pinned service.

**Concrete prevention:**

- Centralize path normalization and ID derivation; validate `actualDocumentId === path2id(declaredPath)` before any reflection, deletion, last-seen update, or repair.
- Preflight the vault for case-fold collisions and unsupported paths; block only affected paths and do not choose a winner.
- Same-ID/case-only rename extends the proven displayed revision. Cross-ID rename writes and verifies target first, then logically deletes only the proven source branch.
- Revalidate both rename halves against current filesystem state after restart. Never infer absence from an I/O error.
- Reject traversal, absolute paths, symlink components, NULs, and platform-reserved names before reflection; quarantine without changing remote state.

**Recovery:**
Pause all participating devices. Copy every spelling variant and revision to a safe directory. Inspect actual IDs and declared paths read-only. For a single unambiguous metadata-ID mismatch, repair target-first and source-last with exact revision revalidation; widespread cross-device naming differences require an operator-selected authoritative naming plan, not batch auto-repair.

**Phase to address:** Phase 0 (path fixtures), Phase 2 (safe materialization), Phase 3 (rename semantics), Phase 5 (watcher rename reconciliation).

---

### Pitfall 8: Trusting filesystem watcher events as a durable ordered log

**Confidence:** MEDIUM (official Node filesystem docs, Chokidar docs, current upstream CLI adapter)

**What goes wrong:**
An editor’s atomic save looks like unlink+add, a large/paused write is read halfway, a rename arrives in the wrong order, events are coalesced or duplicated, network/container filesystems drop events, and the synchronizer uploads truncated content or emits a false deletion. Reflected remote writes can echo back as new local edits.

**Why it happens:**
Node documents platform-dependent `fs.watch` behavior. Chokidar normalizes raw events heuristically; `awaitWriteFinish` observes size stability, not semantic completion, and its threshold is workload-dependent. The current upstream CLI adapter receives add/change/unlink rather than a durable rename transaction and uses a 500 ms stability threshold.

**Warning signs:**

- Correctness tests pass only with sleeps.
- A save briefly uploads zero bytes or creates a conflict.
- Rename produces source deletion before target upload.
- Daemon has no periodic/startup full reconciliation.
- Loop suppression is a broad time window that can hide a real user edit.
- Watcher errors are logged but the process continues as if protected.

**Concrete prevention:**

- Treat watcher events as hints that enqueue a per-path reconciliation, not as file truth.
- Serialize operations by normalized document identity; coalesce hints, then re-stat/read/re-stat and retry if identity, size, mtime, or bytes change during the read.
- Use startup and periodic full scans to cover downtime, overflow, unsupported recursive watch, and coalescing.
- Persist operation intent atomically and revalidate it against current exact paths after restart. A restored delete is admitted only when absence is successfully observed.
- For rename-like add/unlink pairs, publish target first. If relation cannot be proven, keep the source and accept a duplicate.
- Suppress echoes by exact operation/provenance evidence after a successful local commit, not by ignoring all events for a duration.
- Fatal watcher loss must mark daemon unhealthy and stop remote writes or exit for supervised restart.

**Recovery:**
Stop the watcher/push loop, preserve current local files, and run a read-only reconciliation against all remote leaves. Any file uploaded from a partial read becomes a conflict candidate; retain the previous revision and restore from known complete bytes. Restart watching only after the durable queue and full scan agree.

**Phase to address:** Phase 5 (daemon/watch loop) after one-shot bidirectional semantics are proven.

---

### Pitfall 9: Non-atomic local reflection and non-durable operation/provenance state

**Confidence:** MEDIUM (current upstream Node storage source plus official Node filesystem behavior)

**What goes wrong:**
A crash or disk-full condition after truncating a destination leaves a partial/zero-byte vault file. On restart, the watcher treats it as a user edit and uploads corruption. A direct-write queue/provenance JSON file becomes invalid, so the client forgets branch identity or pending operations and makes unsafe decisions.

**Why it happens:**
Opening with `O_TRUNC` changes the destination before the replacement is complete. A successful JavaScript promise does not alone establish crash durability. The current upstream Node storage adapter writes in place, and its CLI snapshot persistence writes directly and may swallow errors; those are implementation boundaries to improve for this preservation-first project.

**Warning signs:**

- Destination files are opened with `w`/`O_TRUNC` for remote reflection.
- No same-directory temp file, file sync, rename, or parent-directory sync exists.
- Provenance is written before vault replacement.
- Disk-full and crash-injection tests leave an apparently valid checkpoint.
- Corrupt state files are treated as empty state.

**Concrete prevention:**

- Assemble into a uniquely named same-directory temporary file; set safe permissions; write all bytes; flush/sync the file; close; atomically replace; sync the containing directory where supported; then apply/verify timestamps.
- Never expose temporary files to synchronization filters.
- If cross-platform replacement cannot be guaranteed, preserve the old target as a recovery copy and use a state machine whose restart behavior is tested.
- Store journal/provenance/checkpoints with the same atomic-write discipline and checksums/schema version. Corrupt state fails closed.
- Commit state in order: bytes durable → target visible and verified → provenance durable → self-event suppression enabled.

**Recovery:**
Keep the partial file; do not upload it. Recover complete bytes from the temp/recovery file, exact remote revision plus chunks, another vault, or backup. Reconstruct provenance only from a unique exact revision match. If local state is corrupt and identity is ambiguous, preserve all content and require review.

**Phase to address:** Phase 2 (atomic pull reflection) and Phase 5 (durable daemon journal/crash recovery).

---

### Pitfall 10: Advancing checkpoints across parse, decrypt, validation, or partial bulk-write failure

**Confidence:** MEDIUM (LiveSync Fast Fetch ADR, official CouchDB bulk and changes-feed docs)

**What goes wrong:**
One row in a batch fails, but a top-level request succeeds and the checkpoint advances. That document is never retried. Parsing/decryption errors are mislabeled as malformed lines and skipped. A numeric/string comparison of sequence tokens skips or loops changes. After restart, the vault appears synchronized while data is missing.

**Why it happens:**
CouchDB `_bulk_docs` is non-atomic and returns per-document outcomes. The changes feed guarantees only current changes, may repeat rows after replica failover, and uses opaque sequence tokens that can be non-numeric JSON values. Stream termination, heartbeat, and finite-limit behavior varies across CouchDB versions.

**Warning signs:**

- Only HTTP status is checked for `_bulk_docs`.
- `parseInt(seq)`, lexical sequence comparison, or arithmetic on `update_seq` exists.
- Malformed/decryption rows are logged and skipped.
- Checkpoint writes occur before local batch durability.
- Integration tests cover only one CouchDB version or single-row batches.

**Concrete prevention:**

- Prefer PouchDB’s reviewed replicator for ordinary sync. If implementing a direct fetch path, copy the upstream ordered contract: parse/validate → decrypt/validate → buffer → persist → inspect every result → persist terminal `last_seq`.
- Keep sequence tokens opaque and return them only as `since` values.
- Do not advance past any failed predecessor. A row requiring no write still waits for preceding buffered writes.
- Retry only explicit transient transport classes from the last durable contiguous checkpoint; auth, protocol, decryption, and storage failures are terminal by default.
- Make replay idempotent, especially `new_edits:false` revision insertion.

**Recovery:**
Stop reflection, retain the last known-good checkpoint and all partially written documents, then resume from that checkpoint so accepted revisions replay idempotently. If an unsafe checkpoint already advanced, start a separate read-only full replication/audit into a new local database and compare all remote leaves; do not reset or rewrite the remote.

**Phase to address:** Phase 2 (pull/checkpoints) and Phase 6 (fault-injection integration tests).

---

### Pitfall 11: Resolving conflicts without exact ancestry or while the tree is changing

**Confidence:** MEDIUM (LiveSync/Commonlib conflict specifications and CouchDB revision-tree docs)

**What goes wrong:**
The resolver chooses the wrong merge base, merges unrelated generation-one files as if empty-based, deletes an unseen third leaf, applies a stale dialog/decision, or discards an unreadable revision because its chunks are missing. Concurrent clients can produce further leaves after a resolution, so “resolved once” is not final.

**Why it happens:**
Equal generation is not shared ancestry. Compaction may retain revision IDs but remove ancestor bodies. `open_revs=all` order is not winner order. Three or more leaves require repeated current-tree evaluation. A missing chunk is not evidence that a leaf is obsolete.

**Warning signs:**

- Two-way “newest mtime wins” is the default conflict policy.
- Merge base is selected by generation or first historical body.
- Binary differences auto-merge.
- A resolution deletes every `_conflicts` value captured before user review without rechecking.
- Missing/compacted body triggers branch deletion.

**Concrete prevention:**

- Enumerate all current leaves and find the nearest revision ID actually shared by the two histories; require its body for automatic three-way merge.
- Automatically collapse only byte-identical content. For v1 headless operation, preserve and report non-identical conflicts unless an exact conservative merge contract is deliberately implemented and tested.
- Before every mutation, re-read and verify that selected revisions remain current leaves.
- Process more than two leaves pairwise and reconstruct the next pair from the committed tree.
- Preserve generation-one conflicts with different bytes, binary differences, delete-vs-modify, missing bodies, and overlapping edits for manual resolution.

**Recovery:**
Export every readable leaf and available shared ancestor. Recreate lost merge work as a new child on a specifically chosen live branch and tombstone only an explicitly reviewed losing leaf. If a body is unavailable, search healthy replicas/backups for chunks; do not delete the leaf to make the conflict count look clean.

**Phase to address:** Phase 4 (conflict/provenance), with multi-client race tests in Phase 6.

---

### Pitfall 12: Shipping compaction, GC, rebuild, reset, or “helpful repair” code

**Confidence:** MEDIUM (LiveSync recovery/GC docs and official CouchDB/PouchDB compaction/purge docs)

**What goes wrong:**
An accidental command, reused upstream service, API flag, or over-privileged credential removes chunks, historical bodies, revision evidence, or an entire remote database. Even correctly implemented LiveSync GC intentionally trades historical readability for space and invokes remote compaction—directly contrary to this project’s core value.

**Why it happens:**
Commonlib and upstream LiveSync contain legitimate maintenance/rebuild capabilities. Reusing a large service hub can make them reachable transitively even when the CLI has no obvious command. Operators also interpret “sync tool” as backup/repair tooling.

**Warning signs:**

- Binary strings/help/API include rebuild, reset, compact, purge, clean, GC, destroy, overwrite-server, or remote-unlock actions.
- CouchDB admin credentials are required.
- A disk-usage warning offers automatic remediation.
- Code imports upstream Rebuilder/GC/administration modules.
- A test cleans up by deleting the configured database.

**Concrete prevention:**

- Use capability-oriented interfaces that expose only required read, local write, and replication operations.
- Add static/packaged-artifact tests for denylisted endpoint strings and method imports, then exercise a transport policy that rejects them.
- Require database-member credentials, not server/database-admin credentials.
- Report storage growth without offering remote remediation.
- Treat local PouchDB reset/fetch as a separate carefully reviewed local-only workflow; it must never call a remote reset and must first preserve unsynchronized local bytes.

**Recovery:**
Immediately stop all clients. If compaction ran, recover unavailable revision bodies/chunks from another un-compacted replica or backup. If GC/tombstones propagated, restore needed content as new revisions from preserved bytes. If purge/drop/rebuild occurred, recover from server backup or unaffected replicas before reconnecting stale clients.

**Phase to address:** Phase 0 (capability design), Phase 6 (binary/API denylist audit and least-privilege deployment test).

---

### Pitfall 13: Leaking or over-scoping CouchDB credentials and encryption secrets

**Confidence:** MEDIUM (official CouchDB security docs and current LiveSync remote-configuration docs)

**What goes wrong:**
Logs, process arguments, crash reports, setup URIs, exception URLs, or world-readable state files expose CouchDB passwords or E2EE passphrases. Admin credentials allow a software defect to bypass the operation denylist. Plain HTTP exposes Basic credentials and content metadata in transit.

**Why it happens:**
Credentials are often embedded in URLs, while error messages log the full URI. LiveSync connection strings can contain credentials and secrets. CouchDB members can read/write ordinary documents; admins can additionally alter security/design state and server admins can create/drop databases.

**Warning signs:**

- Password/passphrase accepted directly on the command line.
- URLs are logged before redaction or included in telemetry.
- The client works only with CouchDB server-admin credentials.
- Config/state files are group/world readable.
- TLS verification can be disabled silently.

**Concrete prevention:**

- Accept secrets from environment, protected local config, file descriptors, or secret managers; document process-environment exposure tradeoffs.
- Redact userinfo, `Authorization`, cookies/JWTs, passphrases, setup URIs, custom headers, encrypted payloads, and decrypted paths before constructing log messages.
- Use a dedicated CouchDB database member with no admin roles; verify the denylisted admin endpoints return 401/403 in deployment tests.
- Require HTTPS except explicit loopback development; validate certificates and redirect authority.
- Store state/config with owner-only permissions and never persist the E2EE passphrase in provenance/journal records.

**Recovery:**
Stop the client, preserve logs only under restricted access, rotate CouchDB credentials and any exposed JWT/custom-header secret, and assess whether the E2EE passphrase/setup URI was exposed. If the passphrase leaked, do not rotate or rebuild the remote automatically; plan a separate operator-controlled migration with complete backups.

**Phase to address:** Phase 1 (configuration/transport) and Phase 6 (secret scanning and deployment hardening).

---

### Pitfall 14: Letting integration tests or fixtures touch persistent user state

**Confidence:** MEDIUM (upstream isolated-test patterns plus the project’s explicit non-destructive constraint)

**What goes wrong:**
A test uses credentials from a developer config, points at a real database, exercises deletion/conflict cases against user data, or cleans up by dropping/compacting the database. Parallel tests reuse database/node IDs and create conflicts that escape the test.

**Why it happens:**
End-to-end replication tests need real CouchDB semantics, making it tempting to reuse an available server. Environment-variable fallbacks and default database names make accidental targeting easy. Cleanup code is usually considered harmless in tests.

**Warning signs:**

- Tests auto-load `.env`, application settings, home-directory config, or credential files.
- A default URL/database makes destructive tests runnable without an explicit opt-in.
- Database names are stable across runs.
- Test teardown calls DELETE database, purge, compact, or application rebuild.
- Two-vault tests share local PouchDB/state directories.

**Concrete prevention:**

- Unit tests use in-memory PouchDB and deterministic revision-tree fixtures.
- Real tests start a fresh ephemeral CouchDB container/network/volume from the test harness, create a random database externally, and destroy the whole isolated container afterward. The application itself never receives create/drop authority.
- Require an explicit test-only sentinel plus loopback/ephemeral-container identity; refuse public hosts, non-random database names, or missing run markers.
- Generate unique vault directories, local database suffixes, node IDs, credential users, and database names per test. Never read private credential files.
- Cover two and three clients, wrong passphrase, version/tweak mismatch, lock/cleaned state, conflicts, chunk delay/missing chunks, partial bulk results, restart/crash points, case collisions, rename interruption, watcher loss, and disk-full behavior.

**Recovery:**
If a test contacted a real remote, stop it immediately and preserve the request log. Back up the database and inspect `update_seq`, changed document IDs, and revision trees before reconnecting clients. Do not “clean up” test revisions with purge/drop; recover through reviewed revisions or backup restoration.

**Phase to address:** Phase 0 (test harness guard) and Phase 6 (real multi-client interoperability suite).

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Use PouchDB winner as file truth | Simple reads/writes | Wrong-branch edits and silent loss | Never |
| Use `mtime`/size to prove equality | Fast comparisons | Clock skew, rounding, stale stats, same-size edits | Only as a hint after byte/revision proof |
| Call upstream “ensure” helpers during inspect | Less adapter code | Hidden remote writes before authorization | Never |
| Store provenance only in memory | Easy prototype | Restart loses branch identity | Never for writes; read-only prototype only |
| In-place `O_TRUNC` reflection | Minimal filesystem code | Crash-created corruption uploaded as user edit | Never |
| Treat watcher stream as complete | Responsive daemon | Missed/coalesced events and false deletes | Never; watcher plus reconciliation only |
| Auto-resolve by newest timestamp | Fewer operator decisions | Deletes concurrent/clock-skewed work | Never by default |
| Ignore per-row `_bulk_docs` results | Cleaner batch code | Checkpoint skips failed documents | Never |
| Parse or compare CouchDB sequence tokens | Easier progress math | Invalid ordering and skipped changes | Never |
| Duplicate path/encryption algorithms | Avoid dependency | Namespace divergence after upstream changes | Never; pin reviewed upstream primitives |
| Ship maintenance modules but hide commands | Reuse broad service hub | Accidental/transitive destructive capability | Never |
| Share one test database | Faster tests | Cross-test contamination and user-data risk | Never |
| Log raw documents/URLs for debugging | Easy diagnosis | Secret/content leakage | Never; structured redacted diagnostics only |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| CouchDB `_changes` | Use `main_only`, assume every intermediate update appears, parse `seq` | Use the reviewed replicator or `style=all_docs` where implementing replication; keep opaque checkpoints; process idempotently |
| CouchDB `_bulk_docs` | Treat HTTP 201 as whole-batch success | Inspect every returned item and advance no checkpoint across a failed predecessor |
| CouchDB conflicts | Read only winner and `_conflicts` once | Enumerate/revalidate all current leaves and exact histories before each mutation |
| CouchDB `_local` docs | Expect milestone/sync parameters to replicate locally | Read them explicitly from the remote during the guarded compatibility lease |
| PouchDB `remove()` | Use for ordinary filesystem deletion | Write LiveSync `deleted: true` on the proven Metadata branch; reserve tombstones for reviewed branch resolution |
| PouchDB compaction | Assume API-visible behavior means history is still readable | Disable auto-compaction and never call compact; missing bodies disable auto-merge |
| LiveSync Commonlib | Treat pre-1.0 internals as stable SDK | Pin exact release/commit, import narrow reviewed entry points, rerun golden interoperability tests on upgrades |
| Chokidar | Assume `awaitWriteFinish` proves completeness | Re-read stable current bytes; reconcile periodically; make watcher loss fatal/unhealthy |
| Filesystem rename | Delete source on unlink event | Store and verify target first; preserve source when relation/order is uncertain |
| Filesystem case rules | Follow host filesystem only | Follow negotiated LiveSync identity policy and block collisions the host can represent differently |
| Docker/NFS/SMB mounts | Assume local watcher semantics | Detect unsupported/unreliable watcher environments, use polling/reconciliation, and surface degraded mode |
| HTTP redirects/proxies | Forward credentials automatically | Revalidate scheme/authority/path per redirect; never forward secrets cross-authority |

## Performance Traps That Become Correctness Bugs

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Materialize before all chunks arrive | Intermittent zero/truncated files | Identifier-scoped chunk waits plus terminal verification | Slow links, on-demand chunk mode, conflicts |
| Unbounded all-doc/all-revision loading | OOM or daemon death mid-operation | Paginate/stream while retaining exact tree semantics | Large vaults or long conflict history |
| Too-small write-stability delay | Partial uploads | Stable-read loop; watcher is only a hint | Large files, paused copies, network storage |
| Too-large global debounce | Lost rapid edits | Per-identity coalescing with post-read validation | Editor autosave and build outputs |
| Global serialization | Backlog causes stale decisions | Serialize per document identity; revalidate before commit | Large event bursts |
| Excessively parallel chunk requests | 429/timeouts mistaken as missing | Bounded concurrency and explicit transient retry | High-chunk files or constrained CouchDB |
| Repeated full history body fetch | Remote load and timeouts | Cache immutable exact revisions locally without treating absence as deletion | Deep trees; compacted histories |
| Checkpoint after every observed event but before disk sync | Fast apparent progress, restart gaps | Batch durability then checkpoint | Crash/power loss at any scale |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Running as root over the vault | Symlink/path bug affects host files | Dedicated OS user, rooted no-symlink storage adapter, strict path validation |
| Following symlinks inside vault | Remote path escapes vault or reads secrets | Reject symlink components at open time; use no-follow flags and recheck race boundaries |
| Trusting remote path fields | Traversal, reserved-file overwrite | Decrypt then validate normalized vault-relative path before staging |
| World-readable temp/state/config | Content, credentials, provenance leak | Owner-only mode, same-filesystem secure temp, restrictive umask |
| Raw exception/document logging | Credentials and note content leak | Structured stage/status/revision diagnostics with redaction |
| Admin CouchDB credential | Defect can drop/purge/compact/change security | Database-member-only credential plus transport denylist |
| Silent TLS downgrade or redirect | Credential theft/MITM | HTTPS, certificate validation, authority-pinned redirect policy |

## “Looks Done But Isn’t” Checklist

- [ ] **Read-only bootstrap:** Prove zero change to remote `update_seq` and marker revisions using read-only credentials.
- [ ] **Version handling:** Test the exact typo-preserved version ID, future version, missing version on non-empty DB, and wrong document type.
- [ ] **Remote-only state:** Verify sync parameters and milestone are fetched directly and their unavailable/404 states are distinguished.
- [ ] **Encryption:** Test V1, V2, wrong passphrase, wrong seed, encrypted Metadata properties, path obfuscation, text, and binary.
- [ ] **Path identity:** Test leading underscore, case-insensitive collisions, case-only file rename, cross-path rename interruption, and unsupported folder case rename.
- [ ] **Revision provenance:** Test winner differs from displayed leaf, missing provenance with zero/one/multiple byte matches, stale base 409, and restart.
- [ ] **Logical deletion:** Verify ordinary delete writes `deleted: true` on the proven branch and never purge/remote DELETE.
- [ ] **Conflicts:** Test two/three leaves, unequal branch length, missing common-ancestor body, delete-vs-edit, binary conflict, and concurrent resolution.
- [ ] **Chunks:** Verify chunks-before-Metadata publication, delayed arrival, explicit missing versus transport failure, shared chunk, and unreadable conflict retention.
- [ ] **Bulk/checkpoint:** Inject one failed row in a successful HTTP batch and prove the checkpoint does not advance.
- [ ] **Filesystem writes:** Crash/disk-full at every stage and prove destination or recovery copy remains complete and no partial bytes upload.
- [ ] **Watcher:** Test atomic editor saves, same-size edits, long paused writes, rename event permutations, watcher failure, downtime, and reconciliation.
- [ ] **Loop suppression:** Prove an immediate user edit after remote reflection is not swallowed.
- [ ] **Denylist:** Verify every destructive endpoint/method and imported maintenance capability is rejected in unit and packaged-binary tests.
- [ ] **Credentials:** Verify logs, errors, process listing guidance, config permissions, redirects, and crash reports reveal no secrets.
- [ ] **Isolation:** Prove integration tests refuse non-ephemeral/non-loopback targets and cannot read application/private credential files.
- [ ] **Mixed clients:** Run current Obsidian LiveSync plus two headless instances through edits, deletes, renames, conflicts, restart, and chunk delay without remote maintenance.

## Recovery Principles

When any invariant fails:

1. Stop this client’s watcher and push replication; if practical pause other clients.
2. Preserve the current vault, local PouchDB/state directory, logs, and a server-side backup before attempting repair.
3. Enumerate current revision leaves and exact available histories read-only. Copy every readable file version separately.
4. Recover missing chunks/bodies from healthy replicas or backups before resolving anything.
5. Prefer additive recovery: write recovered bytes as a new child of an explicitly selected live revision.
6. Do not purge, compact, rebuild, reset, expire tombstones, or garbage-collect to make diagnostics cleaner.
7. Re-enable writes only after compatibility and provenance are re-established and a dry-run reports no ambiguity.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Accidental bootstrap marker write | HIGH | Stop clients, back up, compare exact marker revisions, restore through reviewed revision/backup; do not delete markers blindly |
| Wrong-branch write | HIGH | Export all leaves, identify intended branch manually, add recovered successor, retain unproven leaves |
| Mistaken `_deleted` | MEDIUM/HIGH | Read available prior revision/replica bytes and restore as a new live revision; preserve tombstone history |
| Purge/drop/rebuild | CRITICAL | Restore server backup or unaffected replica before stale clients reconnect |
| Missing chunks | MEDIUM/HIGH | Fetch from healthy replica/backup or recreate from exact vault bytes under negotiated settings; keep Metadata leaf |
| Wrong encryption/path settings | HIGH | Restore known-good settings/seed, retry read-only decoding, preserve parallel namespaces |
| Case/path collision | MEDIUM/HIGH | Pause clients, copy variants, choose names manually, perform target-first exact-revision changes |
| Partial local file | MEDIUM | Quarantine partial bytes; restore from staged copy, exact remote revision/chunks, another vault, or backup |
| Unsafe checkpoint | HIGH | Build a new local read-only replica/audit from an earlier durable cursor and compare all leaves |
| Test touched real remote | HIGH | Stop test, preserve request log, back up and inspect changed revisions; never purge test artifacts |

## Pitfall-to-Phase Mapping

Proposed phase names are intentionally dependency-ordered for roadmap creation.

| Pitfall | Prevention Phase | Verification Gate |
|---------|------------------|-------------------|
| Destructive capability leakage | **Phase 0 — Safety kernel and compatibility fixtures** | Interfaces and transport reject denylist; binary has no maintenance command/import; member credential cannot administer |
| Winner/provenance confusion | **Phase 0**, completed in **Phase 4 — Conflict and provenance safety** | Exact revision-tree fixtures; edits/deletes extend displayed non-winner branch |
| Path/case identity errors | **Phase 0**, exercised in **Phase 2/3** | Golden `path2id` fixtures and collision quarantine across Linux/case-insensitive simulation |
| Test contamination | **Phase 0** | Tests refuse non-ephemeral target and use unique node/vault/database identities |
| Bootstrap mutation | **Phase 1 — Read-only remote discovery and negotiation** | Read-only credential succeeds; remote `update_seq` unchanged; no marker creation |
| Version/tweak/lock mismatch | **Phase 1** | Future/missing/corrupt/locked/cleaned/mismatched states all block writes with diagnostics |
| Encryption/path obfuscation mismatch | **Phase 1**, decoded in **Phase 2** | V1/V2/seed/path fixtures and wrong-secret fail-closed tests |
| Chunk arrival/reconstruction | **Phase 2 — Pull-only materialization and atomic reflection** | Delayed/missing chunk tests never create partial files or delete revisions |
| Partial filesystem writes | **Phase 2** | Crash and disk-full injection at each staging/replace/state step |
| Checkpoint/bulk partial failure | **Phase 2** | Per-row failure retains prior contiguous checkpoint and retries idempotently |
| Logical deletion confusion | **Phase 3 — Provenance-aware bidirectional writes** | Local delete creates LiveSync logical-deletion child; no direct remote DELETE/purge |
| Rename ordering | **Phase 3** | Target-first cross-path crash leaves duplicate; case-only rename stays in tree |
| Conflict ancestry/stale resolution | **Phase 4** | Two/three-leaf, compacted-base, unreadable-leaf, and concurrent-client tests preserve all unproven data |
| Watcher races/echo loops | **Phase 5 — Daemon, journal, and crash recovery** | Event permutation, downtime, overflow/error, atomic save, and immediate post-reflection edit tests |
| Credential and release drift | **Phase 6 — Mixed-client hardening and release gate** | Secret scan, least privilege, redirect tests, current Obsidian mixed-client suite, exact dependency audit |

**Ordering rationale:** no later phase should weaken the earlier gates. Push depends on safe pull; deletion and rename depend on durable provenance; daemon mode depends on correct one-shot operations and crash-atomic state; conflict automation is isolated until all-leaf behavior is proven; mixed-client release testing is repeated whenever the pinned LiveSync/Commonlib contract changes.

## Phase-Specific Research Flags

- **Phase 1:** Re-audit the exact pinned Commonlib release’s negotiation helpers. Current helpers are not guaranteed read-only, and package boundaries are still migrating.
- **Phase 2:** Decide whether to use ordinary PouchDB replication exclusively or adopt upstream Fast Fetch. A custom changes-feed path requires a separate detailed protocol review.
- **Phase 2:** Validate crash-atomic replace semantics on every supported filesystem/OS; Node’s high-level APIs do not by themselves promise the required durability sequence.
- **Phase 3:** Specify exactly which upstream operation creates ordinary logical deletion and ensure compatibility settings cannot switch it to `_deleted`/metadata expiry.
- **Phase 4:** Keep non-identical automatic conflict resolution out of scope unless a separate spec reproduces current exact-ancestry behavior.
- **Phase 5:** Determine supported watcher environments (local Linux filesystems versus NFS/SMB/container overlays) and define an explicit degraded polling mode.
- **Phase 6:** Re-run source audit and mixed-client corpus against the then-current Obsidian LiveSync release; current evidence is a moving pre-1.0 Commonlib boundary.

## What Might Still Be Missed

- The reviewed upstream commits are current on 2026-09-03, but Commonlib explicitly describes its package/API migration as in progress. Exact imports and host lifecycle boundaries may change before implementation.
- This research did not connect to any private database or inspect private credentials, as required. Real-world legacy databases may contain older document shapes not represented by current tests/docs; unknown shapes must remain read-only and preserved.
- CouchDB deployments older than current stable can differ in finite changes-feed behavior. The upstream Fast Fetch ADR records differences between CouchDB 3.2 and 3.5; supported server versions need an explicit matrix.
- Filesystem crash durability differs by OS/filesystem. The roadmap needs platform-specific fault tests rather than assuming POSIX behavior everywhere.
- Current upstream binary-conflict behavior has compatibility exceptions based on modification time. This project should preserve/report binary conflicts unless exact mixed-client behavior is deliberately accepted and tested.

## Sources

All source-based claims are tagged **MEDIUM** because the GSD confidence classifier returns MEDIUM for verified web evidence. Source code was inspected at the pinned commits below; official manuals were cross-checked for protocol behavior.

### Self-hosted LiveSync and Commonlib (primary)

- **MEDIUM:** [LiveSync data structures](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/datastructure.md) — document types, version/sync/milestone IDs, Metadata, chunks, deletion, path identity.
- **MEDIUM:** [Conflict resolution and revision provenance specification](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/specs_conflict_resolution.md) — displayed revision, all-leaf handling, safe fallbacks, rename/deletion semantics.
- **MEDIUM:** [Metadata document ID validation and repair](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/design_docs/metadata_document_id_validation_and_repair.md) — identity quarantine and target-first repair.
- **MEDIUM:** [Chunk retrieval and waiting](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/design_docs/chunk_retrieval_and_waiting.md) — chunks-before-Metadata invariant and delayed availability.
- **MEDIUM:** [Garbage Collection V3 specification](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/specs_garbage_collection.md) and [recovery guide](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/recovery.md) — why GC/compaction/rebuild trade recoverability for maintenance.
- **MEDIUM:** [Fast Fetch persistence and completion ADR](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/adr/2026_08_fast_fetch_persistence_and_completion.md) — ordered persistence, opaque checkpoints, partial bulk results, CouchDB version behavior.
- **MEDIUM:** [Release notes and database compatibility ADR](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/adr/2026_07_release_notes_and_database_compatibility.md) — independent versions, future-schema blocking, bootstrap ordering.
- **MEDIUM:** [Commonlib negotiation implementation](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/pouchdb/negotiation.ts), [sync-parameter handler](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/replication/SyncParamsHandler.ts), and [remote compatibility function](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/pouchdb/LiveSyncDBFunctions.ts) — mutating “check” hazards.
- **MEDIUM:** [Commonlib encryption transform](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/pouchdb/encryption.ts), [tweak classification](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/common/models/tweak.definition.ts), and [path service](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/services/base/PathService.ts) — encryption/path/hash compatibility.
- **MEDIUM:** [Commonlib local database lifecycle](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/docs/database-lifecycle.md) and [offline scanner contract](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/docs/offline-scanner.md) — readiness, stored-event revalidation, scanner ambiguity.
- **MEDIUM:** [Current upstream Node storage adapter](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/platform/node/storage.ts) and [LiveSync CLI watcher adapter](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/src/apps/cli/managers/CLIStorageEventManagerAdapter.ts) — current filesystem boundaries and race exposure.

### CouchDB, PouchDB, Node, and watcher documentation (primary)

- **MEDIUM:** [Apache CouchDB replication protocol](https://docs.couchdb.org/en/stable/replication/protocol.html) and [replication/conflict model](https://docs.couchdb.org/en/stable/replication/conflicts.html) — all leaves, ancestry, deterministic winner, replication semantics.
- **MEDIUM:** [Apache CouchDB `_changes`](https://docs.couchdb.org/en/stable/api/database/changes.html) — opaque/non-integer sequence values, repeats, `style=all_docs`, most-recent-change guarantee.
- **MEDIUM:** [Apache CouchDB `_bulk_docs`](https://docs.couchdb.org/en/stable/api/database/bulk-api.html) — non-atomic batch writes and per-document outcomes.
- **MEDIUM:** [Apache CouchDB clustered purge](https://docs.couchdb.org/en/stable/cluster/purging.html), [compaction](https://docs.couchdb.org/en/stable/maintenance/compaction.html), and [document design considerations](https://docs.couchdb.org/en/stable/best-practices/documents.html) — destructive/history-loss boundaries.
- **MEDIUM:** [Apache CouchDB security](https://docs.couchdb.org/en/stable/intro/security.html) — member/admin authority and transport concerns.
- **MEDIUM:** [PouchDB conflicts](https://pouchdb.com/guides/conflicts.html), [updating/deleting](https://pouchdb.com/guides/updating-deleting.html), [replication](https://pouchdb.com/guides/replication.html), and [compaction/destruction](https://pouchdb.com/guides/compact-and-destroy.html) — revision trees, 409s, tombstones, replication, unavailable historical bodies.
- **MEDIUM:** [Node.js filesystem API](https://nodejs.org/api/fs.html) — unsynchronized concurrent operations and watcher portability/caveats.
- **MEDIUM:** [Chokidar documentation](https://github.com/paulmillr/chokidar) — atomic-write normalization and size-stability-based `awaitWriteFinish` behavior.

---
*Pitfalls research for: headless Self-hosted LiveSync-compatible file synchronization*
*No private credential file or private database was inspected or contacted.*
