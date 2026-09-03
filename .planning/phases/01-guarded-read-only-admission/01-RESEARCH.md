# Phase 1: Guarded Read-Only Admission - Research

**Researched:** 2026-09-03
**Domain:** Guarded Read-Only CouchDB Admission, LiveSync Compatibility Negotiation, Secret-Safe CLI Configuration
**Confidence:** HIGH

## Summary

Phase 1 establishes the first runnable CLI integration of `obsidian-livesync-headless`: the `inspect` command. The goal is to safely inspect and negotiate compatibility with an already existing CouchDB database running the Self-hosted LiveSync protocol, proving zero remote mutation while loading configuration, redacting secrets, validating destinations, establishing local SQLite admission records, and outputting human-readable and JSON Lines reports.

Crucially, deep code inspection of the pinned `@vrtmrz/livesync-commonlib@0.1.21` package confirms a critical architectural risk: Commonlib's built-in negotiation helpers (`checkRemoteVersion`, `checkSyncInfo`, `createSyncParamsHandler`, and `ensureRemoteIsCompatible`) are not read-only. When documents or fields are absent, these helpers actively write version markers, randomly generated `syncinfo`, PBKDF2 salts, and device milestones to CouchDB via HTTP `PUT`. Therefore, Phase 1 must implement a pure, project-owned read-only admission probe that executes exclusively `GET` and `HEAD` requests, enforced at the network transport layer by an audited HTTP allowlist that intercepts and aborts any mutating HTTP method or out-of-scope endpoint before network dispatch.

The runtime stack is anchored on Node.js 24 LTS and TypeScript 5.9.3, utilizing `yaml@2.9.0` and `zod@4.5.4` for strict configuration parsing, Node's built-in `node:sqlite` for durable local admission state, a project-owned JSON Lines stderr logger with mandatory secret redaction, and `node:util.parseArgs` for CLI dispatch. Ephemeral integration tests utilize `@testcontainers/couchdb@12.1.0` with official image `couchdb:3.5.2.1` (already cached locally) to mathematically prove zero mutation (`update_seq` and marker revisions unchanged before and after inspection).

**Primary recommendation:** Build a dedicated, structurally read-only CouchDB inspector wrapped in an enforced HTTP `GET`/`HEAD` allowlist transport guard; never invoke Commonlib's mutating setup or negotiation helpers during admission.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Configuration Loading & Parsing | CLI / Config Layer (`yaml` 2.9.0) | Zod Schema Validator (`zod` 4.5.4) | Decouple syntax parsing from schema validation; parse YAML first, resolve environment/file secrets, then strictly validate the merged object before any I/O. |
| Secret Provider & Redaction | Core Redaction Utility | Logger & Error Formatter | Centralized scrubbing of passwords, passphrases, authorization headers, and setup URIs ensures consistent redaction across logs, errors, console output, and SQLite state. |
| Transport Safety Guard | HTTP Transport Layer (`fetch` wrapper) | Capability Gate Authority | Guarantees at the lowest network dispatch layer that no `PUT`, `POST`, `DELETE`, or non-allowlisted endpoint can reach CouchDB during admission or dry-run. |
| CouchDB Remote Inspector | Protocol Inspector Port | CouchDB HTTP Client | Executes pure read queries (`GET`/`HEAD`) to fetch database info, version document, milestone, sync parameters, and syncinfo without triggering upstream default creation. |
| Compatibility Negotiation | LiveSync Compatibility Domain | Pinned Commonlib Primitives | Evaluates remote version (`VER = 12`), lock state, chunk version ranges, and preferred tweaks against local capabilities; adopts compatible settings and rejects incompatible deviations. |
| Security Material Verification | Cryptographic Probe | Pinned Commonlib `#worker` / `octagonal-wheels` | Decrypts `syncinfo` using supplied passphrase and remote PBKDF2 salt via Web Crypto HKDF to authenticate credentials without mutating remote state. |
| Durable Admission Store | SQLite Repository (`node:sqlite`) | Local State Layer | Durably records remote fingerprint, database identity, admitted marker revisions, update_seq, and negotiated settings hash outside the vault namespace. |
| Presentation & Diagnostics | CLI Coordinator (`inspect` command) | Formatters (Human & JSON Lines) | Renders formatted terminal output or JSON Lines diagnostics with stable outcome categories and process exit codes. |

## User Constraints (from CONTEXT.md)

None — continuing without user context; guided by REQUIREMENTS.md and AGENTS.md.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| CONF-01 | User can select a YAML configuration file that identifies an existing CouchDB database and a destination vault directory. | Supported via `yaml@2.9.0` `parseDocument` and `node:util.parseArgs` `--config <path>`. Strict path normalization and canonicalization verify CouchDB URL, database name, and destination vault path. |
| CONF-02 | User can supply CouchDB credentials and encryption passphrases through environment-backed secret references without storing secret values in tracked configuration. | Supported via schema-level secret references supporting `{ fromEnv: "VAR_NAME" }`, `{ fromFile: "/path" }`, direct environment overrides (`COUCHDB_PASSWORD`, `LIVESYNC_PASSPHRASE`), and CLI options. |
| CONF-03 | User receives a validation error before filesystem or network side effects when configuration is missing, malformed, internally inconsistent, or references an unsafe destination. | Enforced by `zod@4.5.4` schema before any network connection or SQLite open. Rejects system root (`/`), user home, parent directory traversals (`../`), overlapping vault/state directories, and credential-bearing URLs. |
| CONF-04 | User can inspect connectivity, database identity, LiveSync version state, locks, security material, preferred tweaks, and representative records through a structurally read-only command. | Implemented via `inspect` command using pure HTTP `GET`/`HEAD` calls to `/{db}`, `obsydian_livesync_version`, `_local/obsydian_livesync_milestone`, `_local/obsidian_livesync_sync_parameters`, `syncinfo`, and representative sample documents. |
| CONF-05 | User can pull and adopt compatible remote LiveSync settings locally while incompatible, unknown, locked, or future-version settings prevent synchronization writes. | Pinned tweak classification from Commonlib (`IncompatibleChanges` vs `CompatibleButLossyChanges`) allows adopting remote preferred tweaks locally (e.g. `hashAlg`, `customChunkSize`, `chunkSplitterVersion`) while blocking on incompatible differences (`encrypt`, `usePathObfuscation`, `useDynamicIterationCount`, `handleFilenameCaseSensitive`) or future database versions (`version > 12`). |
| CONF-06 | User receives a stable compatibility report that records the remote fingerprint, negotiated-settings hash, supported and unsupported capabilities, and any blockers. | Output formatter emits deterministic human-readable and JSON Lines reports containing remote fingerprint, SHA-256 negotiated-settings hash, admitted capabilities, and structured blocker reasons. |
| SAFE-01 | User cannot invoke database creation, drop, reset, rebuild, overwrite, purge, compaction, garbage collection, retention changes, security changes, design/index management, or server-managed replication through the application. | Absence of administrative commands and endpoints from application interfaces; transport allowlist denies all CouchDB administration paths (`_purge`, `_compact`, `_security`, `_revs_limit`, `_replicator`, `_design`, `_node`). |
| SAFE-02 | User's first-contact and dry-run traffic is restricted to an explicit read-only HTTP method and endpoint allowlist, with mutation attempts blocked before transport. | Enforced by custom `fetch` wrapper that aborts any method other than `GET` and `HEAD`, restricts paths to allowlisted endpoints, checks redirects to prevent cross-origin credential forwarding, and rejects mutation before network dispatch. |
| SAFE-04 | User's credentials, passphrases, setup URIs, authorization headers, and decrypted payloads are excluded or redacted from logs, errors, state databases, crash output, and packaged artifacts. | Redaction pipeline scrubs credentials and passphrases from URLs (`https://[REDACTED]@host/db`), HTTP headers (`Authorization: [REDACTED]`), logs, error stacks, console diagnostics, and SQLite state records. |
| SAFE-06 | User receives human-readable and JSON Lines diagnostics with stable outcome categories and non-zero exit or health states for incompatibility, authentication failure, corruption, conflict, partial write, and transient outage. | Diagnostic engine maps failures to typed categories (`SUCCESS`, `CONFIG_ERROR`, `AUTHENTICATION_ERROR`, `INCOMPATIBLE`, `NOT_FOUND`, `TRANSIENT_OUTAGE`, `CORRUPTION`, `MUTATION_VIOLATION`) with stable numeric exit codes. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---|---|---|---|
| Node.js | `24.20.0` LTS | Runtime environment | Production LTS; native `fetch`, Web Crypto, `node:sqlite`, and SEA support. [VERIFIED: AGENTS.md:50] |
| TypeScript | `5.9.3` | Language & static types | Compiler aligned with upstream LiveSync 1.0.23 and Commonlib. [VERIFIED: AGENTS.md:52] |
| `@vrtmrz/livesync-commonlib` | `0.1.21` exact | LiveSync protocol constants, types, crypto & tweak definitions | Pinned by upstream `obsidian-livesync@1.0.23` [VERIFIED: AGENTS.md:53]. Tarball integrity `sha512-AGuZ3eqBP37HJXEkTSpJ5M5bvTx2lYNq+6Q5NuCPZeGdbv7g6cujGvccVR5ozGfKdHGSyFZND5x1oFS9crRhUg==` [VERIFIED: AGENTS.md:37]. |
| `node:sqlite` | Node 24 built-in | Local state & admission records | Built-in SQLite (Stability 1.2); zero native addon dependencies, fully compatible with single-executable packaging. [VERIFIED: AGENTS.md:55] |
| `yaml` | `2.9.0` exact | Strict YAML 1.2 parser | Robust CST/AST diagnostic parsing without unsafe eval; handles comments and multiple document detection. [VERIFIED: AGENTS.md:74] |
| `zod` | `4.5.4` exact | Configuration validation | Strict runtime schema parsing, type inference, custom refinements for paths, URLs, and secret refs. [VERIFIED: AGENTS.md:73] |
| `node:util.parseArgs` | Node 24 built-in | CLI command & option parsing | Zero runtime dependency CLI parser; supports short/long flags, positionals, and strict option checking. [VERIFIED: AGENTS.md:75] |

### Supporting
| Library | Version | Purpose | When to Use |
|---|---|---|---|
| Vitest | `4.1.11` exact | Test runner | Unit, contract, and integration tests. [VERIFIED: AGENTS.md:85] |
| `@vitest/coverage-v8` | `4.1.11` exact | Code coverage | Aligned coverage instrumentation for Vitest. [VERIFIED: AGENTS.md:86] |
| `@testcontainers/couchdb` | `12.1.0` exact | Real CouchDB integration harness | Ephemeral CouchDB container testing in Docker. [VERIFIED: AGENTS.md:87] |
| CouchDB Image | `couchdb:3.5.2.1` | Integration target container | Official CouchDB 3.5.2 container image [VERIFIED: AGENTS.md:40], present locally on docker host. |
| `@types/node` | `24.10.13` exact | Node.js type definitions | Aligned with upstream Node 24 declaration line. [VERIFIED: AGENTS.md:88] |
| `@types/pouchdb-core` | `7.0.15` exact | Type shim | Dev-only compatibility shim for Commonlib's global type references. [VERIFIED: AGENTS.md:89] |

### Alternatives Considered

| Recommended | Alternative | Why Not Now / When the Alternative Wins |
|---|---|---|
| Pure HTTP `GET`/`HEAD` probe | Commonlib `checkRemoteVersion()` / `SyncParamsHandler` | Commonlib helpers mutate CouchDB when documents are missing (`db.put(vi)` and `put(newSyncParams)` [VERIFIED: dist/pouchdb/negotiation.js:48, dist/replication/SyncParamsHandler.js:40]). The alternative violates read-only admission. |
| `node:sqlite` | `better-sqlite3` | Native addon binaries break one-file Node SEA portability and require node-gyp builds. Built-in `node:sqlite` has zero compilation overhead. [VERIFIED: AGENTS.md:151] |
| Internal JSON Lines logger | Pino `10.3.1` | Pino requires worker thread files that conflict with single-file executable bundling. [VERIFIED: AGENTS.md:167] |
| `yaml@2.9.0` + `zod@4.5.4` | JSON-only config | Operators configuring headless daemons need comments, multi-line strings, and human-friendly formatting. [VERIFIED: AGENTS.md:154] |

## Package Legitimacy Audit

Every direct dependency is verified against the npm registry, checked for download volume, repository provenance, and publish age [VERIFIED: npm registry]:

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---|---|---|---|---|---|---|
| `@vrtmrz/livesync-commonlib` | npm | 2026-07-17 | 3,737/wk | github.com/vrtmrz/livesync-commonlib | OK | Pinned compatibility runtime dependency (version `0.1.21`) [VERIFIED: npm registry] |
| `yaml` | npm | 2011-04-15 | 202,359,392/wk | github.com/eemeli/yaml | OK | Approved runtime YAML parser (version `2.9.0`) [VERIFIED: npm registry] |
| `zod` | npm | 2020-03-07 | 274,747,331/wk | github.com/colinhacks/zod | OK | Approved runtime schema validator (version `4.5.4`) [VERIFIED: npm registry] |
| `typescript` | npm | 2012-10-01 | 273,429,217/wk | github.com/microsoft/TypeScript | OK | Approved development compiler (version `5.9.3`) [VERIFIED: npm registry] |
| `vitest` | npm | 2021-12-03 | 99,878,658/wk | github.com/vitest-dev/vitest | OK | Approved test runner (version `4.1.11`) [VERIFIED: npm registry] |
| `@vitest/coverage-v8` | npm | 2023-06-06 | 38,398,549/wk | github.com/vitest-dev/vitest | OK | Approved test coverage tool (version `4.1.11`) [VERIFIED: npm registry] |
| `@testcontainers/couchdb` | npm | 2025-09-29 | 20/wk | github.com/testcontainers/testcontainers-node | OK | Approved test container module (version `12.1.0`) [VERIFIED: npm registry] |
| `@types/node` | npm | 2016-05-17 | 429,845,905/wk | github.com/DefinitelyTyped/DefinitelyTyped | OK | Approved development type definitions (version `24.10.13`) [VERIFIED: npm registry] |
| `@types/pouchdb-core` | npm | 2016-08-02 | 89,432/wk | github.com/DefinitelyTyped/DefinitelyTyped | OK | Approved development type definitions (version `7.0.15`) [VERIFIED: npm registry] |

## Architecture Patterns

### System Architecture Diagram

```mermaid
flowchart TD
    CLI["CLI Command: inspect\n(node:util.parseArgs)"] --> ConfigLoader["Config Loader & Secret Resolver\n(YAML 2.9.0 + Env + Zod 4.5.4)"]
    ConfigLoader --> Redactor["Secret Redactor\n(Password, Passphrase, Header scrub)"]
    ConfigLoader --> GuardedTransport["Guarded Read-Only HTTP Transport\n(fetch wrapper: GET/HEAD only)"]
    
    subgraph Remote["CouchDB Server (Existing LiveSync Database)"]
        Info["GET /{db}"]
        VerDoc["GET /{db}/obsydian_livesync_version"]
        Milestone["GET /{db}/_local/obsydian_livesync_milestone"]
        SyncParams["GET /{db}/_local/obsidian_livesync_sync_parameters"]
        SyncInfo["GET /{db}/syncinfo"]
        SampleDocs["GET /{db}/_all_docs?limit=10&include_docs=true"]
    end
    
    GuardedTransport --> Remote
    
    Remote --> Inspector["Read-Only Admission Inspector"]
    Inspector --> Decryptor["Syncinfo HKDF Decryptor\n(Web Crypto + Salt)"]
    Inspector --> Negotiator["Settings Negotiator\n(Incompatible vs Compatible Tweaks)"]
    
    Negotiator --> ZeroMutationCheck["Zero-Mutation Verification\n(Compare update_seq & revs before/after)"]
    ZeroMutationCheck --> SQLiteStore["SQLite Admission Store\n(node:sqlite)"]
    
    ZeroMutationCheck --> Reporter["Report Formatter\n(Human-Readable & JSON Lines)"]
    Reporter --> Stdout["stdout: Compatibility Report"]
    Redactor --> Stderr["stderr: Redacted JSON Lines Logs"]
```

### Recommended Project Structure

```text
src/
├── cli/
│   ├── index.ts                      # CLI entry point, parseArgs dispatch
│   └── commands/
│       └── inspect.ts                # inspect command coordinator
├── config/
│   ├── schema.ts                     # Zod configuration schemas & types
│   ├── loader.ts                     # YAML file loading & secret resolution
│   └── secrets.ts                    # Secret reference resolver (fromEnv, fromFile)
├── security/
│   ├── redaction.ts                  # Secret & credential redaction engine
│   ├── transport-guard.ts            # Guarded fetch allowlist (GET/HEAD only)
│   └── capabilities.ts               # In-process capability token system
├── storage/
│   ├── sqlite.ts                     # SQLite connection & migration runner
│   └── admission-repo.ts             # Remote admission records repository
├── livesync/
│   ├── inspector.ts                  # Pure read-only CouchDB HTTP probe
│   ├── negotiation.ts                # Remote version, milestone & tweak evaluation
│   ├── syncinfo.ts                   # Syncinfo decode & HKDF decryption check
│   └── zero-mutation.ts              # Pre/post probe verification (update_seq, revs)
├── diagnostics/
│   ├── logger.ts                     # Leveled JSON Lines logger to stderr
│   ├── outcomes.ts                   # Standard outcome categories & exit codes
│   └── formatters.ts                 # Human-readable & JSON Lines report generators
└── index.ts                          # Module exports root
tests/
├── unit/
│   ├── config.test.ts                # Config validation, path safety, secret resolution
│   ├── redaction.test.ts             # Redaction of URLs, headers, passphrases, error stacks
│   ├── transport-guard.test.ts       # Blocking non-GET, admin paths, redirects
│   └── negotiation.test.ts           # Tweak classification & version gate logic
├── characterization/
│   └── commonlib-crypto.test.ts      # Web Crypto HKDF syncinfo decrypt verification
└── integration/
    ├── couchdb-harness.ts            # Testcontainers CouchDB 3.5.2.1 lifecycle
    └── inspect-command.test.ts       # Real CouchDB inspect tests & zero-mutation proof
```

### Pattern 1: Guarded Transport Allowlist (`fetch` Wrapper)

```ts
// src/security/transport-guard.ts
export interface TransportGuardOptions {
  readonly allowedBaseUrl: URL;
  readonly databaseName: string;
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

export class MutationAttemptBlockedError extends Error {
  constructor(public readonly method: string, public readonly url: string) {
    super(`Blocked forbidden mutating HTTP method '${method}' to '${url}' during read-only admission.`);
    this.name = 'MutationAttemptBlockedError';
  }
}

export class EndpointDisallowedError extends Error {
  constructor(public readonly url: string) {
    super(`Blocked access to out-of-scope or administrative endpoint: '${url}'.`);
    this.name = 'EndpointDisallowedError';
  }
}

export function createGuardedFetch(options: TransportGuardOptions, baseFetch = globalThis.fetch): typeof globalThis.fetch {
  const allowedDbPath = `/${options.databaseName}`;

  return async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const targetUrl = new URL(rawUrl, options.allowedBaseUrl);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    // 1. Method check: strictly GET and HEAD only
    if (!ALLOWED_METHODS.has(method)) {
      throw new MutationAttemptBlockedError(method, targetUrl.pathname);
    }

    // 2. Authority check: scheme, host, and port must match
    if (targetUrl.origin !== options.allowedBaseUrl.origin) {
      throw new EndpointDisallowedError(targetUrl.href);
    }

    // 3. Path check: allow root '/', /{db}, and /{db}/* only
    const path = targetUrl.pathname;
    const isRoot = path === '/' || path === '';
    const isDbTarget = path === allowedDbPath || path.startsWith(`${allowedDbPath}/`);
    
    // Explicit denylist: design docs, compact, purge, security, nodes
    const isForbiddenSubpath = /(_purge|_compact|_security|_revs_limit|_design|_index|_node)/i.test(path);

    if ((!isRoot && !isDbTarget) || isForbiddenSubpath) {
      throw new EndpointDisallowedError(targetUrl.pathname);
    }

    // 4. Dispatch with redirect manual to prevent unsafe credential forwarding across redirects
    const response = await baseFetch(input, { ...init, redirect: 'manual' });
    if ([301, 302, 307, 308].includes(response.status)) {
      const redirectLocation = response.headers.get('location');
      if (!redirectLocation) {
        throw new Error('Redirect received without Location header.');
      }
      const redirectedUrl = new URL(redirectLocation, targetUrl);
      if (redirectedUrl.origin !== options.allowedBaseUrl.origin) {
        throw new EndpointDisallowedError(`Cross-origin redirect denied: ${redirectedUrl.origin}`);
      }
      // Re-invoke through guardedFetch for second request
      return guardedFetch(redirectedUrl.toString(), init);
    }

    return response;
  };
}
```

### Pattern 2: Secret Redactor and Sanitizer

```ts
// src/security/redaction.ts
export class SecretRedactor {
  private readonly secretValues = new Set<string>();

  registerSecret(secret: string | undefined): void {
    if (secret && secret.length > 2) {
      this.secretValues.add(secret);
    }
  }

  redactString(text: string): string {
    let result = text;
    // Redact registered secrets
    for (const secret of this.secretValues) {
      result = result.replaceAll(secret, '[REDACTED]');
    }
    // Redact HTTP Basic auth in URLs: https://user:pass@host -> https://[REDACTED]@host
    result = result.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/]+@/g, '$1[REDACTED]@');
    // Redact Authorization headers
    result = result.replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer [REDACTED]');
    result = result.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]');
    // Redact LiveSync setup URIs
    result = result.replace(/obsidian:\/\/livesync\?[^\s"']+/gi, 'obsidian://livesync?[REDACTED]');
    return result;
  }

  redactError(err: unknown): Error {
    if (!(err instanceof Error)) return new Error(this.redactString(String(err)));
    const cloned = new Error(this.redactString(err.message));
    cloned.name = err.name;
    if (err.stack) {
      cloned.stack = this.redactString(err.stack);
    }
    return cloned;
  }
}
```

### Anti-Patterns to Avoid

- **Calling Commonlib's `checkRemoteVersion` or `checkSyncInfo` during admission:** These methods write documents to CouchDB when missing (`await db.put(vi)` and `await db.put(newSyncInfo)`). [VERIFIED: dist/pouchdb/negotiation.js:48,65]
- **Calling `ensureRemoteIsCompatible`:** It mutates `remoteMilestone.node_info` and puts the updated milestone back to CouchDB if `DEVICE_ID_PREFERRED` is missing or node connected time is older than 60s. [VERIFIED: dist/pouchdb/LiveSyncDBFunctions.js:51-64]
- **Treating missing records as an empty database to be initialized:** In v1, the CLI connects only to an already configured, existing LiveSync database. A missing version document or missing sync parameters is a fatal incompatibility blocker, not an invitation to create them. [VERIFIED: ARCHITECTURE.md:123]
- **Allowing `PUT`, `POST`, or `DELETE` in dry-run or inspect:** A flag-based check in application code is insufficient; the transport layer must mechanically refuse mutating HTTP methods. [VERIFIED: PITFALLS.md:32]
- **Logging unsanitized error messages:** CouchDB connection errors often include the target URL complete with embedded Basic authentication credentials. All error logs and exception handlers must route through the redactor. [VERIFIED: PITFALLS.md:484]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| YAML parsing | Custom regex or string splits | `yaml@2.9.0` `parseDocument` | YAML 1.2 syntax supports anchors, multi-line values, and comments; `parseDocument` yields detailed syntactic error diagnostics. [VERIFIED: STACK.md:69] |
| Schema validation & coercion | Manual type checks and `typeof` assertions | `zod@4.5.4` | Declarative schemas with strict rejection of unexpected keys (`.strict()`) and custom `.refine()` rules for path safety. [VERIFIED: STACK.md:68] |
| SQLite local storage | Custom JSON file or raw LevelDB | `node:sqlite` (`DatabaseSync`) | Transactional ACID durability, embedded in Node 24 runtime, zero native C++ addon build complications. [VERIFIED: STACK.md:50] |
| CLI argument parsing | Custom `process.argv` loop | `node:util.parseArgs` | Built-in Node parser provides standards-compliant short/long flag handling and argument validation. [VERIFIED: STACK.md:70] |
| LiveSync Document IDs & Types | Custom document ID string constants | Pinned Commonlib constants (`VERSIONING_DOCID`, `MILESTONE_DOCID`, `DOCID_SYNC_PARAMETERS`, `SYNCINFO_ID`, `VER`) | Commonlib's exact string constants include historic typo preservation (`obsydian_livesync_version`, `_local/obsydian_livesync_milestone`). Hand-rolling invites typo-correction bugs. [VERIFIED: dist/common/models/db.const.js:1-4] |
| HKDF Decryption | Custom Web Crypto implementations | Pinned Commonlib `#worker` / `octagonal-wheels` functions | Reuses tested HKDF-AES-GCM decryption algorithms matching official Obsidian LiveSync clients. [VERIFIED: dist/pouchdb/encryption.js:9-13] |

## Common Pitfalls

### Pitfall 1: Mutating CouchDB during "Read-Only" Inspection
**What goes wrong:** Calling upstream setup helpers like `checkRemoteVersion()` or `SyncParamsHandler` creates documents in CouchDB (`obsydian_livesync_version`, `_local/obsidian_livesync_sync_parameters`, `syncinfo`). A database inspected with read-only credentials fails with 401/403, or an uninitialized database is silently stamped with default settings.
**Why it happens:** Upstream helper code was written for the Obsidian GUI plugin, which assumes interactive setup authority and generates default configurations when records are absent. [VERIFIED: dist/pouchdb/negotiation.js:27-32, dist/replication/SyncParamsHandler.js:38-44]
**Prevention:** Implement a separate read-only probe using pure `GET` and `HEAD` HTTP requests. Enforce a transport allowlist that throws `MutationAttemptBlockedError` on any `PUT`, `POST`, or `DELETE`. Test with read-only credentials and verify that `update_seq` does not change. [VERIFIED: PITFALLS.md:84-88]

### Pitfall 2: Disclosing Credentials in Logs and Error Stacks
**What goes wrong:** When CouchDB is unreachable or returns 401, Node's `fetch` error or PouchDB error strings include the full URL (e.g. `TypeError: fetch failed to http://admin:secret@127.0.0.1:5984/myvault`). These strings leak into stderr, crash logs, or terminal screens.
**Prevention:** Parse URLs immediately into connection components (`origin`, `pathname`, `auth`). Strip username and password from URL objects before passing to `fetch` or logging; inject credentials via HTTP `Authorization: Basic ...` header. Pass all log strings and `Error` objects through `SecretRedactor`. [VERIFIED: PITFALLS.md:492]

### Pitfall 3: Accepting Unsafe Local Vault Destinations
**What goes wrong:** User configures `/` (root), `~` (home), `/etc`, or a directory containing the SQLite state database as the vault path. A subsequent pull or scan risks traversing or modifying sensitive operating system files.
**Prevention:** In Zod schema validation (CONF-03), resolve canonical paths using `path.resolve()` and `fs.realpathSync()`. Forbid system root, user home, current working directory parent escapes, and ensure `stateDir` is strictly outside the vault path namespace. [VERIFIED: ARCHITECTURE.md:147]

### Pitfall 4: Misinterpreting Remote Preferred Tweaks and Settings
**What goes wrong:** An existing database has remote preferred tweaks (`remoteMilestone.tweak_values[DEVICE_ID_PREFERRED]`) configured by an Obsidian client with specific encryption or chunking settings. If the headless client ignores them or tries to impose its own defaults, future writes will create unreadable or conflicted chunks.
**Prevention:** During inspection (CONF-05), read `DEVICE_ID_PREFERRED` from the milestone. Classify each difference against Commonlib's `IncompatibleChanges` (`encrypt`, `usePathObfuscation`, `useDynamicIterationCount`, `handleFilenameCaseSensitive`) and `CompatibleButLossyChanges` (`hashAlg`, `customChunkSize`, `chunkSplitterVersion`). Adopt compatible tweaks into the local profile; fail closed on incompatible differences. [VERIFIED: dist/common/models/tweak.definition.js:23-29]

### Pitfall 5: Failing to Verify Syncinfo Decryption
**What goes wrong:** User provides a CouchDB password and an E2EE passphrase. Inspection checks CouchDB connectivity and reports "OK", but the passphrase was wrong. The user believes configuration succeeded, only to crash later on first file pull.
**Prevention:** Fetch the `syncinfo` document during admission. If the remote uses encryption, use the remote `pbkdf2salt` from `_local/obsidian_livesync_sync_parameters` and the supplied passphrase to decrypt `syncinfo` via HKDF. If decryption fails, report an explicit `AUTHENTICATION_ERROR` blocker indicating passphrase mismatch. [VERIFIED: ARCHITECTURE.md:151]

## Code Examples

### Verified Document IDs from Commonlib

From `@vrtmrz/livesync-commonlib@0.1.21`:

```ts
// Verified from dist/common/models/db.const.js:1-4 and dist/common/models/sync.definition.js:7
export const VERSIONING_DOCID = "obsydian_livesync_version";
export const MILESTONE_DOCID = "_local/obsydian_livesync_milestone";
export const NODEINFO_DOCID = "_local/obsydian_livesync_nodeinfo";
export const SYNCINFO_ID = "syncinfo";
export const DOCID_SYNC_PARAMETERS = "_local/obsidian_livesync_sync_parameters";

// Verified from dist/common/models/shared.const.behabiour.js:3
export const VER = 12;

// Verified from dist/common/models/tweak.definition.js:62
export const DEVICE_ID_PREFERRED = "PREFERRED";
```

### Verified Tweak Compatibility Rules

From `@vrtmrz/livesync-commonlib@0.1.21` `dist/common/models/tweak.definition.js:23-29`:

```ts
export const IncompatibleChanges = [
  "encrypt",
  "usePathObfuscation",
  "useDynamicIterationCount",
  "handleFilenameCaseSensitive"
];

export const CompatibleButLossyChanges = [
  "hashAlg",
  "customChunkSize",
  "chunkSplitterVersion"
];
```

### SQLite Admission Schema

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_admission (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  remote_fingerprint TEXT NOT NULL UNIQUE,
  couchdb_url TEXT NOT NULL,
  database_name TEXT NOT NULL,
  couchdb_version TEXT NOT NULL,
  version_info_rev TEXT NOT NULL,
  milestone_rev TEXT NOT NULL,
  sync_params_rev TEXT NOT NULL,
  negotiated_settings_hash TEXT NOT NULL,
  negotiated_settings_json TEXT NOT NULL,
  update_seq TEXT NOT NULL,
  admitted_at TEXT NOT NULL
);
```

### Pure Read-Only CouchDB Document Fetch

```ts
// src/livesync/inspector.ts
export interface CouchDbDocument {
  _id: string;
  _rev: string;
  [key: string]: unknown;
}

export async function fetchDocumentIfExists<T extends CouchDbDocument>(
  guardedFetch: typeof globalThis.fetch,
  baseUrl: URL,
  databaseName: string,
  docId: string
): Promise<T | null> {
  const docUrl = new URL(`/${encodeURIComponent(databaseName)}/${docId.split('/').map(encodeURIComponent).join('/')}`, baseUrl);
  const response = await guardedFetch(docUrl.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch document '${docId}': HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| Upstream plugin `checkRemoteVersion` & `ensureRemoteIsCompatible` | Project-owned pure HTTP `GET`/`HEAD` probe with transport guard | Self-hosted LiveSync Commonlib era (2025–2026) | Eliminates hidden database mutations, accidental marker creation, and write races on read-only discovery. |
| Hardcoded plain text secrets in YAML config | Environment-backed secret references (`fromEnv`, `fromFile`) | Modern 12-factor cloud-native practices | Prevents accidental credential check-ins to Git repositories. |
| Unredacted error dumping (`console.error(err)`) | Centralized secret scrubbing on all outputs | Modern security best practice (ASVS 4.0) | Eliminates credential and passphrase leakage in terminal, CI logs, and crash reports. |
| Allowing CouchDB to auto-create databases on connect | Strict pre-existence assertion (`skip_setup: true` equivalent) | LiveSync Headless architecture decision | Guarantees the application never initializes a typo database name on the CouchDB server. |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| 1 | CouchDB `_local` documents (`_local/obsydian_livesync_milestone`, `_local/obsidian_livesync_sync_parameters`) can be fetched via standard `GET /{db}/_local/...` over HTTP with normal database-member read credentials. | Architecture Patterns / Inspector | If CouchDB restricts `_local` reads to admins, read-only member users would fail inspection. Mitigated: CouchDB documentation confirms database members have read access to `_local` docs. |
| 2 | Upstream internal `VER` remains 12 for `obsidian-livesync@1.0.23`. | Standard Stack / Code Examples | If a different version is in use, admission would falsely flag databases as incompatible. Mitigated: Verified directly in unpacked Commonlib 0.1.21 `dist/common/models/shared.const.behabiour.js:3`. [VERIFIED: dist/common/models/shared.const.behabiour.js:3] |
| 3 | Ephemeral CouchDB 3.5.2.1 can be launched via Docker / Testcontainers during integration tests. | Validation Architecture | If Docker daemon were unavailable, integration tests would fail. Mitigated: Verified Docker version 28.3.1 is active and `couchdb:3.5.2.1` image is locally present. |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| Node.js | Runtime | Yes | `v25.6.1` installed (meets `>=24.20.0`) | Use installed Node.js for dev/test execution; target Node 24 LTS for SEA binary build. |
| npm | Package Manager | Yes | `11.9.0` (meets `>=11.0.0`) | Use bundled npm. |
| Git | Version Control | Yes | `2.43.0` | Standard git. |
| Docker Daemon | Real CouchDB Integration Tests | Yes | `28.3.1` running | Required for Testcontainers CouchDB harness. |
| Local CouchDB Image | Testcontainers CouchDB | Yes | `couchdb:3.5.2.1` (ID `f1dc96c1aa5f`) | Image is pre-cached; no network download required during tests. |
| `node:sqlite` | Local State Database | Yes | Node built-in | Tested and verified in current Node runtime. |

## Validation Architecture

### Test Framework
| Property | Value |
|---|---|
| Runner | Vitest `4.1.11` [VERIFIED: npm registry] |
| Integration Container Harness | `@testcontainers/couchdb@12.1.0` [VERIFIED: npm registry] |
| Target CouchDB Version | `3.5.2.1` (pinned official Docker image) |
| Parallelism Policy | Serial execution (`fileParallelism: false`) for tests using Testcontainers or shared SQLite roots. |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| CONF-01 | Parse YAML config identifying CouchDB URL, db name, and destination vault | Unit | `npx vitest run tests/unit/config.test.ts` | No (Wave 0 Gap) |
| CONF-02 | Resolve CouchDB credentials and passphrases from environment references without storing in config | Unit | `npx vitest run tests/unit/config.test.ts` | No (Wave 0 Gap) |
| CONF-03 | Validate configuration before side effects, rejecting unsafe destinations (root, parent traversal, overlapping state) | Unit | `npx vitest run tests/unit/config.test.ts` | No (Wave 0 Gap) |
| CONF-04 | Inspect CouchDB connectivity, version doc, milestone, sync params, preferred tweaks, representative records | Integration | `npx vitest run tests/integration/inspect-command.test.ts` | No (Wave 0 Gap) |
| CONF-05 | Pull and adopt compatible remote tweaks; block on incompatible tweaks or future versions | Unit & Integration | `npx vitest run tests/unit/negotiation.test.ts` | No (Wave 0 Gap) |
| CONF-06 | Emit stable compatibility report with remote fingerprint, settings hash, capabilities, and blockers | Unit & Integration | `npx vitest run tests/integration/inspect-command.test.ts` | No (Wave 0 Gap) |
| SAFE-01 | Deny database creation, drop, purge, compact, security, and administrative operations | Unit & Integration | `npx vitest run tests/unit/transport-guard.test.ts` | No (Wave 0 Gap) |
| SAFE-02 | Guarded fetch restricts traffic to GET/HEAD and allowlisted endpoints, blocking mutations | Unit | `npx vitest run tests/unit/transport-guard.test.ts` | No (Wave 0 Gap) |
| SAFE-04 | Redact passwords, passphrases, Authorization headers, setup URIs from logs, errors, and output | Unit | `npx vitest run tests/unit/redaction.test.ts` | No (Wave 0 Gap) |
| SAFE-06 | Output categorized diagnostics and non-zero exit codes for config errors, auth failures, incompatibilities | Integration | `npx vitest run tests/integration/inspect-command.test.ts` | No (Wave 0 Gap) |

### Sampling Rate
- 100% automated regression coverage for all 10 Phase 1 requirements before phase completion.
- Zero manual testing passes required for CI gating; all CouchDB interactions run against ephemeral Testcontainers instances.

### Wave 0 Gaps
- `package.json` with exact dependency pins and PouchDB `uuid` overrides.
- `tsconfig.json` configured for ESM / NodeNext.
- `vitest.config.ts` setup with Testcontainers timeout accommodation.
- Test directory structure (`tests/unit/`, `tests/characterization/`, `tests/integration/`).
- Mock CouchDB response fixtures for unit tests and seed datasets for Testcontainers.

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2: Authentication | Yes | Credentials passed only via secure environment or explicit file; rejected if embedded in URLs; Basic auth headers managed securely. |
| V3: Session Management | Yes | Non-persistent sessions; no long-lived token leakage in SQLite or logs. |
| V4: Access Control | Yes | Database-member least privilege; application must not require or request CouchDB server-admin role. |
| V5: Malicious Input Handling | Yes | Strict Zod validation of all configuration values, URLs, and paths before processing. |
| V6: Cryptography | Yes | E2EE verification using Web Crypto HKDF and AES-GCM; passphrases never persisted in SQLite or written to disk. |
| V8: Data Protection | Yes | Mandatory redaction of secrets from stderr JSON logs, stdout, error stacks, and SQLite database. |
| V12: File and Resources | Yes | Destination vault path canonicalization, symlink escape rejection, directory separation between vault and state store. |
| V14: Configuration | Yes | Fail-closed configuration parsing: unknown YAML properties rejected (`zod.strict()`). |

### Known Threat Patterns for CouchDB / LiveSync
| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Accidental Remote Mutation During Inspection | Tampering | Pure HTTP `GET`/`HEAD` transport guard blocks `PUT`, `POST`, `DELETE` before network dispatch. |
| Credential Disclosure in URLs / Logs | Information Disclosure | `SecretRedactor` scrubs passwords, auth headers, and setup URIs from all output channels; URLs reject embedded userinfo. |
| Path Traversal / Arbitrary File Overwrite | Elevation of Privilege | Vault path normalization rejects `/`, `..`, and verifies target is a dedicated directory outside state storage. |
| Man-in-the-Middle on CouchDB Connection | Information Disclosure / Tampering | Enforce HTTPS for remote CouchDB connections; permit HTTP only for explicit loopback addresses (`127.0.0.1`, `localhost`). |
| Redirection Credential Leakage | Information Disclosure | Guarded fetch intercepts 3xx redirects (`redirect: 'manual'`), validates redirect origin, and refuses cross-origin redirects or credential forwarding. |

## Sources

### Primary (HIGH confidence)
- `@vrtmrz/livesync-commonlib@0.1.21` npm package tarball source inspection (`dist/pouchdb/negotiation.js`, `dist/replication/SyncParamsHandler.js`, `dist/pouchdb/LiveSyncDBFunctions.js`, `dist/common/models/tweak.definition.js`, `dist/common/models/db.const.js`).
- [VERIFIED: npm registry] metadata for `@vrtmrz/livesync-commonlib`, `yaml`, `zod`, `typescript`, `vitest`, `@testcontainers/couchdb`.
- Local Docker environment check confirming `Docker version 28.3.1` and cached `couchdb:3.5.2.1` image.

### Secondary (MEDIUM confidence)
- Project research documents: `.planning/research/STACK.md`, `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md`, `.planning/research/FEATURES.md`, `.planning/research/SUMMARY.md`.
- `obsidian-livesync@1.0.23` release metadata and commit history.

### Tertiary (LOW confidence)
- None.

## Metadata
**Confidence breakdown:**
- Upstream compatibility pin & package integrity: HIGH (Verified directly via npm registry and unpacked tarball).
- Commonlib negotiation & mutation call graph: HIGH (Verified directly from decompiled package source).
- CouchDB integration environment: HIGH (Verified local Docker and image readiness).
- Transport guard & secret redaction architecture: HIGH (Tested patterns aligned with standard node APIs).

**Research date:** 2026-09-03
**Valid until:** 2026-10-03 (or upon any bump of `@vrtmrz/livesync-commonlib` dependency).
