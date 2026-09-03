---
phase: 01-guarded-read-only-admission
plan: "03"
subsystem: cli
tags: [negotiation, syncinfo, hkdf, sqlite, diagnostics, inspect, exit-codes]

requires:
  - phase: 01-guarded-read-only-admission
    provides: Guarded HTTP transport and zero-mutation CouchDB protocol inspector
provides:
  - LiveSync compatibility negotiation with version/lock gates and tweak adoption
  - Web Crypto HKDF and AES-GCM syncinfo decryption and passphrase authentication
  - Durable SQLite admission repository recording admission metadata outside vault
  - Human-readable terminal and JSON Lines report formatters
  - End-to-end CLI inspect coordinator with standardized numeric exit codes
affects:
  - 01-guarded-read-only-admission
  - 02-verified-pull
  - 03-recoverable-pull

actuals:
  tokens: 21500
  tasks: 3
  commits: 3

tech-stack:
  added:
    - "node:sqlite (built-in DatabaseSync)"
  patterns:
    - "Fail-closed negotiation on unsupported LiveSync protocol version (>12) or unknown remote tweaks"
    - "Passphrase verification via Web Crypto HKDF / PBKDF2 without persisting plain secrets"
    - "SQLite schema migration and WAL mode initialization outside the vault path"
    - "Standardized outcome categories mapping 1-to-1 with numeric CLI exit codes"

key-files:
  created:
    - src/livesync/negotiation.ts
    - src/livesync/syncinfo.ts
    - src/storage/sqlite.ts
    - src/storage/admission-repo.ts
    - src/diagnostics/formatters.ts
    - src/cli/commands/inspect.ts
    - tests/unit/negotiation.test.ts
    - tests/characterization/commonlib-crypto.test.ts
    - tests/unit/admission-repo.test.ts
    - tests/integration/inspect-command.test.ts
  modified:
    - src/diagnostics/outcomes.ts
    - src/livesync/zero-mutation.ts
    - src/cli/index.ts
    - src/index.ts

key-decisions:
  - "Reject remote preferred settings unknown to the client (UNKNOWN_REMOTE_SETTING) to fail closed"
  - "Durably persist admission metadata strictly in SQLite outside the vault directory with no secret columns"
  - "Produce identical structured reports for both successful admission and classified blocker failures"

patterns-established:
  - "AdmissionRepository stores remote fingerprint, settings hash, marker revisions, and update_seq transactionally"
  - "runInspectCommand acts as the central coordinator combining zero-mutation verification, inspection, negotiation, and storage"

requirements-completed:
  - CONF-05
  - CONF-06
  - SAFE-06

coverage:
  - id: D1
    description: "LiveSync compatibility negotiation evaluating version <= 12, lock status, and tweak adoption"
    requirement: "CONF-05"
    verification:
      - kind: unit
        ref: "tests/unit/negotiation.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Cryptographic syncinfo authentication using Web Crypto HKDF and remote PBKDF2 salt"
    requirement: "CONF-05"
    verification:
      - kind: unit
        ref: "tests/characterization/commonlib-crypto.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Durable SQLite admission storage outside vault directory with secret exclusion"
    requirement: "CONF-06"
    verification:
      - kind: unit
        ref: "tests/unit/admission-repo.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "CLI inspect coordinator with stable human and JSON Lines reports and standardized exit codes"
    requirement: "SAFE-06"
    verification:
      - kind: integration
        ref: "tests/integration/inspect-command.test.ts"
        status: pass
    human_judgment: false

duration: 15 min
completed: 2026-09-03
status: complete
---

# Phase 1 Plan 03: LiveSync Compatibility Negotiation, SQLite Admission Storage, Report Formatters, and CLI Inspect Command Summary

**Implemented compatibility negotiation, Web Crypto HKDF syncinfo verification, durable SQLite admission storage, stable report formatters, and the complete CLI inspect coordinator with verified exit codes.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-09-03T10:26:20Z
- **Completed:** 2026-09-03T10:41:20Z
- **Tasks:** 3
- **Files modified:** 14

## Accomplishments
- Implemented `negotiateCompatibility` in `src/livesync/negotiation.ts` enforcing protocol version gates (VER <= 12), lock checks, unknown setting lockout (`UNKNOWN_REMOTE_SETTING`), and tweak adoption for `hashAlg`, `customChunkSize`, and `chunkSplitterVersion`.
- Implemented `verifySyncinfo` in `src/livesync/syncinfo.ts` supporting Web Crypto HKDF and AES-GCM decryption against remote PBKDF2 salts.
- Implemented transactional SQLite admission persistence in `src/storage/sqlite.ts` and `src/storage/admission-repo.ts` with WAL mode and strict exclusion of secrets from tables and columns.
- Implemented terminal and JSON Lines report formatters in `src/diagnostics/formatters.ts` displaying fingerprint, settings hash, admitted/unsupported capabilities, adopted tweaks, zero-mutation verification proof, and blockers.
- Built end-to-end `runInspectCommand` coordinator in `src/cli/commands/inspect.ts` and wired into `src/cli/index.ts`.
- Validated with 77 passing tests across 10 test files including real CouchDB 3.5.2.1 integration tests covering all 8 exit codes.

## Task Commits

Each task was committed atomically:

1. **Task 1: LiveSync Compatibility Negotiation and Cryptographic Syncinfo Verification** - `cf13b0d` (feat)
2. **Task 2: Durable SQLite Admission Store** - `9f07c0a` (feat)
3. **Task 3: CLI Inspect Coordinator, Stable Output Formatters, and Exit Diagnostics** - `0605433` (feat)

**Plan metadata:** pending commit (docs: complete plan)

## Files Created/Modified
- `src/livesync/negotiation.ts` - Tweak evaluation and compatibility negotiation
- `src/livesync/syncinfo.ts` - Web Crypto HKDF syncinfo authentication
- `src/storage/sqlite.ts` - SQLite database initialization and migrations
- `src/storage/admission-repo.ts` - Transactional admission record persistence
- `src/diagnostics/formatters.ts` - Human and JSON Lines report formatters
- `src/diagnostics/outcomes.ts` - Runtime OutcomeCategory object and exit codes
- `src/livesync/zero-mutation.ts` - Added typed error handling for admission snapshots
- `src/cli/commands/inspect.ts` - End-to-end inspect command coordinator
- `src/cli/index.ts` - Wired inspect command to CLI entrypoint
- `src/index.ts` - Barrel exports for all modules
- `tests/unit/negotiation.test.ts` - Unit tests for negotiation gates
- `tests/characterization/commonlib-crypto.test.ts` - Characterization tests for Web Crypto HKDF
- `tests/unit/admission-repo.test.ts` - Unit tests for SQLite admission repository
- `tests/integration/inspect-command.test.ts` - Integration tests against real CouchDB covering all exit codes

## Decisions Made
- Disallowed unknown remote preferred settings by failing closed with `UNKNOWN_REMOTE_SETTING` and exit code 3 (`INCOMPATIBLE`).
- Stored admission records in SQLite outside the vault directory, ensuring synchronized notes cannot alter admission state.
- Modeled `OutcomeCategory` as both a TypeScript type and runtime const object so formatters and CLI coordinators share exact constants.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] OutcomeCategory runtime availability**
- **Found during:** Task 3 (Integration tests)
- **Issue:** `OutcomeCategory` was defined purely as a TypeScript union type, causing `OutcomeCategory.SUCCESS` to evaluate to undefined at runtime.
- **Fix:** Exported `OutcomeCategory` as a const object alongside its union type.
- **Files modified:** `src/diagnostics/outcomes.ts`
- **Verification:** Integration tests successfully resolved outcome properties.
- **Committed in:** `0605433`

**2. [Rule 1 - Bug] Typed errors from ZeroMutationVerifier.captureSnapshot**
- **Found during:** Task 3 (Integration tests)
- **Issue:** `captureSnapshot` threw generic errors on 401/404, causing `inspect.ts` to fall through to `CORRUPTION` instead of `AUTHENTICATION_ERROR` or `NOT_FOUND`.
- **Fix:** Updated `captureSnapshot` to throw typed `AuthenticationRequiredError` and `DatabaseNotFoundError`.
- **Files modified:** `src/livesync/zero-mutation.ts`
- **Verification:** `inspect-command.test.ts` verified exit code 2 and 4 on auth and 404 conditions.
- **Committed in:** `0605433`

---

**Total deviations:** 2 auto-fixed (2 bug fixes)
**Impact on plan:** None. All acceptance criteria and exit codes fully verified.

## Issues Encountered
None.

## User Setup Required
None.

## Next Phase Readiness
Phase 1 (Guarded Read-Only Admission) is complete across all 3 plans. Ready for Phase 2 (Verified Pull).
