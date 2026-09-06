---
phase: 04-explicitly-armed-bidirectional-one-shot
plan: 03
subsystem: sync-planning-and-reconciliation
tags:
  - vault-scanner
  - rename-detector
  - sync-plan
  - conflict-reconciler
  - dry-run
requires:
  - 04-02-push-and-deletion
provides:
  - vault-scanner
  - rename-detector
  - sync-plan-engine
  - conflict-reconciliation
  - dry-run-serialization
affects:
  - 04-04-sync-coordinator
tech-stack:
  added: []
  patterns:
    - Safe collapse of byte-identical CouchDB conflict leaves without data loss
    - Preservation and non-destructive halting on divergent conflict branches
    - Provenance SHA-256 matching for case-only and cross-path rename heuristics
key-files:
  created:
    - src/filesystem/vault-scanner.ts
    - src/domain/rename-detector.ts
    - src/domain/sync-plan.ts
    - tests/unit/vault-scanner.test.ts
    - tests/unit/rename-detector.test.ts
    - tests/unit/sync-plan.test.ts
    - tests/unit/conflict-reconciler.test.ts
  modified: []
key-decisions:
  - "Built VaultScanner computing streaming SHA-256 for vault files and ignoring hidden/system files."
  - "Implemented RenameDetector differentiating case-only renames (preserving document lineage) from unambiguous 1-to-1 cross-path renames."
  - "Engineered SyncPlan with byte-identical conflict leaf collapse and fail-closed divergent branch preservation."
requirements:
  - SYNC-05
  - SYNC-06
  - SYNC-07
  - SYNC-08
coverage:
  - deliverable: "VaultScanner traversing vault, computing SHA-256, and skipping ignored files"
    verification:
      kind: automated
      ref: tests/unit/vault-scanner.test.ts
      status: pass
    human_judgment: false
  - deliverable: "RenameDetector recognizing case-only and cross-path renames"
    verification:
      kind: automated
      ref: tests/unit/rename-detector.test.ts
      status: pass
    human_judgment: false
  - deliverable: "SyncPlan engine with byte-identical conflict collapse and divergent branch preservation"
    verification:
      kind: automated
      ref: tests/unit/conflict-reconciler.test.ts
      status: pass
    human_judgment: false
  - deliverable: "Deterministic dry-run serialization without side-effects"
    verification:
      kind: automated
      ref: tests/unit/sync-plan.test.ts
      status: pass
    human_judgment: false
duration: 4 min
completed: 2026-09-06T01:09:50-03:00
---

# Phase 04 Plan 03: Local Vault Scanner, Rename Detector, Conflict Reconciler & Sync Planner Summary

Implemented `VaultScanner` for local change detection, `RenameDetector` for case-only and cross-path rename heuristics (SYNC-05), `SyncPlan` for bidirectional reconciliation with safe byte-identical conflict collapse (SYNC-06, SYNC-07), and `serializeSyncPlan` for dry-run preview (SYNC-08).

## Key Deliverables

1. **VaultScanner (`src/filesystem/vault-scanner.ts`)**:
   - Recursively walks local vault directory.
   - Calculates SHA-256 checksums, sizes, and mtimes.
   - Strictly ignores system folders (`.obsidian`, `.git`, `.trash`) and files matching `isReservedOrIgnoredPath`.

2. **RenameDetector (`src/domain/rename-detector.ts`)**:
   - Identifies case-only renames where lower-cased paths match and content SHA-256 matches provenance (SYNC-05).
   - Identifies unambiguous 1-to-1 cross-path moves based on exact SHA-256 matching.
   - Prevents false-positive rename inferences when multiple candidate files share hashes.

3. **SyncPlan & Conflict Reconciler (`src/domain/sync-plan.ts`)**:
   - Reconciles three-way state: remote CouchDB documents, local vault files, and SQLite provenance.
   - Generates unified action plan (`pull-create`, `pull-update`, `pull-delete`, `push-create`, `push-update`, `push-delete`, `rename-case`, `rename-cross`, `noop`, `conflict`).
   - Safely collapses byte-identical conflict leaves to single winning revision (SYNC-06).
   - Halts and preserves divergent conflict branches without overwriting data (SYNC-06, SYNC-07).
   - Serializes dry-run previews with full summaries (SYNC-08).

## Verification

- `npx vitest run tests/unit/vault-scanner.test.ts tests/unit/rename-detector.test.ts tests/unit/sync-plan.test.ts tests/unit/conflict-reconciler.test.ts` (13 tests passed)

## Self-Check: PASSED
