---
phase: 02-verified-pull-materialization
plan: 01
subsystem: cli
tags: [pull, dry-run, livesync, couchdb, sqlite, commonlib]

requires:
  - phase: 01-guarded-remote-admission
    provides: inspect coordinator, GET/HEAD transport guard, negotiation, zero-mutation sandwich
provides:
  - pull --dry-run CLI path that inventories CouchDB over GET and reports planned local actions
  - Commonlib 0.1.21 decode adapter for unencrypted legacy notes
  - Atomic vault install plus file_provenance migration 2
  - Adopted remote path/case/dynamic-iteration tweaks for pull admission
  - OutcomeCategory.CONFLICT exit code 8
affects:
  - 02-02 encryption and chunk decode
  - 02-03 conflict and all-leaf inventory
  - 02-04 apply gates and path safety

actuals:
  tokens: 14162
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - inspect-shaped pull coordinator with ReadCapability and zero-mutation sandwich
    - Commonlib decode isolated in one adapter
    - provenance-after-readback

key-files:
  created:
    - src/cli/commands/pull.ts
    - src/livesync/inventory.ts
    - src/livesync/decode-adapter.ts
    - src/domain/pull-plan.ts
    - src/filesystem/atomic-reflector.ts
    - src/storage/provenance-repo.ts
    - tests/unit/pull-plan.test.ts
    - tests/integration/pull-dry-run.test.ts
  modified:
    - src/cli/index.ts
    - src/diagnostics/outcomes.ts
    - src/diagnostics/formatters.ts
    - src/livesync/negotiation.ts
    - src/storage/sqlite.ts
    - tests/unit/smoke.test.ts
    - tests/unit/negotiation.test.ts
    - tests/integration/couchdb-harness.ts

key-decisions:
  - "Isolate Commonlib 0.1.21 imports in decode-adapter.ts; pull-plan stays Commonlib-free"
  - "Adopt remote usePathObfuscation, useDynamicIterationCount, and handleFilenameCaseSensitive instead of INCOMPATIBLE_TWEAK"
  - "Dry-run issues createReadCapability only and never opens vault writes or file_provenance"
  - "Apply writes provenance only after installAtomically read-back succeeds"

patterns-established:
  - "Pattern: pull coordinator copies inspect loadConfig → guarded GET/HEAD → probe → negotiate → inventory/plan sandwich"
  - "Pattern: pull_report JSON Lines with size/sha256 and no assembled bytes"
  - "Pattern: SQLite migration 2 file_provenance after verified reflection"

requirements-completed:
  - PULL-01
  - COMP-01
  - PULL-02
  - PULL-03
  - PULL-05

coverage:
  - id: D1
    description: Operator can run pull --dry-run and receive a finite pull_report of planned local actions
    requirement: PULL-01
    verification:
      - kind: unit
        ref: tests/unit/pull-plan.test.ts#creates a create action for one decoded notes leaf that is not deleted
        status: pass
      - kind: integration
        ref: tests/integration/pull-dry-run.test.ts#dry-run previews one legacy notes file without mutating CouchDB, vault, or provenance
        status: pass
    human_judgment: false
  - id: D2
    description: Dry-run leaves CouchDB update_seq, vault files, and file_provenance unchanged
    requirement: PULL-01
    verification:
      - kind: integration
        ref: tests/integration/pull-dry-run.test.ts#dry-run previews one legacy notes file without mutating CouchDB, vault, or provenance
        status: pass
    human_judgment: false
  - id: D3
    description: Supported note types for planning are Commonlib NoteTypes; chunks and versioninfo are skip-special
    requirement: COMP-01
    verification:
      - kind: unit
        ref: tests/unit/pull-plan.test.ts#skips leaf and versioninfo documents as skip-special
        status: pass
    human_judgment: false
  - id: D4
    description: Path/case/dynamic-iteration remote tweaks admit; encrypt mismatch still blocks
    requirement: COMP-01
    verification:
      - kind: unit
        ref: tests/unit/negotiation.test.ts#adopts remote path, case, and dynamic-iteration tweaks for pull
        status: pass
    human_judgment: false
  - id: D5
    description: CONFLICT is exit 8; inspect remains the default command
    verification:
      - kind: unit
        ref: tests/unit/smoke.test.ts#exports expected outcome categories and exit codes
        status: pass
      - kind: integration
        ref: tests/integration/inspect-command.test.ts
        status: pass
    human_judgment: false
  - id: D6
    description: Apply of a valid all-create plan on an empty vault installs bytes then records file_provenance
    requirement: PULL-02
    verification:
      - kind: integration
        ref: tests/integration/pull-dry-run.test.ts#applies a valid all-create plan to an empty vault and records provenance without mutating CouchDB
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-09-03
status: complete
---

# Phase 2 Plan 01: Dry-run Pull Tracer Summary

**Finite `pull --dry-run` inventories a CouchDB LiveSync database over GET, decodes one unencrypted legacy `notes` file, and prints a `pull_report` without mutating CouchDB, the vault, or provenance.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-09-03T17:44:25Z
- **Completed:** 2026-09-03T17:52:17Z
- **Tasks:** 3
- **Files modified:** 16

## Accomplishments
- Runnable `pull --dry-run` CLI path that reuses Phase 1 admission, GET/HEAD transport, and zero-mutation snapshots
- Commonlib 0.1.21 decode adapter for unencrypted `notes` plus a pure `buildPullPlan` that never issues remote writes
- Atomic sibling-temp install, SQLite `file_provenance` migration 2, and Testcontainers proof that apply still leaves `update_seq` unchanged
- Remote path/case/dynamic-iteration tweaks now admit for pull; encrypt mismatch still fails closed
- `OutcomeCategory.CONFLICT` is exit 8; omitted command still dispatches inspect

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end pull --dry-run of one unencrypted legacy notes file** - `87c9397` (feat)
2. **Task 2: Adopt remote path, case, and dynamic-iteration tweaks for pull admission** - `5f32704` (test / RED), `32e1811` (feat / GREEN)
3. **Task 3: Reserve CONFLICT diagnostics and keep inspect default** - `d613f10` (feat)

**Plan metadata:** pending docs commit

_Note: TDD Task 2 produced RED then GREEN commits_

## Files Created/Modified
- `src/cli/commands/pull.ts` - `runPullCommand` / `applyVerifiedPull` coordinator
- `src/cli/index.ts` - `pull` command, `--dry-run`, inspect remains default
- `src/livesync/inventory.ts` - paginated GET `/_all_docs` plus per-id GET
- `src/livesync/decode-adapter.ts` - Commonlib 0.1.21 path/id and legacy notes decode
- `src/domain/pull-plan.ts` - pure `buildPullPlan` and byte-free serialization
- `src/diagnostics/outcomes.ts` - `CONFLICT` exit 8
- `src/diagnostics/formatters.ts` - `formatPullHumanReport` / `formatPullJsonLinesReport`
- `src/livesync/negotiation.ts` - adopt path/case/dynamic-iteration tweaks
- `src/filesystem/atomic-reflector.ts` - temp + sync + rename + read-back
- `src/storage/sqlite.ts` - schema version 2 / `file_provenance`
- `src/storage/provenance-repo.ts` - `saveProvenance` / `getByPath`
- `tests/unit/smoke.test.ts` - CONFLICT, parse `pull --dry-run`, missing-config
- `tests/unit/pull-plan.test.ts` - create / skip-special / serialize
- `tests/unit/negotiation.test.ts` - tweak adoption
- `tests/integration/couchdb-harness.ts` - `seedLegacyNote`
- `tests/integration/pull-dry-run.test.ts` - dry-run and apply Testcontainers proof

## Decisions Made
- Keep Commonlib `compat/*` imports inside `decode-adapter.ts` only; domain planner uses string note-type constants so application code does not take a compatibility dependency.
- Treat `usePathObfuscation`, `useDynamicIterationCount`, and `handleFilenameCaseSensitive` as adopted remote settings rather than blockers, matching Commonlib `IncompatibleChanges` semantics (clients must not disagree; the headless client must follow the remote).
- Dry-run never opens SQLite for provenance and never writes vault files; apply on an empty vault is the single architectural proof that install + provenance ordering works.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TypeScript FileHandle read-back and Commonlib branded path**
- **Found during:** Task 1 (TypeScript check)
- **Issue:** `readFile` returned `NonSharedBuffer` incompatible with `Uint8Array`, and `path2id_base` required `FilePathWithPrefix`
- **Fix:** Wrap read-back in `new Uint8Array(...)` and cast the document path through `Parameters<typeof path2id_base>[0]`
- **Files modified:** `src/filesystem/atomic-reflector.ts`, `src/livesync/decode-adapter.ts`
- **Verification:** `npx tsc --noEmit` passed
- **Committed in:** `87c9397` (Task 1)

**2. [Rule 2 - Missing Critical] Domain planner must not import Commonlib**
- **Found during:** Task 1 (AGENTS.md Commonlib isolation)
- **Issue:** First `pull-plan.ts` draft imported `EntryTypes` / `NoteTypes` from Commonlib, violating the single-adapter rule
- **Fix:** Classify supported note types with local string constants; Commonlib remains in `decode-adapter.ts` only
- **Files modified:** `src/domain/pull-plan.ts`
- **Verification:** `grep DirectFileManipulator` on pull/inventory/decode/plan is 0; unit tests pass
- **Committed in:** `87c9397` (Task 1)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing critical)
**Impact on plan:** Required for TypeScript compile and AGENTS.md compatibility isolation. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
Ready for `02-02` (encryption, chunks, and remaining note types). Tracer covers unencrypted legacy `notes` only; `plain` / `newnote` / E2EE remain later-plan work. Inspect integration tests stayed green.

## TDD Gate Compliance
Task 2 (`type: tdd` task) produced RED `test(02-01)` (`5f32704`) then GREEN `feat(02-01)` (`32e1811`). No REFACTOR commit was needed.

## Self-Check: PASSED

- FOUND: `src/cli/commands/pull.ts`
- FOUND: `src/livesync/inventory.ts`
- FOUND: `src/livesync/decode-adapter.ts`
- FOUND: `src/domain/pull-plan.ts`
- FOUND: `src/filesystem/atomic-reflector.ts`
- FOUND: `src/storage/provenance-repo.ts`
- FOUND: `tests/unit/pull-plan.test.ts`
- FOUND: `tests/integration/pull-dry-run.test.ts`
- FOUND: commit `87c9397`
- FOUND: commit `5f32704`
- FOUND: commit `32e1811`
- FOUND: commit `d613f10`

---
*Phase: 02-verified-pull-materialization*
*Completed: 2026-09-03*
