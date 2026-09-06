---
phase: 03-recoverable-pull-operations
plan: 01
subsystem: storage
tags:
  - sqlite
  - migrations
  - quarantine
  - provenance
  - checkpoints
requires:
  - storage/sqlite.ts
  - storage/provenance-repo.ts
provides:
  - storage/sqlite.ts (CURRENT_SCHEMA_VERSION = 4, migrations 003 & 004)
  - storage/quarantine-repo.ts (QuarantineRepository, QuarantineRecord)
  - storage/checkpoint-repo.ts (CheckpointRepository, CheckpointRecord)
  - storage/provenance-repo.ts (deleteProvenance, getAllAsMap)
  - filesystem/quarantine-store.ts (quarantineVaultFile, QuarantineError)
affects:
  - pull-operations
  - reconciliation
  - vault-preservation
tech-stack:
  added: []
  patterns:
    - Fail-closed quarantine copying with byte-level read-back verification before vault unlinking
    - External metadata persistence in WAL-mode SQLite outside vault boundaries
key-files:
  created:
    - src/storage/quarantine-repo.ts
    - src/storage/checkpoint-repo.ts
    - src/filesystem/quarantine-store.ts
    - tests/unit/quarantine-repo.test.ts
    - tests/unit/checkpoint-repo.test.ts
    - tests/unit/quarantine-store.test.ts
  modified:
    - src/storage/sqlite.ts
    - src/storage/provenance-repo.ts
    - tests/unit/provenance-repo.test.ts
key-decisions:
  - "Durable quarantine metadata is persisted into SQLite quarantine table with index on original_path"
  - "quarantineVaultFile enforces byte-for-byte read-back verification and SQLite record insertion before source vault unlinking"
  - "pull_checkpoints table upserts opaque CouchDB update_seq bound by remote_fingerprint"
requirements-completed:
  - SAFE-05
  - PULL-04
duration: 3 min
completed: 2026-09-06T00:11:15-03:00
coverage:
  - deliverable: "SQLite migrations 003 (quarantine) and 004 (pull_checkpoints)"
    verification:
      kind: automated
      ref: tests/unit/quarantine-repo.test.ts
      status: pass
    human_judgment: false
  - deliverable: "QuarantineRepository and CheckpointRepository data access layers"
    verification:
      kind: automated
      ref: tests/unit/checkpoint-repo.test.ts
      status: pass
    human_judgment: false
  - deliverable: "Fail-closed quarantineVaultFile file preservation utility"
    verification:
      kind: automated
      ref: tests/unit/quarantine-store.test.ts
      status: pass
    human_judgment: false
---

# Phase 03 Plan 01: Storage Foundation and Quarantine Store Summary

SQLite schema migrations 003 and 004, QuarantineRepository, CheckpointRepository, and fail-closed quarantineVaultFile file preservation utility.

## Accomplishments
- Implemented SQLite migrations 003 (`quarantine` table with index) and 004 (`pull_checkpoints` table with unique constraint) bumping schema version to 4.
- Implemented `QuarantineRepository` for recording displaced or deleted file metadata and querying history by original path.
- Implemented `CheckpointRepository` with upsert support for durable CouchDB `update_seq` checkpoints keyed by `remote_fingerprint`.
- Extended `ProvenanceRepository` with `deleteProvenance(path)` and `getAllAsMap()` queries.
- Implemented `quarantineVaultFile` in `src/filesystem/quarantine-store.ts` ensuring path traversal safety, unique collision-safe timestamped directory structure outside the vault, byte-for-byte read-back verification, and SQLite recording before source unlinking.

## Deviations from Plan
None - plan executed exactly as written.

## Self-Check: PASSED
- `tests/unit/quarantine-repo.test.ts` PASSED
- `tests/unit/checkpoint-repo.test.ts` PASSED
- `tests/unit/provenance-repo.test.ts` PASSED
- `tests/unit/quarantine-store.test.ts` PASSED
- Total test suite: 23 files, 151 tests passed.
