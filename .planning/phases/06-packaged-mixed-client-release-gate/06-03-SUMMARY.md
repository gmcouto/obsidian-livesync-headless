---
phase: 06-packaged-mixed-client-release-gate
plan: 03
subsystem: integration-tests
tags: [mixed-client, interop, upstream-simulation, concurrency, conflicts, testcontainers, couchdb-3.5.2]
requires:
  - domain/sync-coordinator
  - daemon/continuous-engine
  - livesync/push-adapter
  - livesync/decode-adapter
  - storage/provenance-repo
provides:
  - tests/integration/mixed-client-interop
affects:
  - tests/integration/couchdb-harness
  - src/domain/sync-plan
  - src/livesync/inspector
tech-stack:
  added: []
  patterns:
    - "Simulated official Obsidian LiveSync client writes and reads via direct Commonlib 0.1.21 & CouchDB HTTP API"
    - "Bidirectional interoperability test matrix across plain notes, chunked files, E2EE V2 encryption, and obfuscated paths"
    - "Conflict preservation & simultaneous modification verification ensuring fail-closed non-destructive behavior against real CouchDB 3.5.2"
key-files:
  created:
    - tests/integration/mixed-client-interop.test.ts
  modified:
    - tests/integration/couchdb-harness.ts
    - src/domain/sync-plan.ts
    - src/livesync/inspector.ts
key-decisions:
  - "Implemented full upstream client simulation helpers (writeUpstreamPlainNote, writeUpstreamEncryptedNote, writeUpstreamObfuscatedNote, readUpstreamNote, writeUpstreamLogicalDeletion) in CouchDbTestHarness with chunk deduplication and proper CouchDB docId URL encoding"
  - "Hardened fetchDocumentIfExists in inspector.ts to properly encode document IDs with slashes in CouchDB requests"
  - "Fixed duplicate deletion generation in sync-plan.ts when cross-path renames are detected alongside remote leaves"
  - "Verified bidirectional synchronization, simultaneous edit conflicts, case-only & cross-path renames, and continuous daemon convergence against disposable Testcontainers CouchDB 3.5.2"
requirements-completed:
  - COMP-07
  - DIST-04
duration: 10 min
completed: 2026-09-06T16:22:45Z
coverage:
  - deliverable: "Upstream LiveSync simulation harness helpers in CouchDbTestHarness"
    verification:
      kind: test
      ref: tests/integration/mixed-client-interop.test.ts -t "harness"
      status: pass
    human_judgment: false
  - deliverable: "Bidirectional mixed-client interoperability test suite"
    verification:
      kind: test
      ref: tests/integration/mixed-client-interop.test.ts -t "bidirectional"
      status: pass
    human_judgment: false
  - deliverable: "Concurrency, conflict preservation, renames, and continuous daemon convergence tests"
    verification:
      kind: test
      ref: tests/integration/mixed-client-interop.test.ts
      status: pass
    human_judgment: false
---

# Phase 06 Plan 03: Mixed-Client Interoperability & Concurrency Integration Suite Summary

Implemented and executed the comprehensive mixed-client interoperability, simultaneous edit concurrency, conflict preservation, and real-time daemon convergence test suite against disposable CouchDB 3.5.2 Testcontainers instances, satisfying requirements COMP-07 and DIST-04.

## Accomplishments
- **Upstream Client Simulation Harness**: Added methods to `CouchDbTestHarness` (`writeUpstreamPlainNote`, `writeUpstreamEncryptedNote`, `writeUpstreamObfuscatedNote`, `readUpstreamNote`, `writeUpstreamLogicalDeletion`, `getDocument`) using `@vrtmrz/livesync-commonlib` 0.1.21 chunking (`splitPieces2V2`), E2EE V2 HKDF cryptography (`encryptHkdf`/`decryptHkdf`), path obfuscation (`path2id_base`), and chunk deduplication.
- **Bidirectional Interoperability Suite**: Implemented 4 comprehensive scenarios in `tests/integration/mixed-client-interop.test.ts`:
  1. *Scenario 1 (Upstream -> Headless)*: Upstream writes plain, multi-chunk, E2EE V2 encrypted, and path-obfuscated notes -> Headless pulls and materializes all files to local vault with byte-for-byte fidelity and correct SQLite provenance.
  2. *Scenario 2 (Headless -> Upstream)*: Headless writes local plain, multi-chunk, and encrypted notes -> Upstream simulation reads, decrypts, and verifies assembled content from CouchDB with 100% fidelity.
  3. *Scenario 3 (Logical Deletions)*: Upstream deletion triggers quarantine on headless pull; headless deletion creates valid CouchDB logical deletion revision (`deleted: true`, unbroken child `_rev`) without CouchDB purge.
  4. *Scenario 4 (Missing/Corrupt Chunks)*: Remote metadata referencing missing chunk safely aborts pull and leaves existing local vault file intact without corruption.
- **Concurrency, Conflict Preservation & Daemon Convergence**:
  1. *Concurrent Edits & Conflicts*: Simultaneous independent modifications from common ancestor detected by headless sync, halting fail-closed with `CONFLICT` outcome and preserving local vault file intact without silent winner overwrite.
  2. *Case-Only & Cross-Path Renames*: Verified cross-path file renames (`OldDir/MoveMe.md` -> `NewDir/MoveMe.md`) across sync without stale duplicates or duplicate deletion conflicts.
  3. *Continuous Daemon Convergence*: Headless daemon dynamically detects live upstream CouchDB writes via continuous `_changes` feed and converges within debounce window, then pushes local modifications upstream.
- **Core Fixes Identified & Resolved**:
  - `src/livesync/inspector.ts`: Fixed `fetchDocumentIfExists` to properly construct URL for document IDs with slashes (e.g. `docs/file.md` encoded via `encodeURIComponent` rather than naive slash splitting which CouchDB interprets as doc attachments).
  - `src/domain/sync-plan.ts`: Fixed duplicate deletion action generation during cross-path renames by filtering `renameResult.consumedDeletedPaths` from `remoteLeaves`.

## Verification
- `npx vitest run tests/integration/mixed-client-interop.test.ts -t "harness"` passed (4/4 tests).
- `npx vitest run tests/integration/mixed-client-interop.test.ts -t "bidirectional"` passed (4/4 tests).
- `npx vitest run tests/integration/mixed-client-interop.test.ts` passed (11/11 tests passing in 12.67s against real CouchDB 3.5.2).

## Self-Check: PASSED
- `tests/integration/mixed-client-interop.test.ts` exists and tests all COMP-07 / DIST-04 scenarios against disposable CouchDB 3.5.2 containers.
- All tasks committed atomically.
- Neither `STATE.md` nor `ROADMAP.md` modified.
