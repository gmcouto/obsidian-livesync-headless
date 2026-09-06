---
phase: 06-packaged-mixed-client-release-gate
plan: 02
subsystem: packaging
tags: [sea, postject, esbuild, standalone-binary, packaging-pipeline, integration-test]
requires:
  - cli/index
  - diagnostics/identity
provides:
  - bin
  - scripts/build-sea
  - dist/obsidian-livesync-headless
affects:
  - package.json
tech-stack:
  added:
    - "esbuild: 0.28.2"
    - "postject: 1.0.0-alpha.6"
  patterns:
    - "Single-Executable Application (SEA) packaging pipeline using esbuild CJS bundling and postject ELF/Mach-O resource injection with sentinel fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
    - "Standalone binary entrypoint with early SQLite experimental warning suppression and dynamic module loading"
    - "Isolated PATH subprocess testing harness verifying zero-dependency runtime execution"
key-files:
  created:
    - src/bin.ts
    - scripts/build-sea.mjs
    - tests/integration/packaged-binary.test.ts
  modified:
    - package.json
    - package-lock.json
    - src/cli/index.ts
    - src/diagnostics/identity.ts
key-decisions:
  - "Built standalone binary entrypoint (src/bin.ts) that installs an early process.emitWarning and process.on('warning') interceptor before dynamic CLI import to completely silence internal experimental SQLite notices"
  - "Created automated packaging script (scripts/build-sea.mjs) using esbuild to bundle all dependencies into dist/bundle.cjs, generating the Node SEA preparation blob, copying host Node binary, and injecting the blob with postject"
  - "Added node:sea isSea detection to getBuildIdentity() in src/diagnostics/identity.ts so running binaries accurately report SEA=true"
  - "Implemented integration test suite (tests/integration/packaged-binary.test.ts) validating standalone execution under scrubbed PATH='/usr/bin:/bin' across all 7 command flows"
requirements-completed:
  - DIST-01
  - DIST-02
duration: 5 min
completed: 2026-09-06T16:16:30Z
coverage:
  - deliverable: "Standalone binary entrypoint with warning suppression"
    verification:
      kind: command
      ref: "npx tsx src/bin.ts --version"
      status: pass
    human_judgment: false
  - deliverable: "SEA packaging script and build pipeline"
    verification:
      kind: command
      ref: "npm run build:sea && test -x dist/obsidian-livesync-headless"
      status: pass
    human_judgment: false
  - deliverable: "Packaged binary isolated PATH integration test suite"
    verification:
      kind: test
      ref: tests/integration/packaged-binary.test.ts
      status: pass
    human_judgment: false
---

# Phase 06 Plan 02: SEA Packaging Pipeline & Standalone Binary Verification Summary

Implemented the Single-Executable Application (SEA) packaging pipeline with esbuild and postject, delivering a self-contained, zero-dependency standalone binary executable verified in isolated runtime environments across all CLI command flows.

## Accomplishments
- Implemented `src/bin.ts` standalone executable entrypoint with early `process.emitWarning` and `process.on('warning')` interceptors suppressing internal `node:sqlite` experimental warnings, and dynamic CLI invocation.
- Developed `scripts/build-sea.mjs` packaging automation script orchestrating:
  1. `esbuild` compilation into self-contained CommonJS artifact `dist/bundle.cjs` targeting `node24` with inlined dependencies (`@vrtmrz/livesync-commonlib`, `yaml`, `zod`, `chokidar`).
  2. `dist/sea-config.json` configuration and Node `--experimental-sea-config` blob preparation (`dist/sea-prep.blob`).
  3. Host Node binary copy to `dist/obsidian-livesync-headless`.
  4. Binary resource injection with `postject` using sentinel fuse `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`.
  5. Permission configuration `chmod 0o755`.
- Updated `package.json` with pinned devDependencies `esbuild` (0.28.2), `postject` (1.0.0-alpha.6), and script `"build:sea": "node scripts/build-sea.mjs"`.
- Enhanced `src/diagnostics/identity.ts` with `node:sea` `isSea()` detection to accurately report `SEA=true` when running inside the packaged executable.
- Implemented comprehensive integration test suite `tests/integration/packaged-binary.test.ts` executing the compiled binary in an isolated subprocess (`PATH='/usr/bin:/bin'`, no external Node.js or npm in PATH), verifying `version`, `version --json`, `--help`, `status`, missing config errors, unknown commands, and guarded `pull --dry-run`.

## Verification
- `npm run build:sea && test -x dist/obsidian-livesync-headless` completed successfully, producing executable `dist/obsidian-livesync-headless`.
- `npx vitest run tests/integration/packaged-binary.test.ts` passed (8/8 tests passing in isolated PATH environment).
- `npm run test:unit` passed (41 test files, 223/223 tests passing).

## Self-Check: PASSED
- `src/bin.ts` exists and functions as executable entrypoint.
- `scripts/build-sea.mjs` exists and automates SEA creation.
- `dist/obsidian-livesync-headless` is an executable standalone binary.
- `tests/integration/packaged-binary.test.ts` exists and passes all tests.
- All commits created atomically per task.
