---
phase: "6"
slug: "packaged-mixed-client-release-gate"
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-09-06"
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.11 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm run test:all` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test` or specific unit test
- **After every plan wave:** Run `npm test && npx vitest run tests/integration/packaged-binary.test.ts`
- **Before `/gsd-verify-work`:** Full suite must be green (`npm test` + release audit script)
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | DIST-03 | T-06-01 | Exposed build identity and pinned version metadata | unit | `npx vitest run tests/unit/identity.test.ts` | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | DIST-02 | T-06-02 | Local vault state inspection and status report | unit | `npx vitest run tests/unit/status-command.test.ts` | ❌ W0 | ⬜ pending |
| 06-01-03 | 01 | 1 | DIST-02, DIST-03 | T-06-01, T-06-02 | Extended CLI dispatcher, version/help routing, warning filter | unit | `npx vitest run tests/unit/identity.test.ts tests/unit/status-command.test.ts` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | DIST-01 | T-06-03 | Standalone binary entrypoint with warning suppression | cli | `npx tsx src/bin.ts --version` | ❌ W0 | ⬜ pending |
| 06-02-02 | 02 | 2 | DIST-01 | T-06-03, T-06-04 | SEA bundling and postject injection pipeline | build | `npm run build:sea && test -x dist/obsidian-livesync-headless` | ❌ W0 | ⬜ pending |
| 06-02-03 | 02 | 2 | DIST-01, DIST-02 | T-06-03 | Standalone SEA binary execution without Node runtime in PATH | integration | `npx vitest run tests/integration/packaged-binary.test.ts` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 3 | COMP-07, DIST-04 | T-06-05 | Upstream LiveSync client simulation harness helpers | integration | `npx vitest run tests/integration/mixed-client-interop.test.ts -t "harness"` | ❌ W0 | ⬜ pending |
| 06-03-02 | 03 | 3 | COMP-07, DIST-04 | T-06-05 | Bidirectional mixed-client interoperability across formats | integration | `npx vitest run tests/integration/mixed-client-interop.test.ts -t "bidirectional"` | ❌ W0 | ⬜ pending |
| 06-03-03 | 03 | 3 | COMP-07, DIST-04 | T-06-05, T-06-06 | Concurrent modifications, conflict preservation, daemon convergence | integration | `npx vitest run tests/integration/mixed-client-interop.test.ts` | ❌ W0 | ⬜ pending |
| 06-04-01 | 04 | 4 | DIST-05 | T-06-07, T-06-08 | Static release safety auditor (forbidden methods, secrets, pins) | script | `npx tsx scripts/audit-release.ts` | ❌ W0 | ⬜ pending |
| 06-04-02 | 04 | 4 | DIST-05 | T-06-07, T-06-08 | Release safety unit test suite | unit | `npx vitest run tests/unit/release-audit.test.ts` | ❌ W0 | ⬜ pending |
| 06-04-03 | 04 | 4 | DIST-05 | T-06-07, T-06-08 | Complete release gate verification | integration | `npm run test:unit && npx tsx scripts/audit-release.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/identity.test.ts` — stubs for DIST-03
- [ ] `tests/unit/status-command.test.ts` — stubs for DIST-02
- [ ] `tests/integration/packaged-binary.test.ts` — test harness for DIST-01, DIST-02
- [ ] `tests/integration/mixed-client-interop.test.ts` — test harness for COMP-07, DIST-04
- [ ] `tests/unit/release-audit.test.ts` — stubs for DIST-05

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Standalone binary cross-platform verification | DIST-01 | Multi-OS binary execution outside Linux container | Execute compiled binary on macOS / Windows CI runners |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** verified
