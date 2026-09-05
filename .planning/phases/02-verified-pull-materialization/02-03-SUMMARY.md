---
phase: 02-verified-pull-materialization
plan: 03
subsystem: livesync
tags: [conflicts, all-leaf, path-policy, vault-preflight, dedicated, pull-apply]

requires:
  - phase: 02-verified-pull-materialization
    provides: decode-adapter, pull-plan, dry-run tracer
provides:
  - all-leaf conflict discovery via GET ?conflicts=true and open revs
  - CONFLICT_LEAVES block action preventing CouchDB winner materialization
  - vault-relative path policy with traversal, reserved flag names, and case-fold collision detection
  - vault preflight for empty vaults or dedicated vaults with unproven file protection
  - dedicated boolean option in VaultConfigSchema (default: false)
  - integration test demonstrating exit 8 on live leaf conflicts without writing files
affects:
  - 02-04 apply capability and atomic reflection

actuals:
  tokens: 15400
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - Path policy asserts safe vault paths and filters reserved flag files
    - Vault preflight checks empty vs dedicated vault before apply
    - Inventory fetches ?conflicts=true and enumerates all live non-deleted leaves

key-files:
  created:
    - src/domain/path-policy.ts
    - src/filesystem/vault-preflight.ts
    - tests/unit/path-policy.test.ts
    - tests/unit/vault-preflight.test.ts
    - tests/integration/pull-apply.test.ts
  modified:
    - src/livesync/inspector.ts
    - src/livesync/inventory.ts
    - src/livesync/decode-adapter.ts
    - src/domain/pull-plan.ts
    - src/config/schema.ts
    - src/cli/commands/pull.ts
    - tests/unit/inspector.test.ts
    - tests/unit/pull-plan.test.ts
    - tests/unit/config.test.ts
    - tests/integration/couchdb-harness.ts

key-decisions:
  - "Every candidate note is fetched with conflicts=true; if _conflicts is non-empty, every live non-deleted leaf body is fetched and the path is blocked"
  - "A document whose only leaves are logical deletes yields skip-logical-delete, not create"
  - "When handleFilenameCaseSensitive is false, two remote paths that case-fold to the same string both block"
  - "validateStoragePath rejects traversal, absolute paths, and unsafe symlinks via lstat"
  - "vault.dedicated default false requires a vault with zero files; dedicated true blocks unproven local files"

patterns-established:
  - "Pattern: preflightVault runs before applyVerifiedPull and fail-closes on any unproven or colliding local file"
  - "Pattern: conflict leaves yield exit code 8 (CONFLICT) without writing winner files"

requirements-completed:
  - COMP-06
  - PULL-07
  - PULL-02

coverage:
  - id: D1
    description: Candidate notes are fetched with conflicts=true; non-empty _conflicts causes all leaves to be fetched and blocks the path
    requirement: COMP-06
    verification:
      - kind: unit
        ref: tests/unit/inspector.test.ts#fetchDocumentIfExists appends conflicts=true and other query params to the document URL
        status: pass
      - kind: unit
        ref: tests/unit/pull-plan.test.ts#blocks two live non-deleted leaves for the same path as CONFLICT_LEAVES
        status: pass
      - kind: integration
        ref: tests/integration/pull-apply.test.ts#two live leaves exit CONFLICT 8 and leave the destination missing
        status: pass
    human_judgment: false
  - id: D2
    description: Traversal, absolute, drive-letter, backslash, reserved flag names, and case-fold collisions are blocked or skipped
    requirement: PULL-07
    verification:
      - kind: unit
        ref: tests/unit/path-policy.test.ts#rejects traversal, absolute, drive-letter, and backslash paths
        status: pass
      - kind: unit
        ref: tests/unit/path-policy.test.ts#treats reserved LiveSync flag names and livesync_log_ prefixes as ignored
        status: pass
      - kind: unit
        ref: tests/unit/path-policy.test.ts#finds case-fold collision pairs when caseInsensitive is true
        status: pass
    human_judgment: false
  - id: D3
    description: Empty or dedicated vault preflight verifies vault state and protects unproven local files
    requirement: PULL-02
    verification:
      - kind: unit
        ref: tests/unit/vault-preflight.test.ts#accepts an empty vault when dedicated is false
        status: pass
      - kind: unit
        ref: tests/unit/vault-preflight.test.ts#fails when dedicated is false and the vault contains any file
        status: pass
      - kind: unit
        ref: tests/unit/vault-preflight.test.ts#blocks an existing file without a provenance row when dedicated is true
        status: pass
      - kind: unit
        ref: tests/unit/config.test.ts#accepts vault.dedicated true and rejects an unknown vault key
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-09-05
status: complete
---

# Phase 2 Plan 03: All-Leaf Conflict Detection, Path Safety, and Dedicated Vault Preflight Summary

**All-leaf conflict detection, vault path safety policy, and empty/dedicated vault preflight ensure pull fails closed instead of writing partial, conflicting, or unproven local vault content.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-09-05T19:00:00Z
- **Completed:** 2026-09-05T19:12:00Z
- **Tasks:** 3
- **Files modified:** 14

## Accomplishments
- Implemented all-leaf conflict query (`?conflicts=true` and `rev` fetching) in `inventory.ts` and `inspector.ts`.
- Added `CONFLICT_LEAVES` block in `pull-plan.ts` without merging or selecting CouchDB winners.
- Implemented safe vault path validation, reserved flag file filtering (`redflag*.md`, `flag_*.md`, `livesync_log_*`), and case-fold collision detection in `path-policy.ts`.
- Added `dedicated` boolean setting to `VaultConfigSchema` (default `false`) and `preflightVault` checks in `vault-preflight.ts`.
- Proved with Testcontainers CouchDB integration that conflicting live leaves return exit code 8 (`CONFLICT`) and leave the local vault untouched.

## Task Commits

1. **Task 1: All-leaf inventory and conflict blocks** - `a1b5954` (feat)
2. **Task 2: Vault-relative path policy and reserved names** - `b2cf6bc` (test / RED), `30adf08` (feat / GREEN)
3. **Task 3: Empty or dedicated vault preflight and schema flag** - `27eece4` (test / RED), `26c5c70` (feat / GREEN)

## Files Created/Modified
- `src/livesync/inspector.ts` - query params support on `fetchDocumentIfExists`
- `src/livesync/inventory.ts` - `fetchNoteLeaves` with `?conflicts=true`
- `src/livesync/decode-adapter.ts` - named re-exports of path validation and flag constants
- `src/domain/path-policy.ts` - path safety, reserved names, and case-fold collision detection
- `src/filesystem/vault-preflight.ts` - empty vault and dedicated vault preflight checks
- `src/domain/pull-plan.ts` - `CONFLICT_LEAVES` block action
- `src/config/schema.ts` - `vault.dedicated` boolean schema
- `src/cli/commands/pull.ts` - preflight integration and fail-closed exit handling
- `tests/unit/path-policy.test.ts` - unit tests for path policy
- `tests/unit/vault-preflight.test.ts` - unit tests for vault preflight
- `tests/unit/config.test.ts` - config schema tests for `vault.dedicated`
- `tests/unit/inspector.test.ts` - inspector query param tests
- `tests/unit/pull-plan.test.ts` - conflict leaf tests
- `tests/integration/couchdb-harness.ts` - conflicting legacy note seeding helper
- `tests/integration/pull-apply.test.ts` - conflict exit 8 integration test

## Decisions Made
- Every note is fetched with `?conflicts=true` and conflict leaves are retrieved individually.
- Two or more live non-deleted leaves for a path generate `CONFLICT_LEAVES` and fail apply with exit code 8.
- Dedicated vault option defaults to `false` and blocks unproven files when `true`.

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None

## Next Phase Readiness
Ready for `02-04` (apply path hardening, atomic reflector capability gating, provenance-after-verify).

## Self-Check: PASSED
- FOUND: `src/domain/path-policy.ts`
- FOUND: `src/filesystem/vault-preflight.ts`
- FOUND: `tests/unit/path-policy.test.ts`
- FOUND: `tests/unit/vault-preflight.test.ts`
- FOUND: `tests/integration/pull-apply.test.ts`
- All 47 unit and integration tests passed.
