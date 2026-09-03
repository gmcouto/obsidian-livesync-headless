# Roadmap: obsidian-livesync-headless

## Overview

The MVP advances through six guarded vertical slices: establish structurally read-only admission to an existing CouchDB database, prove verified pull materialization, make pull recovery-safe, permit explicitly armed one-shot convergence, reuse that convergence continuously in daemon mode, and release the exact packaged executable only after mixed-client compatibility and safety gates pass.

## Phases

- [x] **Phase 1: Guarded Read-Only Admission** - Run the first real CLI-to-CouchDB integration while proving configuration safety, compatibility, and zero remote mutation. (completed 2026-09-03)
- [ ] **Phase 2: Verified Pull Materialization** - Decode supported LiveSync records and safely materialize a dedicated vault without remote writes.
- [ ] **Phase 3: Recoverable Pull Operations** - Make local reflection durable, resumable, quarantined, and repeatably idempotent before any push is allowed.
- [ ] **Phase 4: Explicitly Armed Bidirectional One-Shot** - Converge local and remote file state once through a fresh, scope-bound write grant and preservation-first reconciliation.
- [ ] **Phase 5: Continuous Convergence Daemon** - Reuse the one-shot safety model for bounded, restart-safe continuous synchronization.
- [ ] **Phase 6: Packaged Mixed-Client Release Gate** - Ship a single executable only after packaged compatibility, integrity, safety, and mixed-client evidence passes.

## Phase Details

### Phase 1: Guarded Read-Only Admission

**Goal:** Users can safely inspect and negotiate compatibility with an already existing LiveSync CouchDB database through the first runnable CLI integration, with proof that the remote database was not changed.
**Mode:** mvp
**Depends on:** Nothing (first phase)
**Requirements:** CONF-01, CONF-02, CONF-03, CONF-04, CONF-05, CONF-06, SAFE-01, SAFE-02, SAFE-04, SAFE-06
**Success Criteria** (what must be TRUE):

  1. User can launch the CLI, select a YAML configuration for an existing CouchDB database and destination vault, and run the documented `inspect` flow.
  2. User can supply secrets through environment-backed references; invalid or unsafe configuration fails before filesystem or network side effects, and diagnostics never disclose secret or decrypted values.
  3. User can inspect database identity, LiveSync version and lock state, security material, preferred tweaks, and representative records through traffic restricted to the read-only method and endpoint allowlist.
  4. User receives stable human-readable and JSON Lines compatibility results containing the remote fingerprint, negotiated-settings hash, supported capabilities, blockers, and locally adopted compatible remote settings; unsupported or future states fail closed.
  5. User receives before-and-after evidence that remote sequence and compatibility-marker revisions did not change, while the CLI exposes no remote database lifecycle or administration capability.

**Plans:** 3/3 plans complete

- [x] 01-01-PLAN.md
- [x] 01-02-PLAN.md
- [x] 01-03-PLAN.md

### Phase 2: Verified Pull Materialization

**Goal:** Users can preview and materialize verified LiveSync file content into an empty or explicitly dedicated vault without granting any remote write capability.
**Mode:** mvp
**Depends on:** Phase 1
**Requirements:** COMP-01, COMP-02, COMP-03, COMP-04, COMP-05, COMP-06, PULL-01, PULL-02, PULL-03, PULL-05, PULL-07
**Success Criteria** (what must be TRUE):

  1. User can run a finite pull-only dry-run that decodes remote state and reports planned local actions without changing CouchDB, the vault, or synchronization provenance.
  2. User can apply a pull that reconstructs validated current and required legacy encrypted or unencrypted, obfuscated or unobfuscated text and binary files only after all required metadata and chunks are available and verified.
  3. User is blocked with actionable diagnostics when metadata, decryption, chunk identity, assembled size, path identity, document shape, or any live conflict leaf cannot be handled safely; unknown fields, special documents, and unresolved branches remain preserved.
  4. User's files are protected from traversal, absolute paths, unsafe symlinks, reserved state paths, and filename-case collisions, and valid content is staged, flushed, atomically installed where supported, and read back before acceptance.
  5. User can verify that local provenance records the exact remote revision for each visible file only after its bytes are durably reflected.

**Plans:** 1/4 plans executed

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Tracer: pull --dry-run and one-file empty-vault apply for a legacy notes document, plus tweak adoption and CONFLICT exit 8

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 02-02-PLAN.md — Decode encrypted V1/V2, obfuscated paths, chunked plain/newnote, and validation blockers

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 02-03-PLAN.md — All-leaf conflict blocks, path safety, and empty-or-dedicated vault preflight

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 02-04-PLAN.md — Capability-gated atomic apply, provenance-after-verify, and fail-closed integration

### Phase 3: Recoverable Pull Operations

**Goal:** Users can repeat or recover pull operations without losing displaced local content, misclassifying partial work, or advancing beyond unverified state.
**Mode:** mvp
**Depends on:** Phase 2
**Requirements:** PULL-04, PULL-06, PULL-08, SAFE-05
**Success Criteria** (what must be TRUE):

  1. User's displaced or remotely deleted local files move to collision-safe recoverable quarantine, and reflection stops before removal whenever recoverability cannot be guaranteed.
  2. User can resume after interruption, disk failure, or a blocked operation without incomplete files becoming local edits and without provenance or checkpoints advancing past verified work.
  3. User can rerun a completed pull with no remote changes and receive an idempotent no-op without duplicate operations or altered file bytes.
  4. User's admission records, exact revision provenance, checkpoints, operation journal, and quarantine index survive restarts in durable state outside the synchronized vault namespace, with corrupt or incompatible state surfaced as a blocker.

**Plans:** TBD

### Phase 4: Explicitly Armed Bidirectional One-Shot

**Goal:** Users can explicitly authorize and run one preservation-first bidirectional synchronization that converges supported local and remote file changes without guessing through ambiguous provenance.
**Mode:** mvp
**Depends on:** Phase 3
**Requirements:** CONF-07, CONF-08, SYNC-01, SYNC-02, SYNC-03, SYNC-04, SYNC-05, SYNC-06, SYNC-07, SYNC-08, SYNC-09, SAFE-03, SAFE-07
**Success Criteria** (what must be TRUE):

  1. User can arm writes only after a successful verified bootstrap; the grant is visibly bound to the remote fingerprint, vault root, settings hash, compatibility version, and bootstrap generation, and is automatically revoked when any bound evidence changes.
  2. User can preview creates, updates, logical deletions, quarantines, conflicts, skips, and blockers in an enforceable bidirectional dry-run, then run one command that performs preflight, remote catch-up, local scan, reconciliation, required transfer, and final convergence checking.
  3. User's local creations and edits extend only a proven LiveSync revision base, and changed metadata becomes remotely visible only after every referenced chunk is stored and every write result is validated through the minimum allowed file-synchronization operations.
  4. User's intentional deletion becomes a LiveSync-compatible logical deletion on the proven branch; case-only and cross-path renames preserve revision history and verify the destination before retiring the source branch.
  5. User's unmatched local bytes and ambiguous conflict branches remain preserved and reported, byte-identical leaves collapse only when safe, reruns do not duplicate revisions or lose branches, and the CLI warns that synchronization is not an independent backup.

**Plans:** TBD

### Phase 5: Continuous Convergence Daemon

**Goal:** Users can keep a vault converged continuously through the proven one-shot engine while retaining bounded work, durable recovery, and fail-closed operation.
**Mode:** mvp
**Depends on:** Phase 4
**Requirements:** DAEM-01, DAEM-02, DAEM-03, DAEM-04, DAEM-05, DAEM-06, DAEM-07, DAEM-08
**Success Criteria** (what must be TRUE):

  1. User can start daemon mode only with valid admission and any required fresh write grant, and the daemon completes finite pull-first catch-up and reconciliation before processing live events.
  2. Remote-feed and filesystem-watcher events cause authoritative state re-reads; work is serialized per file identity, self-generated loops are suppressed using bytes and provenance, and queue and concurrency growth remain bounded.
  3. User can restart the daemon without losing opaque checkpoints or durable intents, and blocked or unverified work never advances the checkpoint.
  4. User sees the daemon reconnect after transient outages with bounded jittered backoff and reconcile on startup, periodically, and after errors; unsafe compatibility, provenance, corruption, or configuration produces a visible degraded read-only or blocked state.
  5. User can stop the daemon with normal process signals and observe deterministic intake shutdown, safe draining or journaling of in-flight work, durable state persistence, and process exit.

**Plans:** TBD

### Phase 6: Packaged Mixed-Client Release Gate

**Goal:** Users can install and trust the exact standalone CLI release after its packaged artifact proves supported LiveSync interoperability and safety.
**Mode:** mvp
**Depends on:** Phase 5
**Requirements:** COMP-07, DIST-01, DIST-02, DIST-03, DIST-04, DIST-05
**Success Criteria** (what must be TRUE):

  1. User can run the distributed CLI as one executable without separately installing Node.js or project dependencies.
  2. User can discover and use documented `inspect`, pull-only, one-shot synchronization, daemon, dry-run, status, and write-arming command flows from the packaged executable.
  3. User can inspect the build's pinned LiveSync release, Commonlib package, transitive compatibility overrides, and package-integrity identity.
  4. User can rely on published packaged-artifact test evidence for encrypted and obfuscated text and binary files, chunks, logical deletions, concurrent edits, conflict propagation, renames, restarts, and missing or corrupt content with supported Obsidian LiveSync clients on disposable databases.
  5. User can verify that the release passed audits for forbidden remote capabilities, unexpected runtime dependencies, out-of-scope providers, embedded secrets, format divergence, hidden conflict loss, and normalization rewrites.

**Plans:** TBD

## Progress

**Execution Order:** Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Guarded Read-Only Admission | 3/3 | Complete    | 2026-09-03 |
| 2. Verified Pull Materialization | 1/4 | In Progress|  |
| 3. Recoverable Pull Operations | 0/TBD | Not started | - |
| 4. Explicitly Armed Bidirectional One-Shot | 0/TBD | Not started | - |
| 5. Continuous Convergence Daemon | 0/TBD | Not started | - |
| 6. Packaged Mixed-Client Release Gate | 0/TBD | Not started | - |
