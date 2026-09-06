---
phase: "07"
slug: "environment-variable-configuration-and-minimal-docker-daemon"
status: approved
nyquist_compliant: true
wave_0_complete: false
created: "2026-09-06"
---

# Phase 07 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.11 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npm run test:unit` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm run test:unit`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 1 | ENV-02 | T-07-01 | Register env-injected passwords/passphrases with SecretRedactor | unit | `npx vitest run tests/unit/env-loader.test.ts` | ❌ W0 | ⬜ pending |
| 07-01-02 | 01 | 1 | ENV-01 | T-07-02 | CLI runs without --config using pure env vars with path safety | unit | `npx vitest run tests/unit/env-config.test.ts tests/unit/smoke.test.ts` | ❌ W0 | ⬜ pending |
| 07-02-01 | 02 | 2 | DOCKER-01, DOCKER-02 | T-07-03 | Build multi-stage image with proper minimal footprint and CA certs | integration | `docker build -t obsidian-livesync-headless:test .` | ❌ W0 | ⬜ pending |
| 07-02-02 | 02 | 2 | DOCKER-02, DOCKER-03 | T-07-04 | Container starts daemon by default and exposes /vault, /data mounts | integration | `npx vitest run tests/integration/docker-daemon.test.ts` | ❌ W0 | ⬜ pending |
| 07-03-01 | 03 | 3 | CI-01 | T-07-05 | GitHub Actions workflow triggers on release and builds/pushes to GHCR | ci / lint | `test -f .github/workflows/docker-publish.yml` | ❌ W0 | ⬜ pending |
| 07-03-02 | 03 | 3 | ENV-01, DOCKER-02 | T-07-06 | README documents complete Docker and Environment Variable reference | doc | `grep -q "LIVESYNC_COUCHDB_URL" README.md && grep -q "ghcr.io" README.md` | ✅ | ⬜ pending |
| 07-03-03 | 03 | 3 | CI-01 | — | Release safety auditor passes cleanly with zero violations | audit / test | `npm run test:unit && npx tsx scripts/audit-release.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/env-loader.test.ts` — stubs for ENV-02
- [ ] `tests/unit/env-config.test.ts` — stubs for ENV-01
- [ ] `tests/integration/docker-daemon.test.ts` — tests for DOCKER-01, DOCKER-02, DOCKER-03

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| GitHub Actions GHCR publish on release | CI-01 | Requires published GitHub Release event and GHCR credentials in CI | Inspect `.github/workflows/docker-publish.yml` structure and dry-run with action validator |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending 2026-09-06
