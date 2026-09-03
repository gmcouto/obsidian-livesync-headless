---
phase: "1"
slug: "guarded-read-only-admission"
status: draft
nyquist_compliant: false
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
| **Config file** | `vitest.config.ts` (Wave 0 installs) |
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
| 01-01-01 | 01 | 1 | CONF-01 | — | Parse YAML configuration with db URL, name, and vault root | unit | `npx vitest run tests/unit/config.test.ts` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | CONF-02 | T-01-01 | Resolve secrets via env vars and separate secret files without committing to config | unit | `npx vitest run tests/unit/config.test.ts` | ❌ W0 | ⬜ pending |
| 01-01-03 | 01 | 1 | CONF-03 | T-01-02 | Reject unsafe vault paths (traversal, root, overlapping state) before side effects | unit | `npx vitest run tests/unit/config.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 2 | SAFE-01 | T-01-03 | Deny database lifecycle and admin API operations (purge, compact, drop, security) | unit | `npx vitest run tests/unit/transport-guard.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-02 | 02 | 2 | SAFE-02 | T-01-04 | Restrict HTTP methods to GET/HEAD and allowlisted endpoints; block mutations | unit | `npx vitest run tests/unit/transport-guard.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-03 | 02 | 2 | SAFE-04 | T-01-05 | Redact credentials, passphrases, authorization headers, and URIs from all output and logs | unit | `npx vitest run tests/unit/redaction.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-01 | 03 | 3 | CONF-04 | — | Probe CouchDB markers, version, milestone, sync params, preferred tweaks | integration | `npx vitest run tests/integration/inspect-command.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-02 | 03 | 3 | CONF-05 | T-01-06 | Negotiate compatibility: adopt compatible remote tweaks, block on incompatible or future versions | unit & integration | `npx vitest run tests/unit/negotiation.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-03 | 03 | 3 | CONF-06 | — | Produce stable compatibility report with fingerprint, settings hash, blockers | integration | `npx vitest run tests/integration/inspect-command.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-04 | 03 | 3 | SAFE-06 | — | Emit structured diagnostics and non-zero exit codes on admission/auth/config failure | integration | `npx vitest run tests/integration/inspect-command.test.ts` | ❌ W0 | ⬜ pending |

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
