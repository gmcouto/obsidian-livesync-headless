---
phase: "1"
slug: "guarded-read-only-admission"
status: ready
nyquist_compliant: true
wave_0_complete: false
created: "2026-09-03"
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.11 |
| **Config file** | `vitest.config.ts` (Wave 1 Plan 01 installs) |
| **Quick run command** | `npx vitest run tests/unit` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds (unit) / ~45 seconds (full integration) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/unit`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | — | T-01-SC | Project scaffold, TypeScript build, CLI parseArgs, leveled JSON Lines logger | unit | `npm install && npx tsc --noEmit && npx vitest run tests/unit/smoke.test.ts` | ❌ W1 | ⬜ pending |
| 01-01-02 | 01 | 1 | SAFE-04 | T-01-03 | Redact credentials, passphrases, authorization headers, setup URIs, and error stacks | unit | `npx vitest run tests/unit/redaction.test.ts` | ❌ W1 | ⬜ pending |
| 01-01-03 | 01 | 1 | CONF-01, CONF-02, CONF-03 | T-01-01, T-01-02 | Parse YAML, resolve secrets from env/file, reject unsafe paths (traversal, root, overlapping state) | unit | `npx vitest run tests/unit/config.test.ts` | ❌ W1 | ⬜ pending |
| 01-02-01 | 02 | 2 | SAFE-01, SAFE-02 | T-02-02, T-02-03 | Restrict HTTP methods to GET/HEAD and allowlist endpoints; block mutations and admin paths | unit | `npx vitest run tests/unit/transport-guard.test.ts` | ❌ W2 | ⬜ pending |
| 01-02-02 | 02 | 2 | CONF-04 | T-02-01 | Probe CouchDB markers via pure read queries; assert zero update_seq and rev mutation | unit & integration | `npx vitest run tests/unit/inspector.test.ts tests/integration/zero-mutation.test.ts` | ❌ W2 | ⬜ pending |
| 01-03-01 | 03 | 3 | CONF-05 | T-03-01, T-03-03 | Evaluate version (<=12), lock, and tweaks; adopt compatible tweaks; authenticate syncinfo | unit & char | `npx vitest run tests/unit/negotiation.test.ts tests/characterization/commonlib-crypto.test.ts` | ❌ W3 | ⬜ pending |
| 01-03-02 | 03 | 3 | CONF-06 | T-03-02 | Persist remote admission record in SQLite outside vault without storing credentials | unit | `npx vitest run tests/unit/admission-repo.test.ts` | ❌ W3 | ⬜ pending |
| 01-03-03 | 03 | 3 | CONF-06, SAFE-06 | T-03-04, T-03-05 | Run inspect command end-to-end; emit human and JSON Lines report; exit with typed code | integration | `npx vitest run tests/integration/inspect-command.test.ts` | ❌ W3 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `package.json` with exact dependency pins and npm resolution overrides
- [ ] `tsconfig.json` configured for ESM / NodeNext
- [ ] `vitest.config.ts` setup with Testcontainers integration support
- [ ] Test fixtures and mock CouchDB response fixtures
- [ ] Test directory scaffold: `tests/unit/`, `tests/characterization/`, `tests/integration/`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| None | — | — | All Phase 1 behaviors have automated test coverage using unit tests and Testcontainers CouchDB. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
