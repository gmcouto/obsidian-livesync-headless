# Requirements: obsidian-livesync-headless

**Defined:** 2026-09-03
**Core Value:** Reliably synchronize an Obsidian vault without Obsidian while preserving every unproven local or remote change and never performing destructive database maintenance.

## v1 Requirements

### Configuration and Admission

- [x] **CONF-01**: User can select a YAML configuration file that identifies an existing CouchDB database and a destination vault directory.
- [x] **CONF-02**: User can supply CouchDB credentials and encryption passphrases through environment-backed secret references without storing secret values in tracked configuration.
- [x] **CONF-03**: User receives a validation error before filesystem or network side effects when configuration is missing, malformed, internally inconsistent, or references an unsafe destination.
- [x] **CONF-04**: User can inspect connectivity, database identity, LiveSync version state, locks, security material, preferred tweaks, and representative records through a structurally read-only command.
- [x] **CONF-05**: User can pull and adopt compatible remote LiveSync settings locally while incompatible, unknown, locked, or future-version settings prevent synchronization writes.
- [x] **CONF-06**: User receives a stable compatibility report that records the remote fingerprint, negotiated-settings hash, supported and unsupported capabilities, and any blockers.
- [x] **CONF-07**: User can explicitly arm write access only after a successful verified bootstrap, with the grant bound to the remote fingerprint, vault root, settings hash, compatibility-library version, and bootstrap generation.
- [x] **CONF-08**: User's write grant is revoked automatically when its bound remote identity, vault path, settings, compatibility version, or verified baseline changes.

### LiveSync Compatibility

- [x] **COMP-01**: User can synchronize supported current and required legacy LiveSync normal-file metadata without rewriting unknown fields or special documents.
- [x] **COMP-02**: User can synchronize databases using supported LiveSync encryption, including current E2EE V2 and required legacy V1 reads, with authenticated decryption failures reported as blockers.
- [x] **COMP-03**: User can synchronize path-obfuscated and unobfuscated records using upstream-compatible path-to-document-ID, Unicode, filename-case, and underscore rules.
- [x] **COMP-04**: User can reconstruct and create text and binary files using the database's negotiated chunk hash, splitter, size, encoding, and compression conventions.
- [x] **COMP-05**: User receives a blocking error when metadata identity, decrypted content, chunk identity, assembled size, or supported document shape fails validation.
- [x] **COMP-06**: User's synchronization considers every live revision leaf and available ancestry needed to preserve conflict branches rather than trusting only CouchDB's deterministic winner.
- [x] **COMP-07**: User can coexist with supported Obsidian LiveSync clients against the same database without format divergence, hidden conflict loss, or normalization rewrites.

### Pull and Local Reflection

- [x] **PULL-01**: User can run a finite pull-only dry-run that reads and decodes remote state and reports planned local actions without mutating CouchDB, the vault, or synchronization provenance.
- [x] **PULL-02**: User can apply a verified pull to an empty or explicitly dedicated vault only after all content required for each file has been fetched, decrypted, assembled, and validated.
- [x] **PULL-03**: User's created or replaced local files are staged on the same filesystem, flushed, atomically installed where supported, and read back before synchronization state is committed.
- [x] **PULL-04**: User's displaced or remotely deleted local files are moved to collision-safe recoverable quarantine, and the operation stops before removal when recovery cannot be guaranteed.
- [x] **PULL-05**: User's local state records the exact remote revision reflected in each file only after the corresponding filesystem change is durably verified.
- [x] **PULL-06**: User can resume an interrupted or partially blocked pull without treating incomplete files as local edits or advancing past unverified data.
- [x] **PULL-07**: User is protected from path traversal, absolute paths, unsafe symlinks, reserved state paths, and filename-case collisions during local reflection.
- [x] **PULL-08**: User can rerun a completed pull with no remote changes and receive an idempotent no-op result.

### Bidirectional One-Shot Sync

- [ ] **SYNC-01**: User can run one CLI command that performs preflight, remote catch-up, local scan, safe reconciliation, required push/pull work, and a final convergence check.
- [x] **SYNC-02**: User's local file creations and edits extend a proven LiveSync revision base and are encoded with the negotiated metadata, encryption, compression, and chunk conventions.
- [x] **SYNC-03**: User's changed file metadata becomes visible remotely only after every referenced chunk write has succeeded and every CouchDB write result has been validated.
- [x] **SYNC-04**: User's intentional local file deletion creates a LiveSync-compatible logical-deletion child of the proven displayed revision without using purge or ordinary CouchDB document deletion.
- [x] **SYNC-05**: User's case-only rename remains in the same revision tree, while a cross-path rename stores and verifies the target before logically deleting only the proven source branch.
- [x] **SYNC-06**: User's byte-identical conflict leaves can be collapsed safely, while ambiguous ancestry, delete-versus-modify, differing binary content, missing bodies, and unrelated branches remain preserved and reported.
- [x] **SYNC-07**: User's unsynchronized local content is preserved when its bytes cannot be matched to exactly one available remote revision.
- [x] **SYNC-08**: User can run bidirectional synchronization in an enforceable dry-run mode that exposes planned creates, updates, logical deletions, quarantines, conflicts, skips, and blockers without write capabilities.
- [ ] **SYNC-09**: User can rerun one-shot synchronization after success, interruption, or transient failure without duplicate revisions, lost branches, or unsafe repeated side effects.

### Daemon Operation

- [ ] **DAEM-01**: User can start daemon mode only after configuration admission and any required write grant have been validated.
- [ ] **DAEM-02**: User's daemon completes the same finite pull-first catch-up and reconciliation as one-shot mode before enabling live filesystem or remote change processing.
- [ ] **DAEM-03**: User's daemon treats CouchDB change-feed and filesystem-watcher events as invalidation hints and re-reads authoritative state before deciding an action.
- [ ] **DAEM-04**: User's daemon serializes work per file identity, suppresses self-generated reflection loops using content and provenance, and bounds concurrent work and queues.
- [ ] **DAEM-05**: User's daemon preserves opaque remote checkpoints and durable intents across restarts without advancing a checkpoint past blocked or unverified work.
- [ ] **DAEM-06**: User's daemon reconnects after transient remote failures using bounded exponential backoff with jitter and performs startup, periodic, and post-error reconciliation scans.
- [ ] **DAEM-07**: User's daemon enters a visible degraded read-only or blocked state rather than enabling writes when compatibility, provenance, corruption, or configuration becomes unsafe.
- [ ] **DAEM-08**: User can stop the daemon through normal process signals and have it stop intake, drain or journal in-flight work, persist safe state, and exit deterministically.

### Safety and Operations

- [x] **SAFE-01**: User cannot invoke database creation, drop, reset, rebuild, overwrite, purge, compaction, garbage collection, retention changes, security changes, design/index management, or server-managed replication through the application.
- [x] **SAFE-02**: User's first-contact and dry-run traffic is restricted to an explicit read-only HTTP method and endpoint allowlist, with mutation attempts blocked before transport.
- [x] **SAFE-03**: User's write-capable traffic is restricted to the minimum LiveSync document operations required for armed file synchronization, with destructive and administrative endpoints denied after URL canonicalization and redirects.
- [x] **SAFE-04**: User's credentials, passphrases, setup URIs, authorization headers, and decrypted payloads are excluded or redacted from logs, errors, state databases, crash output, and packaged artifacts.
- [x] **SAFE-05**: User's checkpoints, exact revision provenance, admission records, write grants, operation journal, and quarantine index are stored durably outside the synchronized vault namespace.
- [x] **SAFE-06**: User receives human-readable and JSON Lines diagnostics with stable outcome categories and non-zero exit or health states for incompatibility, authentication failure, corruption, conflict, partial write, and transient outage.
- [ ] **SAFE-07**: User is warned that synchronization propagates changes and is not a substitute for an independent versioned backup.

### Distribution and Compatibility Gate

- [x] **DIST-01**: User can run the distributed CLI as a single executable without separately installing Node.js or project dependencies.
- [x] **DIST-02**: User can access documented `inspect`, pull-only, one-shot synchronization, daemon, dry-run, status, and write-arming command flows from the CLI.
- [x] **DIST-03**: User receives a build whose LiveSync release, commonlib package, transitive compatibility overrides, and package integrity are pinned and reported.
- [x] **DIST-04**: User can rely on release tests covering current-client encrypted and obfuscated text/binary files, chunks, logical deletion, concurrent edits, conflict propagation, renames, restarts, and missing or corrupt content against disposable CouchDB instances.
- [x] **DIST-05**: User can rely on the packaged executable passing audits for forbidden database operations, unexpected runtime dependencies, out-of-scope providers, and embedded secrets before release.

## v2 Requirements

### Inspection and Recovery

- **FORE-01**: User can inspect every live revision, available ancestor, logical deletion, metadata mismatch, and chunk-availability state without mutation.
- **FORE-02**: User can export a selected readable revision to a separate recovery path without changing local or remote synchronization state.
- **RECV-01**: User can restore a quarantined file after the application revalidates the current local and remote revisions.
- **RECV-02**: User can create a successor from an explicitly selected available historical revision after a fresh revision check.

### Operability

- **OPER-01**: User can obtain a machine-readable explanation of the evidence that permitted or blocked every synchronization action.
- **OPER-02**: User can read daemon health from a local-only status file or endpoint without exposing secrets or mutation controls.
- **OPER-03**: User can configure checkpointed polling as an equivalent fallback when a proxy cannot sustain a live CouchDB changes feed.
- **OPER-04**: Maintainers can replay sanitized compatibility fixtures and filesystem event traces offline to detect regressions.

### Selective Synchronization

- **SELE-01**: User can select a subset of normal vault files only after an ownership and deletion model proves that asymmetric filters cannot cause resurrection or data loss.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Obsidian UI or plugin implementation | The product is a standalone file-synchronization CLI. |
| Obsidian plugin installation, updates, enablement, or lifecycle management | Managing Obsidian is unrelated to headless file synchronization. |
| LiveSync Customisation Sync, plugin/theme/snippet semantics, or UI configuration | These use separate namespaces and behavior outside the normal vault-file contract. |
| Synchronization presets other than LiveSync | v1 targets one compatibility contract. |
| Object Storage and P2P remotes | Their transport and journal semantics would multiply the v1 safety surface. |
| Database creation or remote administration | The app connects only to an existing, externally administered database. |
| Drop, reset, rebuild, overwrite, purge, compaction, or garbage collection | These can destroy history or remote-only data and violate the core value. |
| Automatic newest-time, highest-generation, or deterministic-winner conflict resolution | These signals do not prove ancestry or user intent. |
| Automatic deletion of unresolved conflict branches or corrupt records | Unknown content may be the only surviving copy of user data. |
| Arbitrary partial sync in v1 | Asymmetric scope can cause resurrection and false deletion without an ownership model. |
| Synchronization marketed as backup | Replication propagates changes and deletions; independent backups remain necessary. |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONF-01 | Phase 1 | Complete |
| CONF-02 | Phase 1 | Complete |
| CONF-03 | Phase 1 | Complete |
| CONF-04 | Phase 1 | Complete |
| CONF-05 | Phase 1 | Complete |
| CONF-06 | Phase 1 | Complete |
| CONF-07 | Phase 4 | Complete |
| CONF-08 | Phase 4 | Complete |
| COMP-01 | Phase 2 | Complete |
| COMP-02 | Phase 2 | Complete |
| COMP-03 | Phase 2 | Complete |
| COMP-04 | Phase 2 | Complete |
| COMP-05 | Phase 2 | Complete |
| COMP-06 | Phase 2 | Complete |
| COMP-07 | Phase 6 | Complete |
| PULL-01 | Phase 2 | Complete |
| PULL-02 | Phase 2 | Complete |
| PULL-03 | Phase 2 | Complete |
| PULL-04 | Phase 3 | Complete |
| PULL-05 | Phase 2 | Complete |
| PULL-06 | Phase 3 | Complete |
| PULL-07 | Phase 2 | Complete |
| SYNC-01 | Phase 4 | Complete |
| SYNC-02 | Phase 4 | Complete |
| SYNC-03 | Phase 4 | Complete |
| SYNC-04 | Phase 4 | Complete |
| SYNC-05 | Phase 4 | Complete |
| SYNC-06 | Phase 4 | Complete |
| SYNC-07 | Phase 4 | Complete |
| SYNC-08 | Phase 4 | Complete |
| SYNC-09 | Phase 4 | Complete |
| DAEM-01 | Phase 5 | Pending |
| DAEM-02 | Phase 5 | Pending |
| DAEM-03 | Phase 5 | Pending |
| DAEM-04 | Phase 5 | Pending |
| DAEM-05 | Phase 5 | Pending |
| DAEM-06 | Phase 5 | Pending |
| DAEM-07 | Phase 5 | Pending |
| DAEM-08 | Phase 5 | Pending |
| SAFE-01 | Phase 1 | Complete |
| SAFE-02 | Phase 1 | Complete |
| SAFE-03 | Phase 4 | Complete |
| SAFE-04 | Phase 1 | Complete |
| SAFE-05 | Phase 3 | Complete |
| SAFE-06 | Phase 1 | Complete |
| SAFE-07 | Phase 4 | Complete |
| DIST-01 | Phase 6 | Complete |
| DIST-02 | Phase 6 | Complete |
| DIST-03 | Phase 6 | Complete |
| DIST-04 | Phase 6 | Complete |
| DIST-05 | Phase 6 | Complete |

**Coverage:**

- v1 requirements: 52 total
- Mapped to phases: 52
- Unmapped: 0 ✓

---
*Requirements defined: 2026-09-03*
*Last updated: 2026-09-03 after roadmap creation*
