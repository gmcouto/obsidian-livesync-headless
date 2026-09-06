---
phase: "3"
slug: "recoverable-pull-operations"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-09-05"
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.11 |
| **Config file** | vitest.config.ts |
| **Quick run command** | npm test |
| **Full suite command** | npm test |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run npm test
- **After every plan wave:** Run npm test
- **Before /gsd-verify-work:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | SAFE-05 | T-03-01 | SQLite migrations 003 and 004 persist tables cleanly outside vault | unit | npx vitest run tests/unit/quarantine-repo.test.ts tests/unit/checkpoint-repo.test.ts | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | PULL-04 | T-03-02 | Quarantine copy-verifies content before local unlink | unit | npx vitest run tests/unit/quarantine-store.test.ts | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 2 | PULL-08 | T-03-03 | Provenance match produces noop action with 0 writes | unit | npx vitest run tests/unit/recoverable-pull-plan.test.ts | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 2 | PULL-06 | T-03-04 | Stale temp cleanup removes .ols-tmp-* without touching user files | unit | npx vitest run tests/unit/orphan-cleanup.test.ts | ❌ W0 | ⬜ pending |
| 03-03-01 | 03 | 3 | PULL-04, PULL-08 | T-03-05 | Pull coordinator executes quarantine and skips unchanged files | unit | npx vitest run tests/unit/pull-coordinator.test.ts | ❌ W0 | ⬜ pending |
| 03-04-01 | 04 | 4 | PULL-04, PULL-06, PULL-08, SAFE-05 | T-03-06 | Real CouchDB integration for idempotent rerun, deletion quarantine, and crash resumption | integration | npx vitest run tests/integration/pull-recovery.test.ts | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] tests/unit/quarantine-repo.test.ts — covers schema migration 003 & QuarantineRepository
- [ ] tests/unit/checkpoint-repo.test.ts — covers schema migration 004 & CheckpointRepository
- [ ] tests/unit/quarantine-store.test.ts — covers quarantineVaultFile
- [ ] tests/unit/recoverable-pull-plan.test.ts — covers pull plan reconciliation with provenance
- [ ] tests/unit/orphan-cleanup.test.ts — covers .ols-tmp-* cleanup
- [ ] tests/integration/pull-recovery.test.ts — covers end-to-end recoverable pull flows with Testcontainers CouchDB

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| None | — | — | All phase behaviors have automated verification. |

---

## Validation Sign-Off

- [x] All tasks have <automated> verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] nyquist_compliant: true set in frontmatter

**Approval:** approved 2026-09-05
