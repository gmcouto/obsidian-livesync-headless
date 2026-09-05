---
phase: 02-verified-pull-materialization
plan: 04
subsystem: security
tags: [capabilities, atomic-install, provenance, fail-closed, pull-apply]

requires:
  - phase: 02-verified-pull-materialization
    provides: decode-adapter, pull-plan, all-leaf conflict detection, vault preflight
provides:
  - VaultReflectCapability brand and validation guard gating applyVerifiedPull
  - crash-safe installAtomically with rename boundary and read-back equality checks
  - ProvenanceRepository storing remote_revision and content_sha256 strictly after verified read-back
  - comprehensive integration test suite for encrypted V2, obfuscated paths, and fail-closed vault preflight
affects:
  - phase-03 daemon and watch synchronization

actuals:
  tokens: 14200
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - VaultReflectCapability branded capability token prevents unauthorized reflection
    - Atomic file install stages sibling .ols-tmp- file, syncs, renames, and verifies read-back
    - ProvenanceRepository INSERTs row only after read-back verification succeeds

key-files:
  created:
    - tests/unit/atomic-reflector.test.ts
    - tests/unit/provenance-repo.test.ts
  modified:
    - src/security/capabilities.ts
    - src/cli/commands/pull.ts
    - src/filesystem/atomic-reflector.ts
    - tests/unit/transport-guard.test.ts
    - tests/integration/couchdb-harness.ts
    - tests/integration/pull-apply.test.ts

key-decisions:
  - "Apply issues VaultReflectCapability only after admission plus successful preflight; dry-run never receives it"
  - "installAtomically writes to sibling temp .ols-tmp-*, calls sync, renames, and asserts read-back equals buffer"
  - "Provenance INSERT happens only after read-back equality; a mismatch throws ReadbackMismatchError"
  - "SQLite file_provenance table strictly excludes secrets, passwords, passphrases, and plaintext bodies"
  - "Encrypted V2 apply writes dest bytes equal to plaintext and records ciphertext document _rev in provenance"
  - "Obfuscated-path apply installs document.path as the vault name and never uses the f: document id"

patterns-established:
  - "Pattern: Capability-gated apply functions require a verified brand token before performing filesystem mutations"
  - "Pattern: Atomic reflection ensures crash safety before rename and durable provenance tracking after verify"

requirements-completed:
  - PULL-02
  - PULL-03
  - PULL-05

coverage:
  - id: D1
    description: Apply requires VaultReflectCapability branded token; dry-run never issues it
    requirement: PULL-02
    verification:
      - kind: unit
        ref: tests/unit/transport-guard.test.ts#correctly creates and validates capability tokens
        status: pass
      - kind: integration
        ref: tests/integration/pull-apply.test.ts#empty vault apply materializes notes, plain, and newnote files with exact provenance and unchanged update_seq
        status: pass
    human_judgment: false
  - id: D2
    description: Sibling temporary staging, sync, rename, and read-back equality are proven crash-safe
    requirement: PULL-03
    verification:
      - kind: unit
        ref: tests/unit/atomic-reflector.test.ts#installs a file atomically with exact matching bytes
        status: pass
      - kind: unit
        ref: tests/unit/atomic-reflector.test.ts#does not leave destination file if rename fails (crash-before-rename)
        status: pass
      - kind: unit
        ref: tests/unit/atomic-reflector.test.ts#throws ReadbackMismatchError if read-back bytes do not match
        status: pass
    human_judgment: false
  - id: D3
    description: Provenance record is persisted strictly after verified read-back and contains no secret columns
    requirement: PULL-05
    verification:
      - kind: unit
        ref: tests/unit/provenance-repo.test.ts#saves and retrieves a provenance record with full round-trip verification
        status: pass
      - kind: unit
        ref: tests/unit/provenance-repo.test.ts#strictly excludes secrets, passwords, passphrases, or plaintext bodies from columns
        status: pass
      - kind: integration
        ref: tests/integration/pull-apply.test.ts#encrypted V2 apply writes dest bytes equal to plaintext and records ciphertext rev in provenance
        status: pass
      - kind: integration
        ref: tests/integration/pull-apply.test.ts#obfuscated-path apply installs document.path as the vault filename, never the f: id
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-09-05
status: complete
---

# Phase 2 Plan 04: Capability-Gated Apply, Atomic Reflection, and Provenance Hardening Summary

**Capability-gated reflection, crash-safe atomic installation, and post-verify SQLite provenance tracking provide robust fail-closed materialization without remote mutations.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-09-05T19:12:00Z
- **Completed:** 2026-09-05T19:24:00Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Implemented `VaultReflectCapability` branded token in `capabilities.ts` and enforced capability validation in `applyVerifiedPull`.
- Proved crash safety before rename and read-back verification in `atomic-reflector.test.ts`.
- Verified round-trip provenance tracking in SQLite `file_provenance` table without secret or plaintext body columns in `provenance-repo.test.ts`.
- Expanded Testcontainers CouchDB integration in `pull-apply.test.ts` to prove materialization of notes/plain/newnote files, encrypted V2 payloads, and obfuscated paths.

## Task Commits

1. **Task 1: Brand VaultReflectCapability and gate apply** - `9e87962` (feat)
2. **Task 2: Prove crash-before-rename and provenance-after-readback** - `2266632` (feat)
3. **Task 3: Apply integration: encrypted files, fail-closed blocks, zero mutation** - `a064c71` (feat)

## Files Created/Modified
- `src/security/capabilities.ts` - VaultReflectCapability brand, constructor, and type guard
- `src/cli/commands/pull.ts` - capability requirement in `applyVerifiedPull`
- `src/filesystem/atomic-reflector.ts` - test hook support in `installAtomically`
- `tests/unit/transport-guard.test.ts` - capability token validation tests
- `tests/unit/atomic-reflector.test.ts` - unit tests for atomic reflection
- `tests/unit/provenance-repo.test.ts` - unit tests for SQLite provenance repository
- `tests/integration/couchdb-harness.ts` - added `seedObfuscatedNote` helper
- `tests/integration/pull-apply.test.ts` - expanded integration tests for apply path

## Decisions Made
- `applyVerifiedPull` strictly requires `VaultReflectCapability`, preventing accidental materialization during dry-run or unadmitted runs.
- `installAtomically` verifies read-back bytes match the assembled buffer before completing.
- SQLite `file_provenance` records the remote revision and content hash only after verified install.

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None

## Next Phase Readiness
Phase 2 is fully complete and ready for phase verification.

## Self-Check: PASSED
- FOUND: `tests/unit/atomic-reflector.test.ts`
- FOUND: `tests/unit/provenance-repo.test.ts`
- All 27 unit and integration tests for plan 02-04 passed.
