# Stack Research

**Domain:** Headless Self-hosted LiveSync-compatible local-directory synchronizer
**Researched:** 2026-09-03
**Confidence:** MEDIUM

## Recommendation

Build the CLI in **TypeScript 5.9.3** on **Node.js 24.20.0 LTS**, using ESM while developing and an esbuild-generated CommonJS bundle for release. Consume **`@vrtmrz/livesync-commonlib@0.1.21` exactly**, because that is the artefact pinned by the current immutable **`vrtmrz/obsidian-livesync@1.0.23`** release. Let Commonlib own LiveSync document IDs, chunking, compression, encryption, path obfuscation, remote settings, and PouchDB HTTP behavior. Do not independently reproduce those conventions.

Use Commonlib's root `DirectFileManipulator` and Node platform façade behind a project-owned compatibility adapter. This is feasible and bundles without native modules, but it is not a turnkey SDK: Commonlib is pre-1.0, the planned high-level file-client factory does not exist, `DirectFileManipulator.enumerate()` is currently empty/untested, and lifecycle/watch/conflict semantics are explicitly not final. Pinning, characterization tests, and an upgrade gate are therefore part of the stack—not optional process polish.

Persist local scan fingerprints, remote sequence checkpoints, applied revision provenance, pending operations, and schema version in Node's built-in **`node:sqlite`**. Use **Chokidar 5.0.0** only to trigger reconciliation; periodic and startup full scans remain authoritative. Validate YAML plus environment/CLI overrides with **Zod 4.5.4**. Emit project-owned JSON Lines logs to stderr and route Commonlib's logger callback into that sink; do not use Pino in the executable because Pino's official bundling design requires additional worker files.

Release one executable per supported OS/architecture using **esbuild 0.28.2**, the official Node 24.20.0 binary, Node SEA, and **postject 1.0.0-alpha.6**. This exact pipeline was smoke-tested during research with the pinned Commonlib package and recommended runtime libraries.

## Compatibility Anchor

| Item | Exact baseline | Evidence | Rule |
|------|----------------|----------|------|
| Self-hosted LiveSync | `1.0.23` | Release published 2026-09-02; tag commit `28e76701c41cbd25fd3527c45bb0e39c646fe4e8` | Treat the immutable release tag, not `main`, as the compatibility target. |
| Commonlib | `0.1.21` | `obsidian-livesync@1.0.23` declares the exact version in `package.json` and resolves it in lockfile v3 | Install the exact version without `^` or `~`. |
| Commonlib tarball integrity | `sha512-AGuZ3eqBP37HJXEkTSpJ5M5bvTx2lYNq+6Q5NuCPZeGdbv7g6cujGvccVR5ozGfKdHGSyFZND5x1oFS9crRhUg==` | Upstream lockfile and npm registry agree | CI must verify the lockfile entry and fail on drift. |
| Commonlib npm dist-tag | `next=0.1.21`; `latest=0.1.19` at research time | npm registry metadata | Never resolve compatibility through `latest`; it currently selects a different artefact. |
| PouchDB protocol packages | `9.0.0` | Commonlib 0.1.21 depends on the modular PouchDB 9 packages; npm reports 9.0.0 as current | Do not add a second PouchDB version or the `pouchdb` umbrella package. |
| CouchDB integration target | `3.5.2.1` official image; CouchDB `3.5.2` software/docs | Apache documentation and official image metadata | Pin the test image by immutable digest in CI after selecting runner architecture. |

### Exact-version resolution strategy

1. Record a compatibility tuple in source control: upstream release tag, tag commit SHA, Commonlib package version, Commonlib tarball integrity, and the lockfile version.
2. Declare `@vrtmrz/livesync-commonlib` with an exact version and commit `package-lock.json`; builds use `npm ci`, never `npm install`.
3. Copy the selected upstream release's npm overrides for PouchDB's `uuid` dependency. For 1.0.23, both `pouchdb-core` and `pouchdb-utils` override `uuid` to `11.1.1`.
4. In CI, compare the compatibility tuple against the selected upstream tag's `package.json` and `package-lock.json`, then verify the installed Commonlib package version. A mismatch is a hard failure.
5. Upgrade only in a dedicated compatibility change. Select a newer immutable LiveSync release first, derive its Commonlib version and integrity, inspect package/export and transitive-lock diffs, regenerate protocol fixtures, and run mixed-client tests before changing the tuple.
6. Do not follow `main`, Commonlib canary/next tags, Git SHAs, source-directory imports, submodules, or TypeScript path aliases in production.

This strategy is more important than choosing the newest package version. The compatibility authority is the exact Commonlib artefact reviewed with a specific Self-hosted LiveSync release.

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | `24.20.0` LTS | Runtime and embedded SEA executable | Current production LTS as of research; satisfies Commonlib and Chokidar requirements; includes `fetch`, Web Crypto, `Blob`, `node:sqlite`, and SEA support. Pinning the runtime also pins crypto, V8, SQLite, and executable behavior. |
| npm | `11.19.0` bundled with Node 24.20.0 | Deterministic dependency installation | Use the npm shipped in the selected official Node distribution and lockfile v3 with `npm ci`. |
| TypeScript | `5.9.3` | Application language and static checks | Exact compiler used by the targeted LiveSync release and Commonlib repository. This minimizes declaration and emitted-semantics divergence. |
| `@vrtmrz/livesync-commonlib` | `0.1.21` exact | LiveSync file document, chunk, compression, encryption, obfuscation, negotiation, and remote-watch compatibility | It is the exact package pinned by LiveSync 1.0.23 and exposes a deliberate direct-CouchDB integration API. Reusing it is the highest-leverage compatibility decision. |
| PouchDB modular packages | `9.0.0`, transitively supplied by Commonlib | CouchDB HTTP adapter, changes feed, revision handling, selectors, and transforms | Commonlib constructs `pouchdb-core` with `pouchdb-adapter-http`, replication, find, map/reduce, and transform plugins. Keeping its composition avoids duplicate plugin registries and version skew. |
| `node:sqlite` | Node 24.20.0 built-in; embedded SQLite `3.53.4` | Durable local checkpoint, revision provenance, pending-operation, and file-fingerprint state | Transactional local state is required for crash-safe reconciliation. The built-in module avoids native addons and external shared libraries, preserving SEA portability. It is Stability 1.2 (release candidate), so keep it behind a repository interface and test backups/migrations. |
| Node SEA | Node 24.20.0, Stability 1.1 | Single executable distribution | Official Node mechanism; embeds the bundled application into the exact Node binary and does not require Node on the target host. |

### Commonlib entry points

| Entry point | Use | Constraint |
|-------------|-----|------------|
| `@vrtmrz/livesync-commonlib` | Construct `DirectFileManipulator` for direct CouchDB file operations | This is the preferred integration surface, but it is pre-1.0 and not a complete synchronization lifecycle. Wrap it. |
| `@vrtmrz/livesync-commonlib/node` | `createNodeStorage`, path validation, Node standard I/O façade | Supported Node boundary. Compose temp-write plus its `rename()` operation for atomic file replacement; its direct `write()` truncates the destination in place. |
| `@vrtmrz/livesync-commonlib/context` | Instance-owned event and standard-I/O contracts if needed | Use only if the host composition needs the focused contract. |
| `@vrtmrz/livesync-commonlib/compat/common/logger` | Bridge Commonlib log events into the CLI logger | Migration-only API. Isolate this import in the compatibility adapter and test it at every Commonlib upgrade. |
| Other `compat/*` paths | Only when no deliberate entry point exposes a required, already-upstream behavior | Every use requires an adapter, a source comment naming the target upstream release, and characterization coverage. Do not make compat types pervasive in application code. |

### Supporting Libraries

| Library/API | Version | Purpose | When to Use |
|-------------|---------|---------|-------------|
| Chokidar | `5.0.0` exact | Cross-platform recursive filesystem event normalization | Daemon mode only. Configure atomic-write normalization and bounded `awaitWriteFinish`; convert every event into a queued rescan/reconcile request. Always retain startup and periodic scans because both Node and Chokidar document missed/unreliable event cases. |
| Zod | `4.5.4` exact | Runtime configuration validation and typed normalization | Validate the fully merged CLI/environment/YAML object with a strict schema before creating storage, opening state, or making a network request. Reject unknown keys and invalid combinations. |
| YAML | `2.9.0` exact | Human-readable configuration parsing | Parse one YAML 1.2 document with `parseDocument`, inspect errors/warnings, then convert to plain data and pass it to Zod. Keep secrets optional in YAML so operators can supply them via environment or dedicated secret files. |
| `node:util.parseArgs` | Node 24 built-in | CLI option parsing | Sufficient for one-shot and daemon commands without another runtime dependency. Keep command dispatch project-owned and explicit. |
| Web `fetch` supplied by Node | Node 24 built-in | Optional injected PouchDB transport | Pass a wrapped `globalThis.fetch` through `DirectFileManipulatorRuntimeOptions` only to implement timeouts, TLS policy, request correlation, and safe diagnostics. Do not alter CouchDB request/response semantics. |
| Internal JSON Lines logger | Project-owned, no package | Structured unattended-operation logging | Write logs to stderr and command output to stdout. Redact passwords, passphrases, Authorization headers, credential-bearing URLs, and configuration objects before serialization. |

### Development and Test Tools

| Tool | Version | Purpose | Notes |
|------|---------|---------|-------|
| esbuild | `0.28.2` exact | Bundle ESM TypeScript and all runtime dependencies into one CommonJS file | Build with `bundle: true`, `platform: "node"`, `target: "node24"`, `format: "cjs"`. Built-in `node:*` modules remain external because they are in the embedded runtime. Produce a metafile and reject unexpected native `.node` files or unresolved runtime imports. |
| postject | `1.0.0-alpha.6` exact | Inject Node 24 SEA preparation blob into the official Node binary | It is under the Node.js GitHub organization and is the injector used by Node 24's official SEA instructions, but remains alpha; pin exactly and smoke-test every platform artefact. |
| Vitest | `4.1.11` exact | Unit, contract, property-style, and integration test runner | Same major/current minor family used upstream. Run serially for tests sharing fake clocks, global Commonlib logger state, filesystem roots, or CouchDB fixtures. |
| `@vitest/coverage-v8` | `4.1.11` exact | Coverage | Keep version exactly aligned with Vitest. Coverage is secondary to protocol fixture and fault-injection coverage. |
| `@testcontainers/couchdb` | `12.1.0` exact | Real CouchDB integration tests | Launch the official CouchDB image with ephemeral credentials. Pin the image version/digest; never point tests at a private or user database. |
| `@types/node` | `24.10.13` exact | Node 24 type declarations | Match the upstream toolchain's Node 24 declaration line rather than the registry's newest Node 26 types. |
| `@types/pouchdb-core` | `7.0.15` exact | Global `PouchDB.Core` declarations referenced by Commonlib's published `.d.ts` | Development-only compatibility shim. Commonlib runtime remains PouchDB 9. |

## Direct Commonlib Consumption: Feasibility and Limits

**Verdict: feasible and recommended, with an explicit compatibility wrapper.**

The published 0.1.21 package is ESM-only and declares Node `>=20`. Its root export is `DirectFileManipulator`, whose options cover the CouchDB URL/database/credentials, encryption passphrase, path-obfuscation passphrase, dynamic iteration count, chunk sizing/splitter, hashing, compression, filename case sensitivity, Eden behavior, and E2EE algorithm. It also accepts an injected `fetch`. Internally it creates an HTTP PouchDB instance and does not require LevelDB for this direct-access path.

Use it for these protocol-sensitive operations:

- path-to-document-ID and document-ID-to-path conversion;
- loading and assembling chunked or encrypted file entries;
- writing LiveSync-compatible file documents and chunks;
- writing logical deletion revisions through `delete()`;
- remote sync-parameter and PBKDF2-salt handling;
- remote change observation and document materialization.

Do not mistake it for a complete synchronization engine:

- Commonlib states that it is not yet a general-purpose SDK and that `DirectFileManipulator` enumeration, watch ownership, failures, conflicts, concurrency, readiness, and disposal are not stable contracts.
- The planned `createLiveSyncFileClient` factory is not implemented.
- `DirectFileManipulator.enumerate()` is an empty, explicitly untested implementation in 0.1.21. The concrete `enumerateAllNormalDocs()` method does yield records, but it needs characterization tests before use.
- `beginWatch()` owns an in-memory sequence and reconnect behavior. Persist the accepted remote sequence in project state only after the corresponding local operation and provenance transaction commit.
- The project must own startup ordering, first-contact read-only negotiation, retries, cancellation, idempotency, local scan reconciliation, and fail-closed decisions.
- Commonlib's broad dependency declaration includes browser, S3, and P2P packages. Import only deliberate root/Node entry points and let esbuild tree-shake unreachable code; do not expose or initialize out-of-scope providers.

Recommended TypeScript settings are `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `target: "ES2023"`, `strict: true`, `verbatimModuleSyntax: true`, `noEmit: true`, and `skipLibCheck: true`. The last setting matches Commonlib's own build and is currently needed because its declaration graph references legacy PouchDB globals, optional Svelte declarations, and older DefinitelyTyped buffer shapes. Keep `@types/pouchdb-core` installed, and compensate for skipped dependency checks with API-level compile fixtures and runtime contract tests. Do not disable strict checks for project source.

## CouchDB and PouchDB Position

Use Commonlib's PouchDB HTTP composition as the remote transport. Do **not** create a local PouchDB/LevelDB replica merely to synchronize a directory: it introduces native `leveldown`, duplicates local state, expands conflict paths, and complicates SEA packaging. `node:sqlite` is only local bookkeeping; CouchDB plus Commonlib remain authoritative for protocol data.

The daemon must respect these verified CouchDB semantics:

- `_changes?style=all_docs` is needed when all leaf revisions matter; `include_docs=true` alone returns only the winning body.
- The `since` token is opaque and meaningful only for that database. Persist it verbatim and invalidate it when database identity/configuration changes.
- `_bulk_docs` is non-atomic. Check every result and never advance a batch checkpoint over a partial failure.
- A deterministic CouchDB/PouchDB winner is not proof of ancestry, recency, or safety. Preserve unresolved leaves and require proven lineage before automated resolution.
- Logical deletion is a new `_deleted` revision; it is not purge, compaction, or database maintenance.

Mirror the target LiveSync release's overrides:

```json
{
  "overrides": {
    "pouchdb-core": {
      "uuid": "11.1.1"
    },
    "pouchdb-utils": {
      "uuid": "11.1.1"
    }
  }
}
```

This is present in `obsidian-livesync@1.0.23`. In the research smoke project it also removed the registry audit finding caused by PouchDB's older default `uuid` resolution. Do not add overrides that are absent from the selected upstream compatibility release without a separate protocol test and rationale.

## Filesystem and Local State

Use `createNodeStorage({ rootPath })` for rooted path validation and symlink rejection, but add project-owned safe reflection around it:

1. materialize remote content to a unique temporary sibling;
2. flush and close it;
3. preserve required timestamps;
4. atomically rename it into place;
5. update SQLite provenance/checkpoint state in the serialized reconciliation flow;
6. suppress or identify the resulting watcher echo by proven content/revision identity, not a timing-only debounce.

Place the SQLite state database outside the synchronized vault by default, under the platform state directory or an explicit `--state-dir`. Never let the watcher upload its own database, WAL, journal, lock, temporary materialization, or recovery files.

Chokidar events are hints. Node documents that filesystem watching may be unreliable on NFS, SMB, Docker bind mounts, and some virtualized filesystems; Chokidar's official tracker also has an open v5 race where files created during new-directory watcher registration can be missed. Run a full scan at startup, after watcher readiness, after overflow/error/reconnect, and periodically. Provide an opt-in polling mode for filesystems where native events are unreliable.

## Configuration and Logging

Use this precedence, with each layer parsed before the final strict validation:

1. safe built-in defaults;
2. YAML configuration file;
3. environment variables and explicit secret-file references;
4. CLI flags.

Zod validation must complete before opening SQLite or contacting CouchDB. Separate connection identity from secrets, reject credential-bearing URLs where possible, and never serialize the resolved secret-bearing configuration. Remote-discovered LiveSync settings are a separate compatibility object and must be validated before enabling writes; local defaults must not silently replace missing or unknown remote values.

Do not add Pino 10.3.1 to the release executable. Pino's official bundling documentation says its worker-thread architecture requires separately generated worker and transport files plus runtime path overrides. That conflicts with a strict one-file SEA and creates failure modes when assets are not real filesystem modules. A small internal JSON Lines logger is sufficient and easier to audit for secret redaction. If human-readable logs are wanted, format them in a separate shell process; do not embed a pretty-print transport.

Bridge `@vrtmrz/livesync-commonlib/compat/common/logger`'s `setGlobalLogFunction` into the internal sink at process startup. Map Commonlib levels to the CLI's levels, serialize `Error` values safely, include a stable event/component key, and redact before interpolation. Because this is a compat export and global hook, isolate it and reset it in tests.

## Single-Executable Packaging

### Release pipeline

1. Install with the pinned Node 24.20.0/npm 11.19.0 toolchain and `npm ci`.
2. Typecheck and run tests.
3. Bundle the ESM TypeScript entry to one CommonJS file with esbuild 0.28.2 using `platform=node`, `target=node24`, and no package externals. Only `node:*` built-ins may remain external.
4. Inspect esbuild's metafile. Fail if the bundle contains a `.node` addon, unresolved file-relative runtime load, out-of-scope P2P/Object Storage entry point, or a second PouchDB version.
5. Download the exact official Node 24.20.0 binary for the target OS/architecture and verify its published SHA-256 checksum.
6. Generate the SEA blob with that same binary. Set `useSnapshot: false`, `useCodeCache: false`, and `execArgvExtension: "none"` for predictable cross-build behavior and to prevent `NODE_OPTIONS` from changing unattended runtime semantics.
7. Inject with postject 1.0.0-alpha.6. On macOS remove the existing signature before injection and sign/notarize the result; sign Windows artefacts where releases support it.
8. Run the produced executable on the target runner, including `--version`, invalid-config, empty-vault one-shot, daemon shutdown, encrypted fixture round-trip, and CouchDB reconnect tests. Publish a SHA-256 checksum and provenance for every artefact.

Build separately for Linux x64/arm64, macOS x64/arm64, and Windows x64. A single executable means one self-contained file per platform/architecture; no one native binary can cover all targets. Prefer native target runners for signing and final smoke tests even though Node permits limited cross-platform SEA generation.

Node 24 SEA remains Stability 1.1 and postject remains alpha, which is why packaging confidence is MEDIUM rather than HIGH. Node 26.8.1 has the simpler built-in `--build-sea` flow and supports ESM main scripts, but it is Current—not LTS—on 2026-09-03. Move to Node 26 only after it reaches LTS and passes the complete compatibility/package matrix.

### Research smoke result

A temporary, credential-free spike installed the exact Commonlib package plus Chokidar 5.0.0, YAML 2.9.0, and Zod 4.5.4; TypeScript 5.9.3 typechecked it with the recommended dependency-boundary settings. esbuild produced a runnable 2.6 MB CommonJS bundle. The checksum-verified official Node 24.20.0 Linux x64 binary plus postject produced a runnable 124 MB SEA. The smoke test imported `DirectFileManipulator` and the Node storage façade; it did not connect to a database or validate full encrypted synchronization, which remains an integration-test requirement.

Importing the PouchDB 9 path on Node 24 emits the known Node `DEP0040` warning from a transitive `punycode` use. Do not suppress all deprecations. If release UX requires suppression, suppress only `DEP0040` after the compatibility suite proves the warning is the known transitive path, and continue tracking it as upstream debt.

## Testing Stack and Required Layers

| Layer | Tool | Required coverage |
|-------|------|-------------------|
| Pure unit | Vitest | Path normalization, config precedence/redaction, state transitions, operation ordering, retry policy, and deletion classification. |
| Commonlib characterization | Vitest + pinned package | Every consumed root, Node, and compat method; initialization rejection, encrypted/chunked reads and writes, obfuscated paths, deletes, enumeration workaround, watch cancellation, and error propagation. |
| Protocol fixtures | Vitest + immutable fixture corpus | Documents produced by `obsidian-livesync@1.0.23` for plain/binary, chunk variants, compression, E2EE algorithms, path obfuscation, tombstones, legacy records, and multiple conflict leaves. |
| Real database integration | Testcontainers CouchDB | First-contact read-only negotiation, `_changes` checkpoints, reconnects, partial `_bulk_docs` failure, auth/TLS errors, database identity change, revisions/conflicts, and concurrent upstream client writes. |
| Filesystem integration | Temporary real directories | Atomic editor saves, rename storms, case collisions, symlinks, permission failures, locked files, watcher gaps, polling mode, crash between file/state commits, and recovery. |
| Mixed-client end to end | Built CLI + real CouchDB + upstream client fixture/harness | Upstream writes → headless pull; headless writes/deletes → upstream read; simultaneous edits; no history purge; encrypted round trips. |
| Packaging | Per-platform SEA artefact | Starts without Node/npm/files beside it, finds built-ins and SQLite, handles signals, watches, connects to an ephemeral CouchDB, and emits no secrets. |

Do not mock PouchDB or CouchDB for the compatibility acceptance suite. Mocks are useful for deterministic unit failures but cannot establish revision-tree, changes-feed, authentication, or bulk-write behavior.

## Installation

```bash
# Runtime dependencies: exact pins
npm install --save-exact \
  @vrtmrz/livesync-commonlib@0.1.21 \
  chokidar@5.0.0 \
  yaml@2.9.0 \
  zod@4.5.4

# Development/build/test dependencies: exact pins
npm install --save-dev --save-exact \
  typescript@5.9.3 \
  @types/node@24.10.13 \
  @types/pouchdb-core@7.0.15 \
  esbuild@0.28.2 \
  postject@1.0.0-alpha.6 \
  vitest@4.1.11 \
  @vitest/coverage-v8@4.1.11 \
  @testcontainers/couchdb@12.1.0
```

After adding the upstream `overrides` block, run the selected npm once to generate `package-lock.json`, review the full resolution, and thereafter use `npm ci`. Configure `save-exact=true` in the repository `.npmrc` so direct dependency updates cannot silently introduce ranges.

## Alternatives Considered

| Recommended | Alternative | Why Not Now / When the Alternative Wins |
|-------------|-------------|------------------------------------------|
| Node 24.20.0 LTS | Node 22 LTS | The upstream CLI's 1.0.23 Dockerfile uses Node 22, so retain a Node 22 compatibility test lane. Node 24 is the better release runtime because it is the latest LTS, has a longer support horizon, and promotes `node:sqlite` to release candidate. |
| Node 24 SEA + postject | Node 26 `--build-sea` | Node 26 removes postject and supports ESM directly, but it is Current on the research date. Adopt after LTS transition and soak testing. |
| Exact Commonlib artefact | Copy/fork Commonlib source | A fork immediately creates protocol drift and loses the reviewed package boundary. Fork only as a short-lived upstream contribution workflow, never as the default runtime dependency. |
| Commonlib `DirectFileManipulator` | Bare `fetch`, Nano, or custom CouchDB client | Fine for database administration, but unsafe for LiveSync file payloads because the project would need to reproduce IDs, chunks, encryption, compression, settings, and deletion behavior. |
| HTTP-only PouchDB through Commonlib | Local PouchDB with LevelDB | A local replica may help a different offline-first product, but here it duplicates state and adds native `leveldown`, harming SEA portability. |
| `node:sqlite` local state | `better-sqlite3` | Mature API, but a native addon must be built per target ABI and extracted or loaded from a real path, undermining one-file SEA reliability. Use it only if built-in SQLite proves functionally insufficient. |
| Chokidar plus periodic scans | Raw `fs.watch` only | Raw watching has platform inconsistencies and no normalization. Use it only for a deliberately platform-specific implementation that still reconciles by scan. |
| Internal JSON Lines logger | Pino 10.3.1 | Pino is excellent when multiple bundle assets or installed modules are acceptable. Its official bundling requirements conflict with this strict one-file executable. |
| YAML + Zod | JSON-only configuration | JSON is simpler and may be offered as a machine-generated format. YAML is more suitable for unattended operator configuration when parsed strictly and validated afterward. |
| TypeScript/Node | Rust or Go | They produce compact native binaries, but cannot directly consume Commonlib. Choose them only if single-binary size outranks LiveSync compatibility and the team accepts a full protocol reimplementation and differential test program. |
| Node SEA | Bun/Deno compile or archived `pkg` | These can be attractive for generic CLIs, but Commonlib explicitly targets Node and depends on Node/PouchDB behavior. Runtime substitution adds compatibility risk; `pkg` is no longer an appropriate greenfield foundation. |

## What Not to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@vrtmrz/livesync-commonlib@latest` | Resolves to 0.1.19 at research time, not the 0.1.21 artefact pinned by LiveSync 1.0.23 | Resolve from the selected upstream release's exact package and lockfile. |
| Semver ranges for Commonlib | Pre-1.0 contracts and compat exports can change between releases | Exact version plus lock integrity and upgrade review. |
| Commonlib source aliases/submodules | Upstream calls these unsupported package boundaries | Published package exports only. |
| A second direct PouchDB dependency | Can create separate plugin constructors, duplicate versions, and behavior skew | Use Commonlib's PouchDB composition; add types only as a dev dependency. |
| `pouchdb-adapter-leveldb` / `leveldown` | Native addon and unnecessary local replica | Commonlib HTTP adapter plus built-in SQLite state. |
| Chokidar events as the source of truth | Watchers can coalesce, reorder, or miss events | Durable state plus startup/periodic/after-error reconciliation scans. |
| Pino transports or `pino-pretty` inside the binary | Require worker/transport files and runtime path resolution | Internal stderr JSON Lines; external formatting process. |
| Secrets in YAML, logs, command history, or SQLite | Credential/passphrase disclosure and accidental synchronization | Environment variables, explicit protected secret files, stdin where suitable, and mandatory redaction. |
| Node 25 | EOL as of 2026-03-31 | Node 24 LTS now; consider Node 26 after LTS. |
| Database purge, compact, reset, rebuild, or drop APIs | Outside scope and incompatible with fail-safe remote handling | Expose only file-level logical deletion and read-only discovery/verification operations. |

## Version Compatibility

| Package/runtime | Compatible With | Notes |
|-----------------|-----------------|-------|
| `obsidian-livesync@1.0.23` | `@vrtmrz/livesync-commonlib@0.1.21` | Exact upstream declaration and lock resolution; this is the primary compatibility pair. |
| `@vrtmrz/livesync-commonlib@0.1.21` | Node `>=20` | ESM-only package. Recommended release runtime is Node 24.20.0. |
| `@vrtmrz/livesync-commonlib@0.1.21` | PouchDB modular packages `^9.0.0` | 9.0.0 is current; lock exact resolutions and apply upstream UUID overrides. |
| `chokidar@5.0.0` | Node `>=20.19.0` | ESM-only; works in ESM source and an esbuild CommonJS release bundle. |
| `vitest@4.1.11` | Node `^20 || ^22 || >=24` | Supports the selected Node 24 line. Keep coverage plugin at the identical version. |
| `typescript@5.9.3` | Upstream LiveSync/Commonlib declarations | Do not jump to TypeScript 7 merely because it is the registry latest; compiler alignment is more valuable here. |
| `esbuild@0.28.2` | Node `>=18`; target `node24` | Build-time only. |
| `postject@1.0.0-alpha.6` | Node 24 SEA workflow | Build-time only and exact-pinned because it is alpha. |
| `node:sqlite` in Node 24.20.0 | SQLite 3.53.4 | Release-candidate API; isolate behind a repository and migration boundary. |

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| Upstream compatibility pin | MEDIUM | Cross-checked between immutable GitHub release files and npm registry metadata; the research confidence seam caps verified web findings at MEDIUM. |
| Direct Commonlib feasibility | MEDIUM | Confirmed from the published artefact, declarations/source, and a bundle/SEA import smoke test. Full encrypted, conflicted, and mixed-client behavior still requires project integration tests. |
| Node/runtime choice | MEDIUM | Node 24.20.0 is official LTS and matches all package engine ranges, but SEA remains Stability 1.1 and `node:sqlite` Stability 1.2. |
| CouchDB/PouchDB choice | MEDIUM | Official APIs and exact upstream dependencies agree; correctness still depends on conservative project-owned reconciliation and real conflict fixtures. |
| Filesystem watching | MEDIUM | Chokidar is current and pure JavaScript, but official runtime docs and an upstream open issue confirm that event delivery cannot be authoritative. |
| Packaging | MEDIUM | Exact recommended Linux x64 pipeline was executed successfully; other OS/architecture builds, signing, and full synchronization must be verified in CI. |
| Configuration/logging/testing | MEDIUM | Versions and constraints are from official metadata/docs; the internal logger and project-specific schemas remain to be implemented and tested. |

## Open Validation Items

- Verify encrypted uploads/downloads for every E2EE algorithm accepted by the targeted 1.0.23 clients; the packaging spike validated imports, not cryptographic interoperability.
- Characterize `enumerateAllNormalDocs()`, remote watch reconnects, callback failures, `close()`, and conflict-leaf access against CouchDB 3.5.2.1.
- Determine the minimum supported historical CouchDB 3.x release from actual user requirements; do not claim broad 2.x/3.x compatibility from PouchDB's generic support statement.
- Verify Node 24 SEA builds and signing on every promised target, especially macOS and Windows.
- Confirm whether the transitive `DEP0040` warning can remain visible or should be selectively suppressed in release artefacts.
- Re-evaluate Node 26 and built-in `--build-sea` after Node 26 enters LTS.

## Primary Sources

All confidence labels below are **MEDIUM**, as returned by the research confidence classifier after cross-checking.

### Self-hosted LiveSync and Commonlib

- [Self-hosted LiveSync 1.0.23 release](https://github.com/vrtmrz/obsidian-livesync/releases/tag/1.0.23) — release date and immutable tag commit.
- [LiveSync 1.0.23 `package.json`](https://github.com/vrtmrz/obsidian-livesync/blob/1.0.23/package.json) — exact Commonlib dependency, TypeScript, Vitest, and PouchDB UUID overrides.
- [LiveSync 1.0.23 `package-lock.json`](https://github.com/vrtmrz/obsidian-livesync/blob/1.0.23/package-lock.json) — lockfile version, Commonlib tarball URL/integrity, and transitive resolutions.
- [LiveSync CLI package](https://github.com/vrtmrz/obsidian-livesync/blob/1.0.23/src/apps/cli/package.json) — upstream CLI PouchDB/Chokidar/test stack.
- [LiveSync CLI Dockerfile](https://github.com/vrtmrz/obsidian-livesync/blob/1.0.23/src/apps/cli/Dockerfile) — upstream Node 22 runtime and native LevelDB packaging reference.
- [Commonlib repository and README](https://github.com/vrtmrz/livesync-commonlib) — package status, supported entry points, Node requirement, and explicit API stability limits.
- [Commonlib npm metadata](https://registry.npmjs.org/@vrtmrz%2flivesync-commonlib/0.1.21) — exact published version, engines, exports, dependencies, optional peer, and integrity.
- [Commonlib Node storage contract](https://github.com/vrtmrz/livesync-commonlib/blob/main/docs/platform-storage.md) — rooted storage, path/symlink rules, and host responsibilities.
- [Commonlib proven-in-use contract](https://github.com/vrtmrz/livesync-commonlib/blob/main/docs/proven-in-use.md) — exercised downstream boundaries and remaining limits.

### Runtime and packaging

- [Node.js release status](https://nodejs.org/en/about/previous-releases) — Node 24.20.0 Latest LTS, Node 26.8.1 Current, and production LTS guidance.
- [Node 24.20.0 SEA documentation](https://nodejs.org/download/release/v24.20.0/docs/api/single-executable-applications.html) — CommonJS bundle requirement, same-binary rule, postject flow, assets, code cache, snapshot, and cross-platform constraints.
- [Node 26.8.1 SEA documentation](https://nodejs.org/download/release/v26.8.1/docs/api/single-executable-applications.html) — built-in `--build-sea` and ESM support used for the future-runtime recommendation.
- [Node 24.20.0 SQLite documentation](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html) — `node:sqlite` API and Stability 1.2 status.
- [Node `util.parseArgs`](https://nodejs.org/download/release/v24.20.0/docs/api/util.html#utilparseargsconfig) — stable built-in CLI parser.
- [esbuild API](https://esbuild.github.io/api/) — Node platform behavior, CJS output, bundling, conditions, and externals.
- [esbuild npm metadata](https://registry.npmjs.org/esbuild/0.28.2) — exact version and engine requirement.
- [nodejs/postject repository](https://github.com/nodejs/postject) — official injector implementation and usage.
- [postject npm metadata](https://registry.npmjs.org/postject/1.0.0-alpha.6) — exact alpha version and engine requirement.

### CouchDB, PouchDB, filesystem, and support libraries

- [PouchDB API](https://pouchdb.com/api.html) — HTTP CouchDB client, changes, replication, revisions, deletion, and conflicts.
- [PouchDB conflict guide](https://pouchdb.com/guides/conflicts.html) — CouchDB-compatible conflict model and explicit resolution responsibility.
- [PouchDB npm metadata](https://registry.npmjs.org/pouchdb/9.0.0) — current exact release metadata.
- [Apache CouchDB `_changes`](https://docs.couchdb.org/en/stable/api/database/changes.html) — feed modes, checkpoints, `style=all_docs`, and `include_docs` behavior.
- [Apache CouchDB bulk API](https://docs.couchdb.org/en/stable/api/database/bulk-api.html) — non-atomic `_bulk_docs` and per-result conflict handling.
- [Apache CouchDB replication protocol](https://docs.couchdb.org/en/stable/replication/protocol.html) — changes feed and revision-leaf requirements.
- [Apache CouchDB 3.5.2 release notes](https://docs.couchdb.org/en/stable/whatsnew/3.5.html) — current stable software documentation.
- [Official CouchDB container image](https://hub.docker.com/_/couchdb/) — current 3.5.2/3.5.2.1 tags and supported architectures.
- [Chokidar 5.0.0 release](https://github.com/paulmillr/chokidar/releases/tag/5.0.0) — ESM-only status and Node 20.19 minimum.
- [Chokidar README](https://github.com/paulmillr/chokidar) — event normalization, atomic writes, and `awaitWriteFinish`.
- [Chokidar v5 missed-file race](https://github.com/paulmillr/chokidar/issues/1471) — official upstream issue establishing why scans remain authoritative.
- [Node filesystem watch caveats](https://nodejs.org/download/release/v24.20.0/docs/api/fs.html#fswatchfilename-options-listener) — platform and network/virtual filesystem limitations.
- [Zod repository](https://github.com/colinhacks/zod) and [Zod npm metadata](https://registry.npmjs.org/zod/4.5.4) — validation API and exact release.
- [YAML official documentation](https://eemeli.org/yaml/) and [YAML npm metadata](https://registry.npmjs.org/yaml/2.9.0) — YAML 1.2 parsing, document diagnostics, and exact release.
- [Pino bundling documentation](https://github.com/pinojs/pino/blob/main/docs/bundling.md) — required extra worker/transport files underlying the rejection for strict SEA packaging.
- [Vitest 4 guide](https://v4.vitest.dev/guide/) and [Vitest npm metadata](https://registry.npmjs.org/vitest/4.1.11) — Node requirements and exact test-runner release.
- [Testcontainers CouchDB module](https://node.testcontainers.org/modules/couchdb/) and [package metadata](https://registry.npmjs.org/@testcontainers%2fcouchdb/12.1.0) — official real-CouchDB test harness and exact version.

---
*Stack research for: obsidian-livesync-headless*
*Researched: 2026-09-03*
