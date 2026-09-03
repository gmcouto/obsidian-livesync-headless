---
phase: 01-guarded-read-only-admission
plan: "02"
subsystem: security
tags: [transport-guard, couchdb, testcontainers, zero-mutation, livesync, read-only]

requires:
  - phase: 01-guarded-read-only-admission
    provides: Project scaffolding, secret redactor, and safe YAML configuration loader
provides:
  - Guarded HTTP transport wrapper mechanically blocking mutating methods (PUT, POST, DELETE, PATCH)
  - Audited administrative endpoint lockout denying all CouchDB destructive and lifecycle APIs
  - Pure read-only CouchDB protocol inspector fetching database info, version, milestone, sync params, and syncinfo
  - Mathematical zero-mutation verifier capturing update_seq and document revisions
  - Testcontainers CouchDB 3.5.2.1 integration harness
affects:
  - 01-guarded-read-only-admission
  - 02-verified-pull
  - 03-recoverable-pull

actuals:
  tokens: 18400
  tasks: 2
  commits: 2

tech-stack:
  added:
    - "@testcontainers/couchdb@12.1.0"
  patterns:
    - "Mechanically enforced HTTP method and endpoint allowlist in fetch wrapper"
    - "Manual redirect inspection to prevent cross-origin credential forwarding"
    - "Mathematical zero-mutation assertions comparing pre- and post-probe update_seq and revision vectors"

key-files:
  created:
    - src/security/transport-guard.ts
    - src/security/capabilities.ts
    - src/livesync/inspector.ts
    - src/livesync/zero-mutation.ts
    - tests/unit/transport-guard.test.ts
    - tests/unit/inspector.test.ts
    - tests/integration/couchdb-harness.ts
    - tests/integration/zero-mutation.test.ts
  modified:
    - src/index.ts

key-decisions:
  - "Enforce GET and HEAD allowlist at the lowest network dispatch wrapper rather than relying on application flags"
  - "Mechanically deny all CouchDB administrative subpaths (_purge, _compact, _security, _replicator, _design, _node, etc.)"
  - "Verify zero remote mutation against real CouchDB 3.5.2.1 using Testcontainers"

patterns-established:
  - "createGuardedFetch ensures all admission and inspection network traffic is fail-closed and read-only"
  - "ZeroMutationVerifier proves zero remote mutation before and after any discovery operation"

requirements-completed:
  - SAFE-01
  - SAFE-02
  - CONF-04

coverage:
  - id: D1
    description: "Guarded HTTP transport wrapper enforcing GET/HEAD-only methods and origin identity"
    requirement: "SAFE-02"
    verification:
      - kind: unit
        ref: "tests/unit/transport-guard.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Administrative endpoint lockout refusing _purge, _compact, _security, and other CouchDB lifecycle APIs"
    requirement: "SAFE-01"
    verification:
      - kind: unit
        ref: "tests/unit/transport-guard.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Pure read-only CouchDB protocol inspector for database info, version markers, milestone, and sync parameters"
    requirement: "CONF-04"
    verification:
      - kind: unit
        ref: "tests/unit/inspector.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Mathematical zero-mutation verification against real CouchDB 3.5.2.1 container"
    requirement: "SAFE-02"
    verification:
      - kind: integration
        ref: "tests/integration/zero-mutation.test.ts"
        status: pass
    human_judgment: false

duration: 10 min
completed: 2026-09-03
status: complete
---

# Phase 1 Plan 02: Guarded HTTP Transport Layer and Zero-Mutation CouchDB Inspector Summary

**Implemented the fail-closed HTTP transport allowlist mechanically blocking mutating methods and administrative endpoints, and built the read-only CouchDB protocol inspector with verified zero-mutation proof against real CouchDB 3.5.2.1.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-09-03T10:22:15Z
- **Completed:** 2026-09-03T10:32:15Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Implemented `createGuardedFetch` in `src/security/transport-guard.ts` enforcing an explicit `GET`/`HEAD` allowlist, origin identity assertion, manual redirect verification, and mechanical blocking of mutating requests with `MutationAttemptBlockedError`.
- Audited and blocked all CouchDB administrative and destructive paths (`_purge`, `_compact`, `_security`, `_revs_limit`, `_replicator`, `_design`, `_index`, `_node`, `_users`, `_config`, `_restart`, `_up`) with `EndpointDisallowedError`.
- Implemented in-process unforgeable capability tokens (`ReadCapability`, `AdmissionCapability`) in `src/security/capabilities.ts`.
- Implemented `probeRemoteDatabase` and `fetchDocumentIfExists` in `src/livesync/inspector.ts` using exact LiveSync document IDs (`obsydian_livesync_version`, `_local/obsydian_livesync_milestone`, `_local/obsidian_livesync_sync_parameters`, `syncinfo`) without calling mutating Commonlib setup functions.
- Implemented `ZeroMutationVerifier` in `src/livesync/zero-mutation.ts` capturing database `update_seq`, `doc_count`, and document revision vectors.
- Built `CouchDbTestHarness` in `tests/integration/couchdb-harness.ts` using `@testcontainers/couchdb@12.1.0` with official `couchdb:3.5.2.1`.
- Verified mathematical zero-mutation proof against real CouchDB 3.5.2.1 in `tests/integration/zero-mutation.test.ts`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Guarded Read-Only HTTP Transport and Administrative Lockout Guard** - `35cf0ec` (feat)
2. **Task 2: Read-Only CouchDB Protocol Inspector and Zero-Mutation Verifier** - `658badf` (feat)

**Plan metadata:** pending commit (docs: complete plan)

## Files Created/Modified
- `src/security/transport-guard.ts` - Guarded HTTP fetch allowlist wrapper
- `src/security/capabilities.ts` - Read and admission capability tokens
- `src/livesync/inspector.ts` - Pure read-only CouchDB protocol inspector
- `src/livesync/zero-mutation.ts` - Pre/post snapshot capture and zero-mutation assertion
- `src/index.ts` - Exported transport guard, capabilities, inspector, and zero-mutation
- `tests/unit/transport-guard.test.ts` - Unit tests for method allowlist and admin lockout
- `tests/unit/inspector.test.ts` - Unit tests for mock CouchDB inspection
- `tests/integration/couchdb-harness.ts` - Testcontainers CouchDB 3.5.2.1 harness
- `tests/integration/zero-mutation.test.ts` - Integration tests verifying zero remote mutation

## Decisions Made
- Disallowed all mutating HTTP methods at the network transport layer rather than relying on application-level conditional flags.
- Strip embedded userinfo from Testcontainers CouchDB URL so credentials flow strictly via Authorization headers through the guarded transport.
- Preserved exact LiveSync historical document ID casing and typo conventions (`obsydian_livesync_version`, `_local/obsydian_livesync_milestone`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected Testcontainers CouchDB connection URL accessor**
- **Found during:** Task 2 (Integration Test)
- **Issue:** `container.getConnectionUrl()` was called on `StartedCouchDBContainer`, but the container exports `getUrl()`.
- **Fix:** Changed `container.getConnectionUrl()` to `container.getUrl()` and stripped embedded userinfo to match URL security standards.
- **Files modified:** `tests/integration/couchdb-harness.ts`
- **Verification:** Integration tests against Testcontainers CouchDB 3.5.2.1 passed cleanly in 3.28s.
- **Committed in:** `658badf`

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Minor fix in test fixture. Zero remote mutation invariant fully proven against real CouchDB.

## Issues Encountered
None.

## User Setup Required
None.

## Next Phase Readiness
Ready for Wave 3 Plan 01-03: LiveSync Negotiation, Web Crypto HKDF Syncinfo Verification, SQLite Admission Repository, and CLI Inspect Coordinator.
