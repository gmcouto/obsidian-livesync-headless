---
phase: 01-guarded-read-only-admission
plan: "01"
subsystem: config
tags: [yaml, zod, redaction, security, cli, parseargs]

requires: []
provides:
  - Pinned project scaffolding with NodeNext ESM and strict TypeScript settings
  - Centralized SecretRedactor scrubbing URLs, auth headers, setup URIs, and error stacks
  - Leveled JSON Lines logger to stderr with integrated secret scrubbing
  - Strict YAML configuration loader with environment/file secret resolution and path safety validation
  - Walking skeleton CLI entrypoint parsing arguments via node:util.parseArgs
affects:
  - 01-guarded-read-only-admission
  - 02-verified-pull
  - 03-recoverable-pull

actuals:
  tokens: 15200
  tasks: 3
  commits: 4

tech-stack:
  added:
    - "@vrtmrz/livesync-commonlib@0.1.21"
    - "yaml@2.9.0"
    - "zod@4.5.4"
    - "typescript@5.9.3"
    - "vitest@4.1.11"
    - "@vitest/coverage-v8@4.1.11"
    - "@testcontainers/couchdb@12.1.0"
    - "@types/node@24.10.13"
    - "@types/pouchdb-core@7.0.15"
  patterns:
    - "Centralized secret redaction on all stderr log outputs and error objects"
    - "Strict YAML document parsing before Zod schema validation with unknown key rejection"
    - "Fail-closed destination path safety blocking system root, home directory, and state directory overlaps"

key-files:
  created:
    - package.json
    - tsconfig.json
    - vitest.config.ts
    - src/index.ts
    - src/cli/index.ts
    - src/diagnostics/outcomes.ts
    - src/diagnostics/logger.ts
    - src/security/redaction.ts
    - src/config/schema.ts
    - src/config/secrets.ts
    - src/config/loader.ts
    - tests/unit/smoke.test.ts
    - tests/unit/redaction.test.ts
    - tests/unit/config.test.ts
  modified:
    - .gitignore

key-decisions:
  - "Default Logger to use SecretRedactor automatically so all emitted log entries are sanitized"
  - "Anchor secrets.* and config.local.* in .gitignore to root to prevent ignoring src/config/secrets.ts"
  - "Reject system root, user home, and overlapping vault/state directory paths during configuration loading before any I/O"

patterns-established:
  - "Redactor hook on logger ensuring no credentials or passphrases leak to stderr"
  - "Strict YAML loading via yaml.parseDocument followed by Zod safeParse with strict rejection of unknown keys"

requirements-completed:
  - CONF-01
  - CONF-02
  - CONF-03
  - SAFE-04

coverage:
  - id: D1
    description: "Walking skeleton CLI entrypoint with node:util.parseArgs and leveled stderr JSON Lines logging"
    requirement: "CONF-01"
    verification:
      - kind: unit
        ref: "tests/unit/smoke.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Centralized SecretRedactor scrubbing passwords, passphrases, URLs, auth headers, and error stacks"
    requirement: "SAFE-04"
    verification:
      - kind: unit
        ref: "tests/unit/redaction.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Strict YAML configuration loader resolving environment and file secret references"
    requirement: "CONF-02"
    verification:
      - kind: unit
        ref: "tests/unit/config.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Destination path safety validation rejecting root, user home, and overlapping state directories"
    requirement: "CONF-03"
    verification:
      - kind: unit
        ref: "tests/unit/config.test.ts"
        status: pass
    human_judgment: false

duration: 12 min
completed: 2026-09-03
status: complete
---

# Phase 1 Plan 01: Project Scaffolding and Safe YAML Configuration Loader Summary

**Scaffolded project baseline with strict NodeNext TypeScript, centralized credential redaction, leveled JSON Lines stderr logging, and fail-closed YAML configuration loader with destination path safety.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-09-03T10:15:30Z
- **Completed:** 2026-09-03T10:27:30Z
- **Tasks:** 3
- **Files modified:** 15

## Accomplishments
- Pinned exact dependencies (`@vrtmrz/livesync-commonlib@0.1.21`, `yaml@2.9.0`, `zod@4.5.4`, `typescript@5.9.3`, `vitest@4.1.11`) and PouchDB UUID overrides in `package.json`.
- Implemented `SecretRedactor` in `src/security/redaction.ts` scrubbing URLs, HTTP Basic/Bearer headers, LiveSync setup URIs, and Error stack traces.
- Implemented leveled JSON Lines logger in `src/diagnostics/logger.ts` writing structured entries to `stderr` with default secret redaction.
- Implemented strict YAML configuration loader in `src/config/loader.ts` with secret reference resolution (`fromEnv`, `fromFile`) and destination path validation against root `/`, home, and overlapping state directories.
- Built CLI option parser in `src/cli/index.ts` supporting `--config`, `--json`, `--help`, `--version` via built-in `node:util.parseArgs`.
- 100% test coverage across 30 unit tests in `smoke.test.ts`, `redaction.test.ts`, and `config.test.ts`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Project Scaffolding and Walking Skeleton CLI Tracer** - `50ea042` (feat)
2. **Task 2: Secret Redaction Engine and Diagnostics Sanitizer** - `30c4b22` (feat)
3. **Task 3: Safe YAML Configuration Loader, Secret Provider, and Path Safety Validator** - `90f17e7`, `fd9318c` (feat)

**Plan metadata:** pending commit (docs: complete plan)

## Files Created/Modified
- `package.json` - Pinned dependencies and PouchDB UUID overrides
- `package-lock.json` - Lockfile v3 generated by npm
- `tsconfig.json` - ES2022 NodeNext strict TypeScript configuration
- `vitest.config.ts` - Vitest test configuration with Node environment
- `src/index.ts` - Root exports for diagnostics, logger, redaction, and config
- `src/cli/index.ts` - CLI entrypoint with node:util.parseArgs
- `src/diagnostics/outcomes.ts` - Outcome categories and standard exit codes
- `src/diagnostics/logger.ts` - Leveled JSON Lines stderr logger
- `src/security/redaction.ts` - Centralized SecretRedactor
- `src/config/schema.ts` - Strict Zod schemas and TypeScript types
- `src/config/secrets.ts` - Secret resolution from environment or files
- `src/config/loader.ts` - YAML loader and path safety validator
- `.gitignore` - Anchored secret patterns
- `tests/unit/smoke.test.ts` - CLI and logger smoke tests
- `tests/unit/redaction.test.ts` - Secret redaction unit tests
- `tests/unit/config.test.ts` - Configuration loader and path safety tests

## Decisions Made
- Anchored `/secrets.*` and `/config.local.*` in `.gitignore` to prevent accidentally ignoring `src/config/secrets.ts`.
- Integrated `SecretRedactor` directly as the default redactor in `Logger` to guarantee all log entries to `stderr` are sanitized.
- Enforced strict Zod schema checking (`.strict()`) to reject any unexpected or unknown YAML properties at intake.
- Implemented canonical path overlap detection ensuring vault directories and local state directories remain strictly isolated.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Anchored secrets pattern in .gitignore to root**
- **Found during:** Task 3 (Safe YAML Configuration Loader)
- **Issue:** The unanchored `secrets.*` pattern in `.gitignore` matched `src/config/secrets.ts`, preventing it from being staged.
- **Fix:** Changed `secrets.*` and `config.local.*` in `.gitignore` to `/secrets.*` and `/config.local.*`.
- **Files modified:** `.gitignore`
- **Verification:** Staging `src/config/secrets.ts` succeeded without warning or force flag.
- **Committed in:** `fd9318c`

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Essential fix for Git tracking of the secret resolution module. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
Ready for Wave 2 Plan 01-02: Guarded HTTP Transport Layer and Zero-Mutation CouchDB Inspector.
