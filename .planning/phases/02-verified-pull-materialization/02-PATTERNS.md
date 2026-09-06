# Phase 2: Verified Pull Materialization - Pattern Map

**Mapped:** 2026-09-03
**Files analyzed:** 32
**Analogs found:** 31 / 32

CONTEXT.md is absent. File list is from `02-RESEARCH.md` recommended structure, Code Examples, Validation Wave 0 gaps, and implied Phase 1 contract updates (outcomes, schema, formatters, smoke/config tests).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/cli/commands/pull.ts` | controller | request-response | `src/cli/commands/inspect.ts` | exact |
| `src/cli/index.ts` | controller | request-response | `src/cli/index.ts` (extend in place) | exact |
| `src/livesync/inventory.ts` | service | batch | `src/livesync/inspector.ts` | exact |
| `src/livesync/inspector.ts` | service | request-response | `src/livesync/inspector.ts` (extend `fetchDocumentIfExists`) | exact |
| `src/livesync/decode-adapter.ts` | service | transform | `src/livesync/syncinfo.ts` | role-match |
| `src/livesync/negotiation.ts` | service | transform | `src/livesync/negotiation.ts` (lift incompatible-tweak blocks) | exact |
| `src/domain/pull-plan.ts` | service | transform | `src/livesync/negotiation.ts` | role-match |
| `src/domain/path-policy.ts` | utility | transform | `src/config/loader.ts` | partial |
| `src/filesystem/atomic-reflector.ts` | service | file-I/O | none (use RESEARCH atomic-install snippet) | none |
| `src/filesystem/vault-preflight.ts` | service | file-I/O | `src/config/loader.ts` | partial |
| `src/storage/provenance-repo.ts` | model | CRUD | `src/storage/admission-repo.ts` | exact |
| `src/storage/sqlite.ts` | migration | CRUD | `src/storage/sqlite.ts` (add migration 2) | exact |
| `src/security/capabilities.ts` | middleware | request-response | `src/security/capabilities.ts` | exact |
| `src/diagnostics/outcomes.ts` | config | transform | `src/diagnostics/outcomes.ts` | exact |
| `src/diagnostics/formatters.ts` | utility | transform | `src/diagnostics/formatters.ts` | exact |
| `src/config/schema.ts` | config | transform | `src/config/schema.ts` | exact |
| `tests/unit/pull-plan.test.ts` | test | transform | `tests/unit/negotiation.test.ts` | exact |
| `tests/unit/path-policy.test.ts` | test | transform | `tests/unit/config.test.ts` | role-match |
| `tests/unit/atomic-reflector.test.ts` | test | file-I/O | `tests/unit/admission-repo.test.ts` | partial |
| `tests/unit/provenance-repo.test.ts` | test | CRUD | `tests/unit/admission-repo.test.ts` | exact |
| `tests/unit/vault-preflight.test.ts` | test | file-I/O | `tests/unit/config.test.ts` | role-match |
| `tests/unit/negotiation.test.ts` | test | transform | `tests/unit/negotiation.test.ts` (add adoption cases) | exact |
| `tests/unit/config.test.ts` | test | transform | `tests/unit/config.test.ts` (add `vault.dedicated`) | exact |
| `tests/unit/smoke.test.ts` | test | request-response | `tests/unit/smoke.test.ts` (`CONFLICT` + `--dry-run`) | exact |
| `tests/unit/inspector.test.ts` | test | request-response | `tests/unit/inspector.test.ts` | exact |
| `tests/unit/transport-guard.test.ts` | test | request-response | `tests/unit/transport-guard.test.ts` (VaultReflect brand) | exact |
| `tests/characterization/commonlib-path.test.ts` | test | transform | `tests/characterization/commonlib-crypto.test.ts` | role-match |
| `tests/characterization/commonlib-decode.test.ts` | test | transform | `tests/characterization/commonlib-crypto.test.ts` | exact |
| `tests/characterization/commonlib-enumerate-ranges.test.ts` | test | transform | `tests/characterization/commonlib-crypto.test.ts` | role-match |
| `tests/integration/pull-dry-run.test.ts` | test | request-response | `tests/integration/inspect-command.test.ts` | exact |
| `tests/integration/pull-apply.test.ts` | test | file-I/O | `tests/integration/inspect-command.test.ts` | role-match |
| `tests/integration/couchdb-harness.ts` | test | CRUD | `tests/integration/couchdb-harness.ts` (seed helpers) | exact |

## Pattern Assignments

### `src/cli/commands/pull.ts` (controller, request-response)

**Analog:** `src/cli/commands/inspect.ts`

Copy the coordinator shape: injectable `redactor`/`stdout`, `loadConfig` first, guarded fetch, zero-mutation sandwich, typed `instanceof` error → `OutcomeCategory` + `EXIT_CODES`, report on stdout.

**Imports pattern** (lines 1-30):
```typescript
import { loadConfig, ConfigValidationError } from '../../config/loader.js';
import { SecretRedactor, defaultRedactor } from '../../security/redaction.js';
import {
  createGuardedFetch,
  MutationAttemptBlockedError,
} from '../../security/transport-guard.js';
import {
  probeRemoteDatabase,
  AuthenticationRequiredError,
  DatabaseNotFoundError,
} from '../../livesync/inspector.js';
import {
  ZeroMutationVerifier,
  MutationDetectedError,
} from '../../livesync/zero-mutation.js';
import { verifySyncinfo } from '../../livesync/syncinfo.js';
import { negotiateCompatibility, computeFingerprint } from '../../livesync/negotiation.js';
import { OutcomeCategory, EXIT_CODES } from '../../diagnostics/outcomes.js';
```

Pull adds: inventory, decode-adapter, pull-plan, path-policy, vault-preflight, atomic-reflector, provenance-repo, `createReadCapability` / `createVaultReflectCapability`. Do **not** construct `DirectFileManipulator`.

**Options + stdout injection** (lines 32-46):
```typescript
export interface InspectCommandOptions {
  configPath: string;
  json?: boolean;
  redactor?: SecretRedactor;
  stdout?: (msg: string) => void;
}

export async function runInspectCommand(options: InspectCommandOptions): Promise<number> {
  const redactor = options.redactor ?? defaultRedactor;
  const writeStdout = options.stdout ?? ((msg: string) => process.stdout.write(msg));
```

Mirror as `PullCommandOptions` with `dryRun: boolean`. Keep `stdout` injectable so integration tests capture reports without spawning a process.

**Config + transport bootstrap** (lines 48-88):
```typescript
  try {
    config = await loadConfig(options.configPath, process.env, redactor);
  } catch (err) {
    emitReport({ outcome: OutcomeCategory.CONFIG_ERROR, /* ... */ });
    return EXIT_CODES.CONFIG_ERROR;
  }

  const rawUrl = new URL(config.remote.url);
  const allowedBaseUrl = new URL(`${rawUrl.protocol}//${rawUrl.host}`);
  const databaseName = config.remote.database;
  const guardedFetch = createGuardedFetch({ allowedBaseUrl, databaseName });
```

**Zero-mutation sandwich + typed errors** (lines 97-257):
```typescript
    preSnapshot = await ZeroMutationVerifier.captureSnapshot(/* ... */);
    probeResult = await probeRemoteDatabase(/* ... */);
    postSnapshot = await ZeroMutationVerifier.captureSnapshot(/* ... */);
    ZeroMutationVerifier.assertNoMutation(preSnapshot, postSnapshot);
  } catch (err) {
    if (err instanceof AuthenticationRequiredError) { /* EXIT_CODES.AUTHENTICATION_ERROR */ }
    if (err instanceof DatabaseNotFoundError) { /* EXIT_CODES.NOT_FOUND */ }
    if (err instanceof MutationDetectedError || err instanceof MutationAttemptBlockedError) {
      /* EXIT_CODES.MUTATION_VIOLATION */
    }
    // ECONNREFUSED / ENOTFOUND / fetch failed → TRANSIENT_OUTAGE
    // else → CORRUPTION
  }
```

Pull must wrap **inventory + decode** inside the same pre/post snapshot. Dry-run and apply both assert `update_seq` unchanged.

**Admission reuse** (lines 259-298):
```typescript
  const syncinfoResult = await verifySyncinfo(
    probeResult.syncinfoDoc,
    probeResult.syncParamsDoc,
    config.resolvedSecrets.encryptionPassphrase
  );
  const negotiation = negotiateCompatibility(probeResult, config, syncinfoResult.verified);
  if (!negotiation.admitted) { /* INCOMPATIBLE or AUTHENTICATION_ERROR */ }
```

Pull re-runs this probe; do not skip admission. After Phase 2 negotiation change, admitted remote may include adopted path/case/E2EE tweaks.

**Capability gate (apply vs dry-run)** — copy brand tokens from `src/security/capabilities.ts` lines 20-27, then:

- `--dry-run`: issue `createReadCapability` only. Never open vault writes or provenance.
- apply: after vault-preflight succeeds, issue `VaultReflectCapability`. Do not pass `boolean canWrite`.

**SQLite persist after verified side-effect** (lines 300-317) — copy the try/close + `CORRUPTION` on persist failure, but call provenance **after** atomic install + read-back, not before:

```typescript
    const db = openDatabase(config.resolvedStatePath);
    const repo = new AdmissionRepository(db);
    repo.saveAdmission({ /* ... */ });
    db.close();
```

**Do not copy:** inspect's "persist admission then SUCCESS" as the pull apply path. Apply order is: plan valid → stage+sync+rename+read-back → `file_provenance` INSERT → post-snapshot.

---

### `src/cli/index.ts` (controller, request-response)

**Analog:** itself (`src/cli/index.ts`)

**parseArgs + command dispatch** (lines 33-111):
```typescript
export function parseCliArgs(args: string[] = process.argv.slice(2)): { command?: string; options: CliOptions } {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: 'string', short: 'c' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: true,
  });
  return { command: positionals[0], options: { /* ... */ } };
}

    const isInspect = !parsed.command || parsed.command === 'inspect';
    if (isInspect) {
      if (!parsed.options.config) {
        logger.error('Missing required configuration file (--config <path>)');
        return EXIT_CODES.CONFIG_ERROR;
      }
      return await runInspectCommand({ configPath: parsed.options.config, json: parsed.options.json });
    }
```

Add `dryRun: { type: 'boolean', default: false }` to `parseArgs` options and `CliOptions`. Add `isPull = parsed.command === 'pull'` branch that requires `--config` and calls `runPullCommand({ ..., dryRun: parsed.options.dryRun })`. Keep inspect as the default when command is omitted (line 90). Update `CLI_HELP` (lines 19-29) with `pull` and `--dry-run`.

**Unhandled error redaction** (lines 106-110):
```typescript
    const sanitizedError = defaultRedactor.redactError(error as Error);
    logger.error('Unhandled CLI execution error', { error: sanitizedError.message });
    return EXIT_CODES.CONFIG_ERROR;
```

---

### `src/livesync/inventory.ts` (service, batch)

**Analog:** `src/livesync/inspector.ts`

Own paginated `_all_docs` + per-doc `?conflicts=true`. Reuse `fetchDocumentIfExists` URL/auth/status mapping. Do not call Commonlib `enumerate()`.

**Typed HTTP errors** (lines 48-66):
```typescript
export class DatabaseNotFoundError extends Error {
  constructor(databaseName: string) {
    super(`CouchDB database '${databaseName}' was not found (HTTP 404).`);
    this.name = 'DatabaseNotFoundError';
  }
}

export class AuthenticationRequiredError extends Error {
  constructor(statusCode: number, message = 'Authentication required or invalid credentials.') {
    super(`CouchDB authentication failed (HTTP ${statusCode}): ${message}`);
    this.name = 'AuthenticationRequiredError';
  }
}
```

**GET document helper** (lines 68-108) — extend this function (in `inspector.ts`) with optional query (`conflicts`, `rev`, `open_revs`) rather than inventing a second client:

```typescript
export async function fetchDocumentIfExists<T extends CouchDbDocument>(
  guardedFetch: typeof globalThis.fetch,
  baseUrl: URL,
  databaseName: string,
  docId: string,
  authHeader?: string
): Promise<T | null> {
  const pathSegments = docId.split('/').map(encodeURIComponent).join('/');
  const docUrl = new URL(`/${encodeURIComponent(databaseName)}/${pathSegments}`, baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authHeader) headers.Authorization = authHeader;
  const response = await guardedFetch(docUrl.toString(), { method: 'GET', headers });
  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationRequiredError(response.status, `Access denied fetching document '${docId}'.`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch document '${docId}': HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}
```

**`_all_docs` listing already exists as a sample** (lines 202-224) — promote this into a paginated loop (`limit` + `startkey`/`skip` or `startkey` exclusive):

```typescript
  const allDocsUrl = new URL(
    `/${encodeURIComponent(databaseName)}/_all_docs?limit=10`,
    baseUrl
  );
  const allDocsRes = await guardedFetch(allDocsUrl.toString(), { method: 'GET', headers: baseHeaders });
  const sampleDocs: { id: string; rev: string }[] = [];
  if (allDocsRes.ok) {
    const allDocsJson = (await allDocsRes.json()) as {
      rows?: { id: string; value: { rev: string } }[];
    };
    if (Array.isArray(allDocsJson.rows)) {
      for (const row of allDocsJson.rows) {
        if (row.id && row.value?.rev) {
          sampleDocs.push({ id: row.id, rev: row.value.rev });
        }
      }
    }
  }
```

**Auth header construction** (lines 116-127):
```typescript
  if (credentials?.username || credentials?.password) {
    const raw = `${credentials.username ?? ''}:${credentials.password ?? ''}`;
    authHeader = `Basic ${Buffer.from(raw).toString('base64')}`;
  }
```

Inventory classification: skip reserved ID ranges (`h:`, `h:+`, `f:` is a note ID — do **not** skip `f:`). Use Commonlib `EntryTypes` / `IDPrefixes` inside the decode adapter, not string literals scattered in inventory.

**Do not copy:** `include_docs=true` as the conflict source. After listing IDs, second-hop `GET ?conflicts=true`. If `_conflicts` is non-empty, fetch every leaf (`?rev=` or `open_revs=all`) and let the planner `block` — do not materialize the winner.

---

### `src/livesync/inspector.ts` (service, request-response)

**Analog:** itself.

Minimal Phase 2 change: add optional query-string support to `fetchDocumentIfExists` so inventory can request `conflicts=true` / `rev=` without duplicating encode/auth/404 mapping. Keep `probeRemoteDatabase` unchanged for inspect.

---

### `src/livesync/decode-adapter.ts` (service, transform)

**Analog:** `src/livesync/syncinfo.ts`

This is the **only** file allowed to import Commonlib / `octagonal-wheels` codec surfaces (plus a `0.1.21` source comment). Isolate `path2id_base` / `id2path_base`, `getConfiguredFunctionsForEncryption`, `EntryTypes`, `NoteTypes`, `PREFIX_*`, `validateStoragePath` (or wrap it from path-policy). Never construct DFM.

**Imports pattern** (lines 1-7):
```typescript
import {
  decrypt as decryptHkdf,
  HKDF_ENCRYPTED_PREFIX,
} from 'octagonal-wheels/encryption/hkdf';
import { decrypt as decryptV2 } from 'octagonal-wheels/encryption';
import { hexStringToUint8Array } from 'octagonal-wheels/binary/hex';
import type { CouchDbDocument } from './inspector.js';
```

Pull decode should prefer Commonlib `getConfiguredFunctionsForEncryption` with admission salt (RESEARCH COMP-02). Keep `octagonal-wheels` only if characterization proves the same transforms; do not add a second crypto path in application code.

**Fail-closed decrypt** (lines 33-71):
```typescript
  if (!passphrase) {
    return { verified: false, error: 'Remote database is encrypted but no passphrase was provided' };
  }
  try {
    // decrypt with salt from already-fetched sync params only
    return { verified: true, decryptedData: decrypted };
  } catch (err) {
    return {
      verified: false,
      error: `Passphrase authentication failed: ${(err as Error).message || 'Decryption failed'}`,
    };
  }
```

Decode adapter must return a typed failure (blocker), not throw into a zero-byte file. Inject `probeResult.syncParamsDoc.pbkdf2salt` — never call `SyncParamsHandler`.

**Salt parsing already exists** (lines 52-57):
```typescript
      if (/^[0-9a-fA-F]+$/.test(rawSalt) && rawSalt.length % 2 === 0) {
        saltBytes = hexStringToUint8Array(rawSalt);
      } else {
        saltBytes = new TextEncoder().encode(rawSalt);
      }
```

After decrypt: use document `path`, then verify `path2id_base(path) === _id`. Do not derive vault names from obfuscated `_id` (`f:…`).

---

### `src/livesync/negotiation.ts` (service, transform)

**Analog:** itself (`src/livesync/negotiation.ts`)

**Tweak loop to change** (lines 108-132):
```typescript
    if (IncompatibleChanges.includes(key as any)) {
      if (key === 'encrypt') {
        const localEncrypt = Boolean(localConfig.encryption?.enabled);
        const remoteEncrypt = Boolean(remoteVal);
        if (localEncrypt !== remoteEncrypt) {
          blockers.push({
            code: 'INCOMPATIBLE_TWEAK',
            message: `Incompatible difference for 'encrypt': remote=${remoteEncrypt}, local=${localEncrypt}`,
            suggestion: 'Match encryption configuration in your YAML config with remote database settings',
          });
        }
      } else {
        if (remoteVal) {
          blockers.push({
            code: 'INCOMPATIBLE_TWEAK',
            message: `Incompatible difference for '${key}': remote=${remoteVal}`,
            suggestion: `The '${key}' LiveSync tweak is not currently supported in this headless release`,
          });
        }
      }
    } else if (CompatibleButLossyChanges.includes(key as any)) {
      adoptedTweaks[key] = remoteVal;
      negotiatedSettings[key] = remoteVal;
    }
```

Replace the `else` branch (lines 119-127) with the same adopt path used for `CompatibleButLossyChanges`: write `usePathObfuscation`, `useDynamicIterationCount`, `handleFilenameCaseSensitive` into `adoptedTweaks` + `negotiatedSettings`. Keep blocking **only** when local `encryption.enabled` disagrees with remote `encrypt`. Keep unknown-key fail-closed (lines 99-105) and version/milestone gates.

**Pure function + blocker objects** (lines 54-64, 149-173) — pull-plan should copy this result shape (`admitted`, `blockers[]` with `code`/`message`/`suggestion`).

Also adopt `hashAlg` / `customChunkSize` / `chunkSplitterVersion` into decode settings (already done for lossy keys).

---

### `src/domain/pull-plan.ts` (service, transform)

**Analog:** `src/livesync/negotiation.ts`

Pure function: observations → discriminated actions. No I/O, no SQLite, no fetch.

Copy: `Blocker` + result interface (lines 23-38) and "collect blockers, decide at the end" (lines 149-173).

RESEARCH action union (use as the domain type):

```typescript
export type PullAction =
  | { kind: 'create'; path: string; sourceRevision: string; bytes: Uint8Array }
  | { kind: 'skip-logical-delete'; path: string; sourceRevision: string }
  | { kind: 'skip-special'; id: string; type: string }
  | { kind: 'skip-ignored'; path: string }
  | { kind: 'block'; path?: string; id: string; code: string; message: string };
```

Rules to encode here (not in the CLI):
- Classify only `plain` / `newnote` / `notes` (via decode-adapter constants).
- Skip `deleted === true` without decrypting tombstones as files.
- Any live non-deleted extra leaf → `block` (do not pick CouchDB winner).
- Missing chunk / size mismatch / decrypt fail / path-policy fail → `block`.
- Dry-run serialization omits `bytes` (size/hash only).

Apply fail-closed: if any `block` exists, CLI applies nothing and exits `CONFLICT` or `CORRUPTION`.

---

### `src/domain/path-policy.ts` (utility, transform)

**Analog:** `src/config/loader.ts` lines 108-146 (vault-root safety)

```typescript
  const vaultPath = path.resolve(config.vault.path);
  const rootDir = path.parse(vaultPath).root;
  if (vaultPath === '/' || vaultPath === rootDir) {
    throw new ConfigValidationError('Vault path cannot be the root filesystem directory');
  }
  if (homeDirs.has(vaultPath)) {
    throw new ConfigValidationError('Vault path cannot be the user home directory');
  }
  if (statePath.startsWith(vaultPath + path.sep) || vaultPath.startsWith(statePath + path.sep)) {
    throw new ConfigValidationError('Vault directory and state directory must not overlap');
  }
```

Path-policy is the **vault-relative** counterpart: wrap Commonlib `validateStoragePath` (absolute, drive letter, `\`, `.` / `..`), reject reserved flag files (`redflag.md`, `flag_rebuild.md`, `livesync_log_` via Commonlib `shouldBeIgnored` inside decode-adapter), and case-fold collision preflight when `handleFilenameCaseSensitive` is false. Do not reimplement `includes('..')`.

---

### `src/filesystem/atomic-reflector.ts` (service, file-I/O)

**Analog:** none in `src/`. Use RESEARCH.md "Atomic install" (lines 556-587).

Project-owned: sibling temp + `FileHandle.sync()` + `rename` + best-effort parent-dir sync + read-back. Do **not** call Commonlib `write()` (`O_TRUNC`). `createNodeStorage().rename()` is allowed as the rename primitive; Node `fsPromises.rename` is equivalent on POSIX.

Crash-before-rename must leave destination untouched. Read-back bytes must equal assembled buffer before provenance.

---

### `src/filesystem/vault-preflight.ts` (service, file-I/O)

**Analog:** `src/config/loader.ts` path-safety block (lines 108-146) + inspect integration temp dirs (`tests/integration/inspect-command.test.ts` lines 30-35).

Check: vault exists; when `vault.dedicated === false` (schema default), vault contains zero files; when `true`, existing files without provenance block those paths (no overwrite). Scan for case-fold collisions and symlinks (`lstat` / `O_NOFOLLOW`) before issuing `VaultReflectCapability`.

---

### `src/storage/provenance-repo.ts` (model, CRUD)

**Analog:** `src/storage/admission-repo.ts`

**Class + constructor injection** (lines 17-18):
```typescript
export class AdmissionRepository {
  constructor(private readonly db: DatabaseSync) {}
```

**INSERT / upsert** (lines 20-61) — copy `prepare` + bound params + `ON CONFLICT` style. Map columns from RESEARCH:

```sql
CREATE TABLE IF NOT EXISTS file_provenance (
  path TEXT PRIMARY KEY,
  remote_revision TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  observed_mtime INTEGER,
  remote_fingerprint TEXT NOT NULL,
  reflected_at TEXT NOT NULL
);
```

**Row remap** (lines 63-99):
```typescript
    const row = stmt.get(fingerprint) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      remoteFingerprint: String(row.remote_fingerprint),
      // ...
    };
```

No passphrase, Authorization, or plaintext body columns. `saveProvenance` is called only from the apply coordinator after read-back — never from `pull-plan.ts`.

---

### `src/storage/sqlite.ts` (migration, CRUD)

**Analog:** itself (lines 5-43)

```typescript
export const CURRENT_SCHEMA_VERSION = 1;

  if (!appliedVersions.has(1)) {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_admission ( /* ... */ );`);
    const stmt = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    );
    stmt.run(1, new Date().toISOString());
  }
```

Add migration `2` the same way; bump `CURRENT_SCHEMA_VERSION` to `2`. Keep WAL (skipped for `:memory:`) and `PRAGMA foreign_keys = ON` (lines 55-64).

**openDatabase parent-dir create** (lines 46-53) — reuse as-is.

---

### `src/security/capabilities.ts` (middleware, request-response)

**Analog:** itself (lines 1-51)

```typescript
const ReadCapabilityBrand = Symbol('ReadCapability');
const AdmissionCapabilityBrand = Symbol('AdmissionCapability');

export function createReadCapability(baseUrl: URL, databaseName: string): ReadCapability {
  return {
    [ReadCapabilityBrand]: true,
    baseUrl: new URL(baseUrl.href),
    databaseName,
    issuedAt: new Date(),
  };
}

export function isReadCapability(cap: unknown): cap is ReadCapability {
  return Boolean(cap && typeof cap === 'object' && ReadCapabilityBrand in cap);
}
```

Add `VaultReflectCapabilityBrand` + `createVaultReflectCapability` + `isVaultReflectCapability` with the same copy-URL / brand-in-object pattern. Issue only after admission + empty/dedicated preflight.

---

### `src/diagnostics/outcomes.ts` (config, transform)

**Analog:** itself (lines 1-23)

```typescript
export const OutcomeCategory = {
  SUCCESS: 'SUCCESS',
  CONFIG_ERROR: 'CONFIG_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  INCOMPATIBLE: 'INCOMPATIBLE',
  NOT_FOUND: 'NOT_FOUND',
  TRANSIENT_OUTAGE: 'TRANSIENT_OUTAGE',
  MUTATION_VIOLATION: 'MUTATION_VIOLATION',
  CORRUPTION: 'CORRUPTION',
} as const;

export const EXIT_CODES: Record<OutcomeCategory, number> = {
  SUCCESS: 0,
  CONFIG_ERROR: 1,
  AUTHENTICATION_ERROR: 2,
  INCOMPATIBLE: 3,
  NOT_FOUND: 4,
  TRANSIENT_OUTAGE: 5,
  MUTATION_VIOLATION: 6,
  CORRUPTION: 7,
};
```

Add `CONFLICT: 'CONFLICT'` and `CONFLICT: 8`. Do not reuse `CORRUPTION` for unresolved leaves. Update `tests/unit/smoke.test.ts` lines 7-28 (`categories.length` becomes 9).

---

### `src/diagnostics/formatters.ts` (utility, transform)

**Analog:** itself (lines 25-117)

Copy human divider + JSON Lines (`JSON.stringify(...) + '\n'`). Add a `pull_report` type. Dry-run must **not** include decrypted `bytes` or passphrases. Reuse blocker rendering (lines 85-94):

```typescript
    for (const blocker of report.blockers) {
      lines.push(`    ✖ [${blocker.code}] ${blocker.message}`);
      if (blocker.suggestion) {
        lines.push(`      Suggestion: ${blocker.suggestion}`);
      }
    }
```

JSON Lines analog (lines 100-117):
```typescript
export function formatJsonLinesReport(report: CompatibilityReport): string {
  return (
    JSON.stringify({
      type: 'compatibility_report',
      outcome: report.outcome,
      // ...
    }) + '\n'
  );
}
```

Pull report `type` should be `'pull_report'` so inspect tests stay isolated.

---

### `src/config/schema.ts` (config, transform)

**Analog:** itself (lines 36-62)

```typescript
export const VaultConfigSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

export const LiveSyncConfigSchema = z
  .object({
    remote: CouchDbConfigSchema,
    vault: VaultConfigSchema,
    state: StateConfigSchema.default({}),
    encryption: EncryptionConfigSchema.optional(),
  })
  .strict();
```

Add `dedicated: z.boolean().default(false)` inside `VaultConfigSchema`. Keep `.strict()` so unknown keys still fail. Default `false` = empty vault required.

---

### `tests/unit/pull-plan.test.ts` (test, transform)

**Analog:** `tests/unit/negotiation.test.ts`

**Fixture object + clone-and-mutate** (lines 1-66):
```typescript
import { describe, it, expect } from 'vitest';
import { negotiateCompatibility } from '../../src/livesync/negotiation.js';

describe('LiveSync Compatibility Negotiation', () => {
  const localConfig: LiveSyncConfig = { /* ... */ };
  const baseProbeResult: RemoteProbeResult = { /* ... */ };

  it('accepts compatible database and adopts compatible tweaks', () => {
    const result = negotiateCompatibility(baseProbeResult, localConfig);
    expect(result.admitted).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });
```

Build a `baseObservation` fixture; clone for conflict leaves, missing chunks, logical deletes, unknown types. Assert action `kind` and blocker codes. No I/O.

---

### `tests/unit/path-policy.test.ts` / `tests/unit/vault-preflight.test.ts` (test)

**Analog:** `tests/unit/config.test.ts`

**Temp dir lifecycle** (lines 8-17):
```typescript
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'livesync-config-test-'));
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
```

Copy traversal / absolute / overlap rejection cases (lines 241-317) as vault-relative equivalents: `../escape`, `/etc/passwd`, `C:\`, symlink, reserved `redflag.md`, `A.md` vs `a.md` when case-insensitive.

---

### `tests/unit/provenance-repo.test.ts` / `tests/unit/atomic-reflector.test.ts` (test)

**Analog:** `tests/unit/admission-repo.test.ts`

**Temp SQLite + secret exclusion** (lines 8-37, 136-180):
```typescript
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livesync-test-sqlite-'));
    dbPath = path.join(tempDir, 'state.sqlite');
  });

  it('initializes SQLite database, runs migrations, and creates WAL mode', () => {
    const db = openDatabase(dbPath);
    const names = tables.map((t) => t.name);
    expect(names).toContain('schema_migrations');
    expect(names).toContain('remote_admission');
  });
```

Provenance tests must assert `file_provenance` exists after migration 2, round-trip `remote_revision`, and `PRAGMA table_info` excludes `password` / `passphrase` / `secret` / `authorization` / body columns (copy lines 159-177).

Atomic-reflector tests use the same temp-dir fixture. Assert crash-before-rename leaves dest missing; read-back mismatch does not write provenance (call order test with a fake repo).

---

### `tests/unit/negotiation.test.ts` (test, transform)

**Analog:** itself.

Add cases: remote `usePathObfuscation: true`, `useDynamicIterationCount: true`, `handleFilenameCaseSensitive: true` → `admitted === true` and values appear in `adoptedTweaks`. Keep encrypt mismatch (lines 138-154) as the only remaining `INCOMPATIBLE_TWEAK` for those keys.

---

### `tests/characterization/commonlib-*.test.ts` (test, transform)

**Analog:** `tests/characterization/commonlib-crypto.test.ts`

**Direct Commonlib/octagonal import + fail-closed** (lines 1-66):
```typescript
import { describe, it, expect } from 'vitest';
import { encrypt as encryptHkdf, createPBKDF2Salt } from 'octagonal-wheels/encryption/hkdf';
import { verifySyncinfo } from '../../src/livesync/syncinfo.js';

  it('fails closed when an incorrect passphrase is supplied', async () => {
    const res = await verifySyncinfo(syncinfoDoc, syncParamsDoc, 'wrong-passphrase');
    expect(res.verified).toBe(false);
    expect(res.error).toContain('Passphrase authentication failed');
  });
```

- `commonlib-path.test.ts`: characterize `path2id_base` / `id2path_base` / underscore / case-fold / obfuscation (`f:`) through the decode adapter.
- `commonlib-decode.test.ts`: V1 + V2 decrypt, chunk assemble + size check, wrong passphrase blocks; reuse salt+HKDF fixture style (lines 10-12, 28-46).
- `commonlib-enumerate-ranges.test.ts`: reserved ID prefixes / skip ranges (`h:`, `h:+`) — do not call `enumerate()`.

Any `compat/*` import requires a source comment naming `0.1.21`.

---

### `tests/integration/pull-dry-run.test.ts` / `tests/integration/pull-apply.test.ts` (test)

**Analog:** `tests/integration/inspect-command.test.ts`

**Harness + config writer + injectable stdout** (lines 16-98):
```typescript
  const harness = new CouchDbTestHarness();
  beforeAll(async () => { await harness.start(); }, 120000);
  afterAll(async () => { await harness.stop(); }, 60000);

  function writeConfigFile(dbName: string, overrides?: { /* ... */ }): string {
    const content = `
remote:
  url: ${harness.getBaseUrl().href}
  database: ${dbName}
  username: ${username}
  password: ${password}
vault:
  path: ${vaultDir}
state:
  path: ${statePath}
`;
    fs.writeFileSync(configPath, content, 'utf8');
    return configPath;
  }

    const exitCode = await runInspectCommand({
      configPath,
      json: true,
      stdout: (msg) => { output += msg; },
    });
    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    const report = JSON.parse(output.trim());
```

Dry-run: assert no vault files, no `file_provenance` rows, `update_seq` unchanged (copy invariance test lines 364-391). Apply: empty/dedicated vault, seeded `plain`/`newnote`/`notes`, conflict seed → `EXIT_CODES.CONFLICT` and dest file absent. Timeouts 120s/60s.

---

### `tests/integration/couchdb-harness.ts` (test, CRUD)

**Analog:** itself (lines 46-139)

```typescript
  async putDocument(dbName: string, docId: string, doc: Record<string, unknown>): Promise<{ rev: string }> {
    const pathSegments = docId.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`/${encodeURIComponent(dbName)}/${pathSegments}`, this.getBaseUrl());
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(doc),
    });
```

Add seed helpers for: chunked `plain`/`newnote`, legacy `notes` inline `data`, two live leaves (`PUT` then conflicting `PUT` with `new_edits` / `_rev` mismatch so `_conflicts` is populated). Harness PUTs are test-only; production pull stays GET/HEAD.

Extend `seedLiveSyncData` tweak_values so integration can seed `usePathObfuscation` / `encrypt` / `handleFilenameCaseSensitive`.

---

### `tests/unit/smoke.test.ts` / `tests/unit/config.test.ts` / `tests/unit/inspector.test.ts` / `tests/unit/transport-guard.test.ts`

**Analogs:** themselves.

- smoke: add `CONFLICT: 8`; parse `pull --dry-run -c file.yaml`; keep inspect default.
- config: `vault.dedicated: true` accepted; unknown vault key still rejected (lines 221-239).
- inspector: mock fetch map (lines 21-70) is the inventory unit-test style — add `_all_docs` pagination + `?conflicts=true` URL keys.
- transport-guard: copy capability brand test (lines 174-193) for `VaultReflectCapability`.

## Shared Patterns

### ESM `.js` import specifiers
**Source:** every `src/**/*.ts` file (e.g. `src/cli/commands/inspect.ts` lines 1-30)
**Apply to:** all new TypeScript modules
```typescript
import { openDatabase } from '../../storage/sqlite.js';
import { OutcomeCategory, EXIT_CODES } from '../../diagnostics/outcomes.js';
```

### GET/HEAD transport guard
**Source:** `src/security/transport-guard.ts` lines 6-22, 69-72
**Apply to:** `pull.ts`, `inventory.ts`, all pull integration tests
```typescript
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);
const FORBIDDEN_SUBPATHS = [
  '/_purge', '/_compact', '/_security', '/_revs_limit', '/_replicator',
  '/_design', '/_index', '/_node', '/_users', '/_config', '/_restart', '/_up',
];
    if (!ALLOWED_METHODS.has(method)) {
      throw new MutationAttemptBlockedError(method, targetUrl.href);
    }
```
Do not create `_index` / `_design` to find conflicts.

### Capability brands, not booleans
**Source:** `src/security/capabilities.ts` lines 1-27
**Apply to:** dry-run (`ReadCapability` only) and apply (`VaultReflectCapability` after preflight)
```typescript
const ReadCapabilityBrand = Symbol('ReadCapability');
export function createReadCapability(baseUrl: URL, databaseName: string): ReadCapability {
  return { [ReadCapabilityBrand]: true, baseUrl: new URL(baseUrl.href), databaseName, issuedAt: new Date() };
}
```

### Typed CLI errors → exit codes
**Source:** `src/cli/commands/inspect.ts` lines 120-256 + `src/diagnostics/outcomes.ts`
**Apply to:** `pull.ts`
Map `ConfigValidationError` → 1, auth → 2, incompatible tweaks/version → 3, missing DB → 4, network → 5, mutation → 6, malformed/persist → 7, unresolved live leaves → **8 CONFLICT**.

### Zero-mutation sandwich
**Source:** `src/livesync/zero-mutation.ts` lines 31-128; inspect coordinator lines 97-119
**Apply to:** both dry-run and apply
```typescript
    preSnapshot = await ZeroMutationVerifier.captureSnapshot(guardedFetch, allowedBaseUrl, databaseName, credentials);
    // ... read-only work ...
    postSnapshot = await ZeroMutationVerifier.captureSnapshot(guardedFetch, allowedBaseUrl, databaseName, credentials);
    ZeroMutationVerifier.assertNoMutation(preSnapshot, postSnapshot);
```

### Secret redaction
**Source:** `src/security/redaction.ts` lines 1-35; `src/diagnostics/logger.ts` lines 60-83
**Apply to:** pull reports, logs, SQLite
Never log assembled bytes, passphrases, Authorization, or credential-bearing URLs. Dry-run JSON reports size/hash only.

### SQLite repository + migration gate
**Source:** `src/storage/sqlite.ts` lines 5-43; `src/storage/admission-repo.ts` lines 17-61
**Apply to:** `file_provenance` migration 2 and `ProvenanceRepository`
`openDatabase` always runs migrations. Repos take `DatabaseSync`. No secrets in columns.

### Strict Zod config
**Source:** `src/config/schema.ts` lines 36-62; loader lines 59-68
**Apply to:** `vault.dedicated`
`.strict()` objects; `ConfigValidationError` with issue list.

### Vitest serial + Testcontainers harness
**Source:** `tests/integration/inspect-command.test.ts` lines 16-28; `tests/integration/couchdb-harness.ts` lines 9-23
**Apply to:** pull integration tests
`fileParallelism: false` already in `vitest.config.ts`. `beforeAll` 120s / `afterAll` 60s. Seed via harness PUT; production path uses guarded GET only.

### Commonlib isolation
**Source:** `src/livesync/syncinfo.ts` (sole Phase 1 codec import)
**Apply to:** `decode-adapter.ts` only
Do not import DFM, `compat/*` from CLI/domain/filesystem, or a second PouchDB package.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/filesystem/atomic-reflector.ts` | service | file-I/O | No vault write / temp+fsync+rename module exists. Copy RESEARCH.md lines 556-587 (`open`/`writeFile`/`sync`/`rename` + best-effort dir sync). Do not use Commonlib `write()`. |

`src/domain/path-policy.ts` and `src/filesystem/vault-preflight.ts` are partial matches on `src/config/loader.ts` path safety; planner should combine that with Commonlib `validateStoragePath` from RESEARCH (not a missing analog).

## Metadata

**Analog search scope:** `src/`, `tests/unit/`, `tests/characterization/`, `tests/integration/`
**Files scanned:** 29 existing TypeScript sources/tests (18 `src/`, 11 `tests/`)
**Pattern extraction date:** 2026-09-03
**Skipped:** GSD workflow `SKILL.md` indexes (not coding conventions); `CONVENTIONS.md` is empty
**Phase 1 contract files that must stay green:** `tests/integration/inspect-command.test.ts`, `tests/unit/negotiation.test.ts` encrypt-mismatch cases, `tests/unit/transport-guard.test.ts` GET/HEAD denylist
