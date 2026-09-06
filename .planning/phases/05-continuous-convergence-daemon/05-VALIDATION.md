---
phase: "5"
slug: "continuous-convergence-daemon"
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-09-06"
---

# Phase 5 — Validation Strategy: Continuous Convergence Daemon

> Per-phase validation contract for feedback sampling during continuous convergence daemon execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.11 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run tests/unit/fs-watcher.test.ts tests/unit/loop-suppressor.test.ts tests/unit/changes-consumer.test.ts tests/unit/file-worker-pool.test.ts tests/unit/reconnection-manager.test.ts tests/unit/daemon-state.test.ts tests/unit/shutdown-handler.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run task-specific unit test
- **After every plan wave:** Run full unit test suite (`npm test`)
- **Before `/gsd-verify-work`:** Full suite (including integration tests) must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | DAEM-03 | T-05-01 | Trailing debouncer and path ignore filtering | unit | `npx vitest run tests/unit/fs-watcher.test.ts` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 1 | DAEM-04 | T-05-02 | Content SHA-256 and rev echo suppression prevents ping-pong loops | unit | `npx vitest run tests/unit/loop-suppressor.test.ts` | ❌ W0 | ⬜ pending |
| 05-01-03 | 01 | 1 | DAEM-03, DAEM-04 | T-05-01, T-05-02 | Watcher and loop suppression integration | unit | `npx vitest run tests/unit/fs-watcher.test.ts tests/unit/loop-suppressor.test.ts` | ❌ W0 | ⬜ pending |
| 05-02-01 | 02 | 2 | DAEM-03 | T-05-03 | Changes feed continuous streaming & NDJSON chunk parsing | unit | `npx vitest run tests/unit/changes-consumer.test.ts` | ❌ W0 | ⬜ pending |
| 05-02-02 | 02 | 2 | DAEM-06 | T-05-04 | Jittered exponential backoff for transient reconnects | unit | `npx vitest run tests/unit/reconnection-manager.test.ts` | ❌ W0 | ⬜ pending |
| 05-02-03 | 02 | 2 | DAEM-05 | T-05-05 | Monotonic sequence checkpointing with error fencing | unit | `npx vitest run tests/unit/changes-consumer.test.ts tests/unit/checkpoint-repo.test.ts` | ❌ W0 | ⬜ pending |
| 05-03-01 | 03 | 3 | DAEM-04 | T-05-06 | Per-path mutex and bounded concurrency worker pool | unit | `npx vitest run tests/unit/file-worker-pool.test.ts` | ❌ W0 | ⬜ pending |
| 05-03-02 | 03 | 3 | DAEM-03, DAEM-04 | T-05-07 | Single-file authoritative re-read and reconciler | unit | `npx vitest run tests/unit/file-reconciler.test.ts` | ❌ W0 | ⬜ pending |
| 05-03-03 | 03 | 3 | DAEM-01, DAEM-02, DAEM-07 | T-05-08 | Daemon admission, catch-up, and degraded state machine | unit | `npx vitest run tests/unit/daemon-state.test.ts tests/unit/continuous-engine.test.ts` | ❌ W0 | ⬜ pending |
| 05-04-01 | 04 | 4 | DAEM-08 | T-05-09 | SIGINT/SIGTERM graceful intake halt, queue drain, and clean exit | unit | `npx vitest run tests/unit/shutdown-handler.test.ts` | ❌ W0 | ⬜ pending |
| 05-04-02 | 04 | 4 | DAEM-01, DAEM-08 | T-05-08, T-05-09 | CLI daemon command wiring & banner | unit | `npx vitest run tests/unit/daemon-command.test.ts` | ❌ W0 | ⬜ pending |
| 05-04-03 | 04 | 4 | DAEM-01..DAEM-08 | T-05-01..T-05-09 | End-to-end continuous convergence against real CouchDB | integration | `npx vitest run tests/integration/daemon-continuous-sync.test.ts tests/integration/daemon-reconnection.test.ts tests/integration/daemon-shutdown.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/fs-watcher.test.ts` — covers DAEM-03
- [ ] `tests/unit/loop-suppressor.test.ts` — covers DAEM-04
- [ ] `tests/unit/changes-consumer.test.ts` — covers DAEM-03, DAEM-05
- [ ] `tests/unit/reconnection-manager.test.ts` — covers DAEM-06
- [ ] `tests/unit/file-worker-pool.test.ts` — covers DAEM-04
- [ ] `tests/unit/file-reconciler.test.ts` — covers DAEM-03, DAEM-04
- [ ] `tests/unit/daemon-state.test.ts` — covers DAEM-07
- [ ] `tests/unit/continuous-engine.test.ts` — covers DAEM-01, DAEM-02, DAEM-06
- [ ] `tests/unit/shutdown-handler.test.ts` — covers DAEM-08
- [ ] `tests/unit/daemon-command.test.ts` — covers DAEM-01, DAEM-08

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| None — all continuous daemon behaviors have automated unit and integration tests | — | — | — |

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have <automated> verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 20s
- [x] nyquist_compliant: true set in frontmatter

**Approval:** 2026-09-06
