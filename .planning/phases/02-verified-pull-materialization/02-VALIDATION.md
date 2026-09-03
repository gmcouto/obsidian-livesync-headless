---
phase: 2
slug: verified-pull-materialization
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-03
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.11 |
| **Config file** | `vitest.config.ts` (`environment: 'node'`, `fileParallelism: false`, `include: ['tests/**/*.test.ts']`) |
| **Quick run command** | `npx vitest run tests/unit tests/characterization` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~20 seconds (unit+characterization) / ~60 seconds (full integration) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/unit tests/characterization`
- **After every plan wave:** Run `npx vitest run`
- **Before `$gsd-verify-work`:** Full suite must be green, including Testcontainers pull tests and zero-mutation assertions
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-W0 | — | 0 | COMP-01 | T-02-01 | Classify note vs special vs unknown; never rewrite remote | unit + characterization | `npx vitest run tests/unit/pull-plan.test.ts tests/characterization/commonlib-enumerate-ranges.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | COMP-02 | T-02-04 | V2 HKDF and V1 decrypt; wrong passphrase blocks | characterization + integration | `npx vitest run tests/characterization/commonlib-decode.test.ts tests/characterization/commonlib-crypto.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | COMP-03 | T-02-02 | Obfuscated and plain path2id; underscore; case fold | characterization | `npx vitest run tests/characterization/commonlib-path.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | COMP-04 | T-02-04 | Chunk assemble + size check for text/binary | characterization + integration | `npx vitest run tests/characterization/commonlib-decode.test.ts tests/integration/pull-apply.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | COMP-05 | T-02-04 | Identity/decrypt/chunk/size/shape failures block | unit | `npx vitest run tests/unit/pull-plan.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | COMP-06 | T-02-05 | Two live leaves → block; winner not materialized | integration | `npx vitest run tests/integration/pull-apply.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | PULL-01 | T-02-01 | `--dry-run` no vault/provenance/CouchDB mutation | integration | `npx vitest run tests/integration/pull-dry-run.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | PULL-02 | T-02-03 | Empty/dedicated gate; assemble-before-write | unit + integration | `npx vitest run tests/unit/vault-preflight.test.ts tests/integration/pull-apply.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | PULL-03 | T-02-03 | Temp+sync+rename+readback; crash-before-rename leaves dest untouched | unit | `npx vitest run tests/unit/atomic-reflector.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | PULL-05 | T-02-03 | Provenance only after verify; dry-run writes none | unit + integration | `npx vitest run tests/unit/provenance-repo.test.ts tests/integration/pull-apply.test.ts` | ❌ W0 | ⬜ pending |
| 02-W0 | — | 0 | PULL-07 | T-02-02 | Traversal, absolute, symlink, reserved, case collision | unit | `npx vitest run tests/unit/path-policy.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/pull-plan.test.ts` — COMP-01/05, PULL-01 plan shapes
- [ ] `tests/unit/path-policy.test.ts` — PULL-07
- [ ] `tests/unit/atomic-reflector.test.ts` — PULL-03
- [ ] `tests/unit/provenance-repo.test.ts` — PULL-05
- [ ] `tests/unit/vault-preflight.test.ts` — PULL-02 empty/dedicated
- [ ] `tests/characterization/commonlib-path.test.ts` — COMP-03
- [ ] `tests/characterization/commonlib-decode.test.ts` — COMP-02/04
- [ ] `tests/characterization/commonlib-enumerate-ranges.test.ts` — reserved ID prefixes
- [ ] `tests/integration/pull-dry-run.test.ts` — PULL-01 + zero mutation
- [ ] `tests/integration/pull-apply.test.ts` — PULL-02/03/05, COMP-06 conflict seed
- [ ] Extend `tests/unit/negotiation.test.ts` for tweak adoption
- [ ] Extend `tests/integration/couchdb-harness.ts` with conflict-leaf and chunk seed helpers

*Framework already present: Vitest 4.1.11. No new test runner install.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| None | — | — | All Phase 2 behaviors have automated verification via unit, characterization, and Testcontainers integration tests. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
