---
phase: 04-explicitly-armed-bidirectional-one-shot
plan: 01
subsystem: security-and-storage
tags:
  - write-grant
  - armed-transport
  - sqlite-migration
  - capabilities
requires:
  - 03-quarantine-resume-and-fault-injection
provides:
  - sqlite-migration-005
  - write-grant-repo
  - armed-transport-guard
  - write-capabilities
affects:
  - 04-02-push-and-deletion
  - 04-04-sync-coordinator
tech-stack:
  added: []
  patterns:
    - 5-tuple bound write grant with automatic evidence drift revocation
    - Least privilege HTTP transport guard allowing GET/HEAD/PUT/POST and blocking DELETE and admin endpoints
key-files:
  created:
    - src/storage/write-grant-repo.ts
    - tests/unit/write-grant-repo.test.ts
    - tests/unit/armed-transport-guard.test.ts
  modified:
    - src/storage/sqlite.ts
    - src/security/capabilities.ts
    - src/security/transport-guard.ts
    - tests/unit/checkpoint-repo.test.ts
    - tests/unit/provenance-repo.test.ts
    - tests/unit/quarantine-repo.test.ts
key-decisions:
  - "Bound write grants to 5 explicit tuples in SQLite (remote fingerprint, vault root, settings hash, commonlib version, bootstrap generation) with immediate auto-revocation on any evidence mismatch."
  - "Constructed createArmedGuardedFetch strictly restricting write-capable HTTP traffic to document operations while blocking DELETE and all CouchDB administrative subpaths."
requirements:
  - CONF-07
  - CONF-08
  - SAFE-03
coverage:
  - deliverable: "SQLite schema migration 005 and WriteGrantRepo with 5-tuple binding and auto-revocation"
    verification:
      kind: automated
      ref: tests/unit/write-grant-repo.test.ts
      status: pass
    human_judgment: false
  - deliverable: "Armed transport guard createArmedGuardedFetch allowing GET/HEAD/PUT/POST and blocking DELETE and administrative subpaths"
    verification:
      kind: automated
      ref: tests/unit/armed-transport-guard.test.ts
      status: pass
    human_judgment: false
  - deliverable: "WriteCapability and ArmedSyncCapability branded token factories and type guards"
    verification:
      kind: automated
      ref: tests/unit/armed-transport-guard.test.ts
      status: pass
    human_judgment: false
duration: 2 min
completed: 2026-09-06T01:03:30-03:00
---

# Phase 04 Plan 01: Storage, Arming, and Armed Transport Guard Summary

Implemented SQLite schema migration 005 and `WriteGrantRepo` ensuring explicit 5-tuple write authorization with automatic revocation upon evidence drift (CONF-07, CONF-08), alongside `createArmedGuardedFetch` and write capability tokens enforcing minimum allowed CouchDB HTTP operations and blocking destructive endpoints (SAFE-03).

## Key Deliverables

1. **SQLite Migration 005 & WriteGrantRepo (`src/storage/write-grant-repo.ts`)**:
   - Added `write_grants` table with columns for 5-tuple bindings (`remote_fingerprint`, `vault_root`, `settings_hash`, `commonlib_version`, `bootstrap_generation`) and index `idx_write_grants_active`.
   - `WriteGrantRepo` provides methods `issueGrant`, `getActiveGrant`, `verifyGrantBinding`, `revokeGrant`, and `revokeActiveGrantsForVault`.
   - Auto-revokes active grants with descriptive reasons whenever any element of the 5-tuple drifts.

2. **Armed Transport Guard & Capabilities (`src/security/transport-guard.ts`, `src/security/capabilities.ts`)**:
   - Added branded capability types `WriteCapability` and `ArmedSyncCapability`.
   - Implemented `createArmedGuardedFetch` allowing `GET`, `HEAD`, `PUT`, `POST` to database paths and blocking `DELETE`, `COPY`, `PATCH`, and administrative subpaths (`/_purge`, `/_compact`, `/_security`, etc.).
   - Enforces origin matching and manual redirect inspection.

## Verification

- `npx vitest run tests/unit/write-grant-repo.test.ts` (9 tests passed)
- `npx vitest run tests/unit/armed-transport-guard.test.ts` (6 tests passed)
- Full unit test suite (20 test files, 136 tests passed)

## Self-Check: PASSED
