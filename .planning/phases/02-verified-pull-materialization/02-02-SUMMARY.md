---
phase: 02-verified-pull-materialization
plan: 02
subsystem: livesync
tags: [e2ee, chunks, path-identity, commonlib, pull, dry-run]

requires:
  - phase: 02-verified-pull-materialization
    provides: pull --dry-run tracer, Commonlib decode adapter for unencrypted notes, adopted path/case tweaks
provides:
  - V1 and V2 decrypt through decode-adapter with admission PBKDF2 salt
  - path2id identity and reserved-id classification (h:/h:+ chunks, f: notes)
  - chunk assembly with missing-child and size-mismatch blockers
  - pull-plan DecodeFailure blocks with suggestions
  - dry-run coverage for encrypted V2, chunked plain, and newnote
affects:
  - 02-03 conflict and all-leaf inventory
  - 02-04 apply gates and path safety

actuals:
  tokens: 12638
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - Commonlib/octagonal decrypt isolated in decode-adapter.ts
    - DecodeFailure mapped to pull-plan blocks without I/O
    - GET-only fetchChunk supplied by inventory

key-files:
  created:
    - tests/characterization/commonlib-path.test.ts
    - tests/characterization/commonlib-decode.test.ts
    - tests/characterization/commonlib-enumerate-ranges.test.ts
  modified:
    - src/livesync/decode-adapter.ts
    - src/domain/pull-plan.ts
    - src/cli/commands/pull.ts
    - src/livesync/inventory.ts
    - tests/unit/pull-plan.test.ts
    - tests/integration/couchdb-harness.ts
    - tests/integration/pull-dry-run.test.ts

key-decisions:
  - "Compose incoming decrypt with octagonal-wheels decrypt/decryptHkdf; getConfiguredFunctionsForEncryption is not a published export"
  - "Import PREFIX_* from compat/common/types because compat shared.const does not export ID prefixes"
  - "Same encryptionPassphrase is used for decrypt and path2id_base obfuscation"
  - "Read encrypt/E2EEAlgorithm from preferred tweaks in pull rather than adding E2EEAlgorithm to negotiation recognized keys"

patterns-established:
  - "Pattern: decryptIncomingDocument + assembleChunks + verifyPathIdentity stay in decode-adapter.ts"
  - "Pattern: observationFromDecodeFailure produces block actions with suggestion"
  - "Pattern: inventory createChunkFetcher is GET-only and never constructs SyncParamsHandler"

requirements-completed:
  - COMP-01
  - COMP-02
  - COMP-03
  - COMP-04
  - COMP-05

coverage:
  - id: D1
    description: Authenticated decrypt failures become typed blocks; the path is not materialized
    requirement: COMP-02
    verification:
      - kind: unit
        ref: tests/characterization/commonlib-decode.test.ts#fails closed with a Passphrase authentication error on the wrong passphrase
        status: pass
      - kind: integration
        ref: tests/integration/pull-dry-run.test.ts#wrong-passphrase dry-run exits 2 or 7 with a block and writes zero vault files
        status: pass
    human_judgment: false
  - id: D2
    description: E2EE V2 and legacy V1 reads succeed with admission salt; unknown algorithm is INCOMPATIBLE
    requirement: COMP-02
    verification:
      - kind: unit
        ref: tests/characterization/commonlib-decode.test.ts#decrypts V2 HKDF ciphertext produced with the admission salt
        status: pass
      - kind: unit
        ref: tests/characterization/commonlib-decode.test.ts#decrypts empty-string V1 ciphertext to the original payload
        status: pass
      - kind: unit
        ref: tests/characterization/commonlib-decode.test.ts#treats unknown algorithm string 'v9' as INCOMPATIBLE without attempting decrypt
        status: pass
    human_judgment: false
  - id: D3
    description: Filename identity uses Commonlib path2id_base; vault names come from decrypted path, never f: ids
    requirement: COMP-03
    verification:
      - kind: unit
        ref: tests/characterization/commonlib-path.test.ts#yields an f: document id when obfuscatePassphrase is set
        status: pass
      - kind: unit
        ref: tests/characterization/commonlib-path.test.ts#decodes an obfuscated leaf using the document path, never the f: id as a vault name
        status: pass
    human_judgment: false
  - id: D4
    description: Every children chunk is fetched and assembled; missing chunk or size mismatch blocks
    requirement: COMP-04
    verification:
      - kind: unit
        ref: tests/characterization/commonlib-decode.test.ts#assembles children in order and fails closed on a missing chunk
        status: pass
      - kind: unit
        ref: tests/characterization/commonlib-decode.test.ts#fails assembleChunks when concatenated byteLength does not match metadata size
        status: pass
      - kind: integration
        ref: tests/integration/pull-dry-run.test.ts#dry-run lists encrypted V2 notes, chunked plain, and newnote as create with byteLength
        status: pass
    human_judgment: false
  - id: D5
    description: notes, plain, and newnote decode to create; reserved h:/h:+ ids are chunks
    requirement: COMP-01
    verification:
      - kind: unit
        ref: tests/unit/pull-plan.test.ts#creates notes, plain, and newnote payloads and skips logical deletes
        status: pass
      - kind: unit
        ref: tests/characterization/commonlib-enumerate-ranges.test.ts#classifies h: and h:+ prefixes as chunks, matching DFM skip ranges
        status: pass
    human_judgment: false
  - id: D6
    description: Metadata-identity, decrypt, chunk, size, and unsupported-shape failures become plan blocks
    requirement: COMP-05
    verification:
      - kind: unit
        ref: tests/unit/pull-plan.test.ts#maps a decrypt failure observation to a block naming decrypt or authentication
        status: pass
      - kind: unit
        ref: tests/unit/pull-plan.test.ts#blocks missing chunks and size mismatches without creating files
        status: pass
      - kind: unit
        ref: tests/unit/pull-plan.test.ts#blocks path identity and unsupported document shape failures
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-09-03
status: complete
---

# Phase 2 Plan 02: Encryption, Chunks, and Note-Type Decode Summary

**Characterization-proven decode adapter decrypts V1/V2 LiveSync documents with the admission PBKDF2 salt, verifies path2id identity (including obfuscated f: ids), assembles children chunks, and maps every validation failure to a pull-plan block.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-09-03T17:55:00Z
- **Completed:** 2026-09-03T18:05:29Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments
- `decryptIncomingDocument`, `assembleChunks`, `verifyPathIdentity`, and `classifyDocumentId` in the Commonlib 0.1.21 adapter
- Named wrappers for `validateStoragePath` and `shouldBeIgnored` so later path-policy never imports Commonlib
- Pure `observationFromDecodeFailure` maps decode/shape failures to block actions with suggestions
- Dry-run integration covers encrypted V2 notes plus chunked `plain` and `newnote`, and blocks a wrong passphrase without writing vault files

## Task Commits

Each task was committed atomically:

1. **Task 1: Decrypt, path identity, and chunk assembly in the decode adapter** - `e29dd87` (test / RED), `dd88890` (feat / GREEN)
2. **Task 2: Map decode and shape failures to pull-plan block actions** - `569afe8` (test / RED), `973e884` (feat / GREEN)
3. **Task 3: Wire adopted encrypt and chunk settings into pull and seed fixtures** - `c56aac8` (feat)

**Plan metadata:** pending docs commit

_Note: TDD Tasks 1 and 2 produced RED then GREEN commits_

## Files Created/Modified
- `src/livesync/decode-adapter.ts` - V1/V2 decrypt, path identity, chunk assembly, reserved-id classify
- `src/domain/pull-plan.ts` - `observationFromDecodeFailure` and block suggestions
- `src/cli/commands/pull.ts` - adopted encrypt/path/salt settings plus GET fetchChunk
- `src/livesync/inventory.ts` - `createChunkFetcher` over `fetchDocumentIfExists`
- `tests/characterization/commonlib-path.test.ts` - path2id, underscore, obfuscated f: ids
- `tests/characterization/commonlib-decode.test.ts` - V1/V2 decrypt, wrong passphrase, chunks
- `tests/characterization/commonlib-enumerate-ranges.test.ts` - h:/h:+ chunk classification
- `tests/unit/pull-plan.test.ts` - decrypt/chunk/size/path/shape blocks and three note types
- `tests/integration/couchdb-harness.ts` - encrypted V2, chunked plain, and newnote seeds
- `tests/integration/pull-dry-run.test.ts` - encrypted/chunked create and wrong-passphrase block

## Decisions Made
- Compose decrypt with the same octagonal-wheels `decrypt` / `decryptHkdf` functions used by `syncinfo.ts` because `getConfiguredFunctionsForEncryption` is not a published package export.
- Import `PREFIX_CHUNK`, `PREFIX_ENCRYPTED_CHUNK`, and `PREFIX_OBFUSCATED` from `compat/common/types`.
- Use one resolved `encryptionPassphrase` for both decrypt and `path2id_base` obfuscation.
- Default decode algorithm to `v2` when remote `encrypt` is true and `E2EEAlgorithm` is absent from recognized tweaks.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ID prefixes are not on compat shared.const**
- **Found during:** Task 1 GREEN
- **Issue:** `@vrtmrz/livesync-commonlib/compat/common/models/shared.const` does not export `PREFIX_CHUNK` / `PREFIX_OBFUSCATED` (those live on `shared.const.behabiour` and are re-exported from `compat/common/types`)
- **Fix:** Import prefixes from `compat/common/types` in the adapter and the enumerate-range characterization test
- **Files modified:** `src/livesync/decode-adapter.ts`, `tests/characterization/commonlib-enumerate-ranges.test.ts`
- **Verification:** characterization suite 21/21 passed
- **Committed in:** `dd88890` (Task 1 GREEN)

**2. [Rule 2 - Missing Critical] Encrypt/algorithm settings are not adopted onto negotiatedSettings**
- **Found during:** Task 3
- **Issue:** Matching remote `encrypt` is not written into `negotiatedSettings`, and `E2EEAlgorithm` is an unrecognized tweak that would fail admission
- **Fix:** `decodeOptionsFromAdmission` reads `encrypt` / `E2EEAlgorithm` from preferred tweaks and defaults algorithm to `v2` when encrypt is on; seeds never put `E2EEAlgorithm` on the milestone
- **Files modified:** `src/cli/commands/pull.ts`, `tests/integration/couchdb-harness.ts`
- **Verification:** encrypted V2 dry-run integration passed
- **Committed in:** `c56aac8` (Task 3)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing critical)
**Impact on plan:** Required for Commonlib export reality and encrypted dry-run admission. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
Ready for `02-03` (conflict and all-leaf inventory). Encrypted, obfuscated, and chunked records decode through the adapter; apply still fail-closes when any block exists.

## TDD Gate Compliance
Task 1 produced RED `test(02-02)` (`e29dd87`) then GREEN `feat(02-02)` (`dd88890`). Task 2 produced RED `test(02-02)` (`569afe8`) then GREEN `feat(02-02)` (`973e884`). No REFACTOR commits were needed.

## Self-Check: PASSED

- FOUND: `src/livesync/decode-adapter.ts`
- FOUND: `src/domain/pull-plan.ts`
- FOUND: `tests/characterization/commonlib-path.test.ts`
- FOUND: `tests/characterization/commonlib-decode.test.ts`
- FOUND: `tests/characterization/commonlib-enumerate-ranges.test.ts`
- FOUND: `tests/unit/pull-plan.test.ts`
- FOUND: `tests/integration/pull-dry-run.test.ts`
- FOUND: commit `e29dd87`
- FOUND: commit `dd88890`
- FOUND: commit `569afe8`
- FOUND: commit `973e884`
- FOUND: commit `c56aac8`

---
*Phase: 02-verified-pull-materialization*
*Completed: 2026-09-03*
