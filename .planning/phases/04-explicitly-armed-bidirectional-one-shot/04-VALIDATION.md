---
phase: "04"
slug: "explicitly-armed-bidirectional-one-shot"
date: "2026-09-06"
---

# Phase 04: Explicitly Armed Bidirectional One-Shot - Validation Strategy

## Validation Architecture

### Test Framework
| Property | Value |
|---|---|
| Framework | Vitest 4.1.11 |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run tests/unit/write-grant-repo.test.ts tests/unit/sync-plan.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| CONF-07 | Explicit write arming bound to 5 tuples | unit | `npx vitest run tests/unit/write-grant-repo.test.ts` | ❌ Wave 0 |
| CONF-08 | Auto-revocation on evidence drift | unit | `npx vitest run tests/unit/write-grant-repo.test.ts` | ❌ Wave 0 |
| SYNC-01 | 6-stage lifecycle & convergence | integration | `npx vitest run tests/integration/sync-bidirectional.test.ts` | ❌ Wave 0 |
| SYNC-02 | Local edits extend proven revision | unit/integration | `npx vitest run tests/unit/sync-plan.test.ts` | ❌ Wave 0 |
| SYNC-03 | Chunk-first storage before note PUT | integration | `npx vitest run tests/integration/sync-bidirectional.test.ts` | ❌ Wave 0 |
| SYNC-04 | Logical deletion on proven branch | unit | `npx vitest run tests/unit/deletion-writer.test.ts` | ❌ Wave 0 |
| SYNC-05 | Case and cross-path renames | unit | `npx vitest run tests/unit/rename-detector.test.ts` | ❌ Wave 0 |
| SYNC-06 | Ambiguous conflict preservation & collapse | unit | `npx vitest run tests/unit/conflict-reconciler.test.ts` | ❌ Wave 0 |
| SYNC-07 | Preserve unmatched local bytes | integration | `npx vitest run tests/integration/sync-bidirectional.test.ts` | ❌ Wave 0 |
| SYNC-08 | Enforceable dry-run preview | integration | `npx vitest run tests/integration/sync-dry-run.test.ts` | ❌ Wave 0 |
| SYNC-09 | Idempotent safe reruns & resume | integration | `npx vitest run tests/integration/sync-recovery-rerun.test.ts` | ❌ Wave 0 |
| SAFE-03 | Armed transport guard restrictions | unit | `npx vitest run tests/unit/armed-transport-guard.test.ts` | ❌ Wave 0 |
| SAFE-07 | Backup warning banner display | unit | `npx vitest run tests/unit/sync-command.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/unit/write-grant-repo.test.ts tests/unit/sync-plan.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/unit/write-grant-repo.test.ts` — covers CONF-07, CONF-08
- [ ] `tests/unit/armed-transport-guard.test.ts` — covers SAFE-03
- [ ] `tests/unit/sync-plan.test.ts` — covers SYNC-01, SYNC-02, SYNC-08
- [ ] `tests/unit/rename-detector.test.ts` — covers SYNC-05
- [ ] `tests/unit/deletion-writer.test.ts` — covers SYNC-04
- [ ] `tests/unit/conflict-reconciler.test.ts` — covers SYNC-06, SYNC-07
- [ ] `tests/unit/sync-command.test.ts` — covers SAFE-07
- [ ] `tests/integration/sync-bidirectional.test.ts` — covers SYNC-01..SYNC-07
- [ ] `tests/integration/sync-dry-run.test.ts` — covers SYNC-08
- [ ] `tests/integration/sync-recovery-rerun.test.ts` — covers SYNC-09

