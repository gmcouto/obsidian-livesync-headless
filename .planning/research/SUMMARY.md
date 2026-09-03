# Project Research Summary

**Project:** obsidian-livesync-headless
**Domain:** Headless Self-hosted LiveSync-compatible vault-file synchronizer
**Researched:** 2026-09-03
**Confidence:** MEDIUM

## Executive Summary

`obsidian-livesync-headless` is a preservation-first CLI that synchronizes normal vault files with an existing CouchDB-backed Self-hosted LiveSync database. It is not an Obsidian replacement, database administrator, backup product, or generic file mirror. Expert implementation requires treating LiveSync as an encrypted, chunked revision-tree protocol: the existing database and current Obsidian LiveSync clients are authoritative, exact revision ancestry outranks timestamps, and unknown or ambiguous states must stop writes while preserving evidence.

Build a single-process TypeScript modular monolith on Node.js 24 LTS. Pin the immutable compatibility tuple—Self-hosted LiveSync `1.0.23` at commit `28e76701c41cbd25fd3527c45bb0e39c646fe4e8`, `@vrtmrz/livesync-commonlib@0.1.21`, its published integrity, and the upstream PouchDB UUID overrides—and isolate Commonlib behind a project-owned adapter. Use Commonlib's direct HTTP/PouchDB composition for protocol-sensitive IDs, encryption, compression, chunks, settings, and revision operations; use `node:sqlite` for durable admission, opaque checkpoints, exact displayed-revision provenance, and the operation journal. This resolves the research reports' principal contradiction: v1 should not add Architecture's local PouchDB/LevelDB replica because the stack research proved the direct path can bundle into a one-file SEA while LevelDB adds native packaging and duplicate-state risk. Preserve Architecture's safety gates and revision-aware flow, and revisit a local protocol replica only if Phase 2 characterization proves the pinned direct API cannot provide complete all-leaf reads or resumable enumeration.

The roadmap must advance through vertical end-to-end slices. First contact is structurally read-only: load secret-safe configuration, inspect and pull remote-only configuration, prove decryption/path/chunk compatibility, and demonstrate that the remote `update_seq` and marker revisions are unchanged. Only a verified pull/materialization baseline and explicit, scope-bound write grant may unlock bidirectional writes. The dominant risks are hidden mutation by upstream “check” helpers, wrong-branch edits, confusion between LiveSync `deleted: true` and CouchDB tombstones/purge, partial chunk/file writes, watcher gaps, and accidental exposure of destructive or privileged database operations. Capability-scoped ports, exact provenance, chunks-before-Metadata ordering, atomic recoverable reflection, least-privilege credentials, an HTTP denylist, and mixed-client fault tests are release requirements.

## Key Findings

### Recommended Stack

The canonical version source is the immutable LiveSync `1.0.23` release, not `main`, npm `latest`, or a moving Commonlib branch. Findings in FEATURES, ARCHITECTURE, and PITFALLS that came from newer `main` commits are design evidence only until reproduced against the pinned release/package and fixtures. Commonlib is pre-1.0, so exact pins, characterization tests, and a dedicated compatibility-upgrade gate are part of the product contract.

**Core technologies:**

- **Node.js `24.20.0` LTS / npm `11.19.0`:** runtime, built-in fetch/crypto/SQLite, and deterministic lockfile-v3 installs with `npm ci`.
- **TypeScript `5.9.3`:** strict application code aligned with the pinned upstream compiler; ESM source, `NodeNext` resolution, no project emit.
- **`@vrtmrz/livesync-commonlib@0.1.21` exact:** owns LiveSync path/document identity, encryption, compression, chunking, remote settings, and revision-aware HTTP behavior. Pin integrity to `sha512-AGuZ3eqBP37HJXEkTSpJ5M5bvTx2lYNq+6Q5NuCPZeGdbv7g6cujGvccVR5ozGfKdHGSyFZND5x1oFS9crRhUg==`.
- **PouchDB modular packages `9.0.0`, transitively through Commonlib:** do not install a second PouchDB or umbrella package; mirror upstream overrides setting `uuid` to `11.1.1` for `pouchdb-core` and `pouchdb-utils`.
- **`node:sqlite` in Node `24.20.0` (SQLite `3.53.4`):** durable local admission, checkpoint, provenance, schema, intent, quarantine index, and operation-journal state behind a repository boundary.
- **Chokidar `5.0.0`:** daemon invalidation hints only; startup, periodic, and post-error scans remain authoritative.
- **YAML `2.9.0` + Zod `4.5.4`:** strict merged configuration validation before state or network access; secrets remain runtime-supplied and redacted.
- **esbuild `0.28.2` + Node SEA + postject `1.0.0-alpha.6`:** one executable per supported OS/architecture. The Linux x64 import/bundle pipeline was smoke-tested; all release targets still require packaged interoperability tests.
- **Vitest `4.1.11`, coverage `4.1.11`, and `@testcontainers/couchdb@12.1.0`:** contract, fault-injection, and ephemeral CouchDB tests. Target CouchDB `3.5.2` using official image `3.5.2.1`, pinned by digest per architecture.

Do not add Pino to the one-file executable, rely on Commonlib's incomplete high-level lifecycle, use Chokidar as a change log, or place state inside the vault. The released bundle must contain no native `.node` addon, out-of-scope provider, unresolved runtime file, second PouchDB, or database-maintenance capability.

### Expected Features

**Must have (table stakes):**

- Read-only first-contact inspection of an already initialized database, including identity, version, milestone/lock state, sync parameters/security seed, preferred tweaks, supported document shapes, and a stable compatibility report.
- Explicit local approval and a durable write grant bound to remote fingerprint, vault root, negotiated-settings hash, Commonlib version, and verified bootstrap generation.
- Complete supported LiveSync file codec for text/binary metadata, current and required legacy reads, E2EE V1/V2 compatibility, path obfuscation, case policy, compression, chunk creation/assembly, and strict path/document-ID validation.
- Finite pull-only dry-run and safe materialization with all current leaves considered, bounded missing-chunk handling, byte verification, exact revision provenance, resumability, and non-zero degraded/blocking outcomes.
- Idempotent, pull-first bidirectional one-shot convergence with chunks written before Metadata, every write result checked, provenance-correct branch extension, target-first rename, and final reconciliation.
- LiveSync logical file deletion using Metadata `deleted: true` on the proven branch. Existing CouchDB `_deleted` tombstones are protocol artifacts; purge and direct remote deletion are never ordinary file deletion.
- Conservative conflict preservation: byte-identical leaves may collapse, but non-identical, binary, delete-vs-modify, missing-body, unrelated, or stale/concurrent cases remain visible and unresolved unless exact ancestry proves a safe operation.
- Recoverable local reflection via same-filesystem staging, flush/close, atomic replace, read-back verification, quarantine/trash, and state commit only after durability.
- Daemon mode built on the one-shot engine: finite startup catch-up, serialized per-identity work, `_changes`/watch hints, opaque checkpoints, retries/backoff, periodic scans, clean shutdown, and degraded read-only behavior.
- Structured JSON Lines diagnostics, stable exit/health states, comprehensive redaction, least-privilege database-member credentials, and mixed-client conformance tests against pinned official fixtures.

**Should have after the safety contract is proven (v1.x):**

- Explainable machine-readable action plans showing the evidence that permitted or blocked each operation.
- Read-only revision/chunk forensics and export to a separate recovery path.
- Guided restoration from local quarantine or an explicitly selected available revision, with fresh revision rechecks.
- Compatibility-drift reports and a local-only daemon health/status file or endpoint.
- Equivalent checkpointed polling when proxies or filesystems make live feeds/watchers unreliable.

**Defer or never add:**

- Defer selective synchronization and replay/corpus tooling until an ownership/deletion model and sanitized fixtures exist.
- Never add Obsidian UI, plugin lifecycle management, Customisation Sync, plugin/theme/snippet semantics, Object Storage, P2P, arbitrary asymmetric filters, automatic newest-time/winner conflict policies, or claims that synchronization is backup.
- Never add database creation, drop, reset, rebuild, overwrite, purge, compaction, garbage collection, retention/security changes, design/index management, remote unlock/milestone administration, or server-managed replication.

### Architecture Approach

Use a single-process modular monolith with ports and adapters. A functional reconciliation core returns typed `NoOp`, `Reflect`, `ExtendBranch`, `LogicalDelete`, `Preserve`, or `Block` decisions from current bytes, all live leaves, exact provenance, and policy. Side effects require opaque capabilities (`RemoteRead`, `VaultReflect`, `LocalRevisionWrite`, `RemotePush`) issued only by a safety authority. The direct Commonlib/HTTP adapter supplies protocol operations; SQLite supplies transactional process truth; the vault is materialized user truth but never proof of ancestry by itself. Read-only bootstrap must use a method/endpoint allowlist and must not call upstream helpers that can initialize or update remote records.

**Major components:**

1. **CLI and coordinators** — parse `inspect`, pull/dry-run, one-shot, daemon, status, and write-arming commands; order startup, recovery, convergence, and shutdown without protocol policy in the presentation layer.
2. **Safety policy and capability authority** — enforce state transitions, bind/revoke scoped grants, and make destructive endpoints absent at both type and transport layers.
3. **Read-only admission inspector and transport policy** — read existing CouchDB/config records with `GET`/`HEAD`, validate redirects and database identity, deny all mutation during first contact, and prove no remote change.
4. **Pinned LiveSync compatibility adapter and remote gateway** — isolate every Commonlib import, enumerate all relevant leaves, decode/encode exact supported formats, fetch/verify chunks, and surface typed incompatibility/corruption/conflict results.
5. **SQLite state store and operation journal** — transactionally own admission snapshots, opaque checkpoints, exact displayed revisions, intents, quarantine records, schema migrations, and crash-recovery phases; never store credentials or payload plaintext.
6. **Reconciliation engine** — central deterministic policy used by scans, one-shot, daemon events, and recovery; no timestamp-wins, deterministic-winner, or exception-only control flow.
7. **Rooted filesystem adapters** — scan eligible files, reject symlinks/traversal/case collisions, stage and atomically reflect verified bytes, preserve displaced content, and keep all state/temp patterns out of the vault namespace.
8. **Daemon supervisor and release boundary** — turn watcher/feed events into durable revalidation requests, manage backoff/health/shutdown, and ship/test one SEA artifact per target platform.

### Critical Pitfalls

1. **Read-only inspection that secretly writes** — implement a separate pure probe, require read-only credentials in acceptance tests, persist a compatibility snapshot, and prove `update_seq` and marker revisions are unchanged.
2. **Wrong-branch writes from winner/mtime assumptions** — persist the exact revision that produced each visible file, re-read all leaves before mutation, extend only that live base, and leave ambiguous provenance unresolved.
3. **Conflating logical deletion, tombstones, and purge** — ordinary deletion is LiveSync Metadata `deleted: true`; never use generic remote DELETE, `_deleted`, expiry, cleanup, or purge for a user unlink.
4. **Publishing or reflecting incomplete content** — validate/decrypt every chunk and complete bytes before file visibility; write and verify chunks before Metadata; treat missing chunks and per-row write failures as blockers without checkpoint advancement.
5. **Non-atomic local state and lossy event handling** — stage/flush/rename/read-back before provenance commit, journal every side effect, make replays idempotent, and treat watcher/feed events as hints followed by authoritative re-reads and scans.
6. **Destructive capability or secret leakage** — omit maintenance APIs/imports, enforce a canonicalized transport denylist and least privilege, reject credential forwarding across redirects, and scan logs/state/binaries for credentials and forbidden operations.

## Implications for Roadmap

The roadmap should use six vertical slices. Each slice exercises the real CLI-to-state-to-protocol/filesystem path and ends with user-visible evidence; no phase should be a disconnected horizontal subsystem build.

### Phase 1: Guarded Read-Only Admission

**Rationale:** Compatibility and authority must be established before any local or remote mutation. This is the first live integration slice and is intentionally fail-closed.

**Delivers:** A runnable `inspect` command with strict YAML/env/CLI configuration, secret provider/redaction, pinned Commonlib adapter, existing-database probe, remote identity/configuration report, SQLite admission record, transport denylist, and ephemeral CouchDB acceptance harness. It pulls remote-only configuration and proves compatibility with syncinfo plus representative records; no vault write, local revision write, registration, checkpoint write to remote, or push path exists.

**Addresses:** Read-only first contact, compatibility report, explicit future write arming foundation, actionable diagnostics.

**Avoids:** Hidden mutating helpers, wrong-database initialization, future/tweak/seed mismatch, privileged credentials, private database/test contamination, and all destructive operations.

### Phase 2: Pull-Only Verified Materialization

**Rationale:** The first complete synchronization path must prove protocol decoding and filesystem safety before writes are considered.

**Delivers:** `sync --pull-only --dry-run` plus apply-to-empty/dedicated-vault mode; direct enumeration of relevant Metadata and every live leaf; opaque finite checkpointing; encrypted/obfuscated text and binary decode; bounded exact-ID chunk retrieval; case/path checks; staged atomic materialization; exact revision provenance; final byte-for-byte verification; idempotent rerun and blocker report. Architecture's “local replica” requirement is satisfied as a durable SQLite snapshot/manifest plus staged verified files, not native LevelDB.

**Addresses:** Complete codec, finite pull, enforceable dry-run, recovery-safe local reflection, stable target policy, exact provenance.

**Avoids:** Metadata-before-chunk truncation, wrong settings/path derivation, unsafe paths, deterministic-winner assumptions, checkpoint gaps, and remote mutation.

### Phase 3: Recoverable and Repeatable Pull

**Rationale:** Bidirectional writes are unsafe until crashes, disk failures, remote movement, and repeated runs cannot turn an incomplete reflection into a local edit.

**Delivers:** Deterministic operation IDs and journal transitions, quarantine/trash index, unclean-start recovery, state migrations/checksums, full-scan reconciliation, admission refresh when remote markers move, bounded concurrency/backpressure, and fault injection at every staging/install/provenance/checkpoint boundary.

**Addresses:** Resumability, idempotence, durable provenance, recovery-safe replacement, explicit degraded states.

**Avoids:** Partial files, corrupt state interpreted as empty, unsafe checkpoint advancement, destructive retry, duplicate operations, and loss of evidence.

### Phase 4: Explicitly Armed Bidirectional One-Shot

**Rationale:** Remote writes may begin only after a verified baseline and recovery model exist; one-shot convergence is the semantic foundation for daemon mode.

**Delivers:** A separate write-arming command bound to fresh admission and bootstrap generation; local scans; exact-base Commonlib writes; chunks-before-Metadata ordering; per-result validation; guarded push; pull/reconcile/push/final-pull convergence; branch-correct edits; LiveSync logical deletion; case-only and target-first cross-path rename; conservative all-leaf preservation; mixed-client round trips in ephemeral CouchDB.

**Addresses:** Bidirectional one-shot, logical deletion, rename, conflict preservation, explicit write approval, mixed-client conformance.

**Avoids:** First-contact push, stale/winner-based updates, `_deleted`/purge confusion, rename data loss, partial bulk success, and silent conflicts.

### Phase 5: Continuous Convergence Daemon

**Rationale:** Continuous operation amplifies every ambiguity, so it must reuse the proven one-shot reconciliation and gates.

**Delivers:** Ordered catch-up-before-watch startup; remote feed and Chokidar invalidation scheduling; durable coalesced intents; per-identity serialization; content/provenance loop suppression; reconnect/backoff; startup/periodic/post-error scans; degraded read-only mode; local health/status; signal-driven drain and restart recovery.

**Addresses:** Daemon startup catch-up, durable continuous operation, watcher/poll equivalence, health semantics.

**Avoids:** Watcher-as-log errors, partial-read uploads, echo loops, stale daemon config, parallel ownership of one vault, and unbounded queues.

### Phase 6: Packaged Mixed-Client Release Gate

**Rationale:** Source-level correctness is insufficient; the exact executable and pinned ecosystem must pass compatibility, least-privilege, and platform tests.

**Delivers:** Node SEA artifacts for each promised OS/architecture; checksum/provenance publication; packaged fixture, encrypted, crash, reconnect, and mixed-client suites; CouchDB image digest pinning; bundle/metafile and forbidden-endpoint/import audits; log/state secret scans; migration/rollback tests; exact compatibility tuple validation and documented upgrade gate.

**Addresses:** Single executable distribution, conformance gate, operational hardening, compatibility drift visibility.

**Avoids:** Native/runtime bundle surprises, out-of-scope providers, maintenance code leakage, secret disclosure, version drift, and tests against persistent user state.

### Phase Ordering Rationale

- Remote admission precedes codec use; codec proof precedes materialization; durable materialization/provenance precedes any interpretation of local absence or change.
- One-shot pull is hardened against crashes before remote writes. Bidirectional one-shot is proven before daemon scheduling so there is one reconciliation model rather than two.
- Conflicts are preserved from the first pull and write slice. Non-identical automatic merge is not required for v1 and should remain deferred unless separately specified and proven from exact shared ancestry.
- Packaging feasibility is smoke-checked in Phase 1, but release hardening waits until behavior stabilizes. If the direct Commonlib path fails Phase 2's all-leaf/resume requirements, stop and research a protocol cache alternative before adopting local LevelDB.

### Research Flags

Phases likely needing `$gsd-plan-phase --research-phase <N>`:

- **Phase 1:** Re-audit the exact `0.1.21` package's negotiation call graph so the read-only probe cannot transitively create/update version, milestone, sync-parameter, tweak, node, design, or checkpoint records.
- **Phase 2:** Characterize `enumerateAllNormalDocs()`, exact-leaf access, remote watch/changes behavior, delayed chunks, and durable opaque checkpoint semantics against CouchDB `3.5.2`; decide whether the direct path is sufficient before coding around it.
- **Phase 2:** Validate atomic replace/directory-sync behavior on every initially supported filesystem/OS.
- **Phase 4:** Verify the exact pinned Commonlib operation for LiveSync Metadata `deleted: true`, exact-base writes, case-only rename, and every `_bulk_docs`/CAS outcome with official fixtures.
- **Phase 5:** Define supported local/container/NFS/SMB watcher environments and the degraded polling contract through platform tests.
- **Phase 6:** Re-audit the then-current immutable LiveSync release, SEA targets/signing, CouchDB version matrix, and mixed-client fixture corpus before publishing compatibility claims.

Phases with established patterns that can skip separate research:

- **Phase 3:** SQLite journaling, deterministic idempotency, quarantine, state migrations, and crash-injection patterns are well documented; planning should focus on project invariants and test matrices.
- **Phase 5 lifecycle portions:** cancellation, bounded backoff, signal handling, and health reporting are standard once watcher/environment decisions are settled.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Exact versions, lock integrity, official runtime metadata, and Linux x64 SEA imports were checked; complete synchronization and every target platform remain unproven. |
| Features | MEDIUM | Safety requirements agree across current upstream source and official CouchDB/PouchDB behavior; real legacy databases may contain unrepresented shapes. |
| Architecture | MEDIUM | Gates, exact provenance, typed reconciliation, journaling, and atomic reflection are strongly supported; the reports conflict on local LevelDB versus direct HTTP, resolved here in favor of the smoke-tested SEA-compatible direct path pending Phase 2 proof. |
| Pitfalls | MEDIUM | Risks are repeatedly supported by LiveSync/Commonlib source and official protocol docs, but recovery behavior and filesystem durability require fault tests. |

**Overall confidence:** MEDIUM

### Gaps to Address

- **Direct API completeness:** Prove all-leaf enumeration, exact historical reads, watch cancellation, close/error behavior, and resumable finite traversal in pinned Commonlib `0.1.21`. Do not silently fall back to a second PouchDB stack.
- **Compatibility corpus:** Generate immutable `1.0.23` fixtures for V1/V2 encryption, obfuscated paths, current/legacy text and binary records, conflicts, logical deletions, delayed/missing chunks, and renames without reading private data.
- **Remote identity:** Define a stable fingerprint through proxies and database restore/replacement scenarios; bind write grants to it and relevant compatibility-record revisions.
- **Server support:** Establish the minimum supported CouchDB 3.x matrix experimentally; do not infer broad support from generic PouchDB claims.
- **Filesystem/platform support:** Fault-test atomic replacement, directory durability, case behavior, locked files, bind mounts, watcher loss, and SEA signing on every promised target.
- **Conflict policy:** Keep non-identical automatic merge out of v1 unless an exact-ancestry specification and multi-client race suite demonstrate preservation.
- **Packaging evolution:** Re-evaluate Node 26's built-in SEA workflow only after it reaches LTS; retain Node 24.20.0 for this compatibility baseline.
- **Real-world validation boundary:** Research intentionally did not inspect private credentials or connect to a private database. Validate only with sanitized fixtures and harness-created ephemeral CouchDB instances.

## Sources

### Primary (official/upstream; confidence classified MEDIUM)

- [Self-hosted LiveSync 1.0.23 release](https://github.com/vrtmrz/obsidian-livesync/releases/tag/1.0.23), [package manifest](https://github.com/vrtmrz/obsidian-livesync/blob/1.0.23/package.json), and [lockfile](https://github.com/vrtmrz/obsidian-livesync/blob/1.0.23/package-lock.json) — immutable compatibility tuple, toolchain, integrity, and PouchDB overrides.
- [LiveSync data structures](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/datastructure.md), [conflict/provenance specification](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/specs_conflict_resolution.md), [metadata-ID validation](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/design_docs/metadata_document_id_validation_and_repair.md), and [chunk retrieval](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/design_docs/chunk_retrieval_and_waiting.md) — protocol and safety semantics; main-derived findings require pinned-fixture confirmation.
- [LiveSync Commonlib](https://github.com/vrtmrz/livesync-commonlib), [published npm metadata](https://registry.npmjs.org/@vrtmrz%2flivesync-commonlib/0.1.21), [conflict contract](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/docs/conflict-resolution.md), and [Node storage contract](https://github.com/vrtmrz/livesync-commonlib/blob/main/docs/platform-storage.md) — package boundaries, compatibility primitives, provenance, and filesystem responsibilities.
- [Apache CouchDB replication](https://docs.couchdb.org/en/stable/replication/protocol.html), [conflicts](https://docs.couchdb.org/en/stable/replication/conflicts.html), [`_changes`](https://docs.couchdb.org/en/stable/api/database/changes.html), and [`_bulk_docs`](https://docs.couchdb.org/en/stable/api/database/bulk-api.html) — revision trees, opaque sequences, all-leaf feeds, and non-atomic write outcomes.
- [PouchDB API](https://pouchdb.com/api.html) and [conflict guide](https://pouchdb.com/guides/conflicts.html) — HTTP composition, revision and conflict behavior.
- [Node.js 24.20.0 SEA](https://nodejs.org/download/release/v24.20.0/docs/api/single-executable-applications.html), [`node:sqlite`](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html), and [filesystem watch caveats](https://nodejs.org/download/release/v24.20.0/docs/api/fs.html#fswatchfilename-options-listener) — executable, local state, and watcher constraints.
- [Chokidar](https://github.com/paulmillr/chokidar), [esbuild](https://esbuild.github.io/api/), and [Testcontainers CouchDB](https://node.testcontainers.org/modules/couchdb/) — watcher normalization, bundling, and isolated integration testing.

### Project research detail

- [STACK.md](./STACK.md) — exact pins, direct Commonlib feasibility, SEA smoke test, and test stack.
- [FEATURES.md](./FEATURES.md) — table stakes, differentiators, anti-features, and dependency graph.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — capability gates, component boundaries, bootstrap states, revision-aware data flow, and the local-replica alternative.
- [PITFALLS.md](./PITFALLS.md) — fail-closed invariants, destructive-operation denylist, recovery rules, and phase-specific hazards.

---
*Research completed: 2026-09-03*
*Ready for roadmap: yes*
