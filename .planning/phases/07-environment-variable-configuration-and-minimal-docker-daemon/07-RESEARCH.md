# Phase 07: Environment Variable Configuration and Minimal Docker Daemon Distribution - Research

**Researched:** 2026-09-06
**Domain:** Environment-Driven Configuration, Docker Containerization, Multi-Stage Packaging, GitHub Actions CI/CD
**Confidence:** HIGH

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **ENV-01** | User can run any CLI command (`daemon`, `sync`, `inspect`, `status`, `arm`, `pull`) purely through environment variables without supplying or generating a YAML config file. | `src/config/loader.ts` refactored to support standalone environment variable ingestion when `--config` is omitted; CLI dispatcher updated to make `-c, --config` optional. |
| **ENV-02** | Environment variables (`LIVESYNC_*` prefix) can seamlessly override or substitute for YAML configuration with full Zod schema validation and secret redaction. | Environment variable mapping layer parses `LIVESYNC_COUCHDB_URL`, `LIVESYNC_COUCHDB_DATABASE`, `LIVESYNC_COUCHDB_USER`, `LIVESYNC_COUCHDB_PASSWORD`, `LIVESYNC_VAULT_PATH`, `LIVESYNC_DATABASE_PATH`, `LIVESYNC_ENCRYPTION_PASSPHRASE`, and `LIVESYNC_ENCRYPTION_ENABLED`, registering secrets with `SecretRedactor`. |
| **DOCKER-01** | Minimal multi-stage Docker build separating dependency installation (`package*.json`) from compilation, producing a lightweight runtime container containing only the standalone executable and required system dependencies. | Multi-stage `Dockerfile` with `node:24-bookworm-slim` builder stage (SEA bundling via esbuild + postject) and `debian:bookworm-slim` runner stage with `ca-certificates` and `tzdata`. |
| **DOCKER-02** | Docker image provides sensible defaults syncing to `/vault` (writable mount) and storing SQLite state in `/data/.state.db` (persistent mount), with clear volume mounting guidance. | `Dockerfile` sets default `ENV LIVESYNC_VAULT_PATH=/vault` and `ENV LIVESYNC_DATABASE_PATH=/data/.state.db`, creates `/vault` and `/data` directories, and declares `VOLUME ["/vault", "/data"]`. |
| **DOCKER-03** | Docker container executes the headless continuous daemon by default upon container start. | `ENTRYPOINT ["/usr/local/bin/obsidian-livesync-headless"]` and `CMD ["daemon"]` configured in `Dockerfile`. |
| **CI-01** | GitHub Actions workflow triggers on published GitHub releases to build and publish the multi-stage minimal Docker image tagged with the release version and update the `latest` tag on GHCR. | `.github/workflows/docker-publish.yml` configured with `docker/build-push-action`, `docker/metadata-action`, multi-platform support (`linux/amd64,linux/arm64`), and push authentication to `ghcr.io`. |
</phase_requirements>

## Summary

Phase 07 transforms `obsidian-livesync-headless` into a container-ready utility that can run unattended in containerized and cloud environments without needing any local filesystem configuration files. By introducing environment variable synthesis directly into `src/config/loader.ts`, every existing command (`inspect`, `pull`, `arm`, `sync`, `daemon`, `status`) gains the ability to operate using standard Unix environment variables (`LIVESYNC_*`) while preserving identical security validations (CONF-03 path safety, URL sanitization, secret redaction).

For distribution, a minimal multi-stage `Dockerfile` leverages the Node.js Single-Executable Application (SEA) packaging pipeline established in Phase 06. The build stage installs dependencies and builds the standalone binary, while the runtime stage contains only the Linux binary, system SSL root certificates (`ca-certificates`), and timezone data on top of a minimal Debian base image. Default volume mounts (`/vault` and `/data/.state.db`) and default daemon execution (`CMD ["daemon"]`) provide an out-of-the-box experience for Docker, Docker Compose, and Kubernetes deployments. Finally, a GitHub Actions workflow publishes official container images to the GitHub Container Registry (`ghcr.io`) upon release creation.

**Primary recommendation:** Extend `loadConfig()` to accept an optional `configFilePath?: string`. If `configFilePath` is provided, parse the YAML file and overlay non-empty `LIVESYNC_*` environment variables on top; if `configFilePath` is omitted, synthesize the configuration object entirely from environment variables and validate against `LiveSyncConfigSchema`. In the `Dockerfile`, package the SEA binary into a minimal `debian:bookworm-slim` container with pre-configured default paths for `/vault` and `/data/.state.db`.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Env Variable Ingestion & Parsing | `src/config/loader.ts` | `src/config/schema.ts` | Config loader parses `process.env`, maps keys to schema fields, and handles type coercion (booleans, numbers). |
| Config Merging & Secret Resolution | `src/config/loader.ts` | `src/config/secrets.ts` | Ensures environment variables override YAML file properties and all discovered plaintext secrets are registered with `SecretRedactor`. |
| CLI Argument & Command Dispatching | `src/cli/index.ts` | `src/cli/commands/*.ts` | Makes `--config` optional across all commands; passes optional `configPath` to individual command handlers. |
| Container Packaging & Defaults | `Dockerfile` | `.dockerignore` | Defines multi-stage build, layer caching, volume mount points (`/vault`, `/data`), and default `CMD ["daemon"]`. |
| Automated Container Release | `.github/workflows/docker-publish.yml` | GitHub Actions / GHCR | Automates multi-arch image builds and semver tagging upon GitHub Release publication. |

---

## Standard Stack

### Core
| Library / Tool | Version | Purpose | Why Standard |
|----------------|---------|---------|--------------|
| `zod` | 4.5.4 [VERIFIED: package.json:20] | Schema validation & coercion | Already used across codebase for strict configuration schema validation. |
| `docker` | 29.8.0 [VERIFIED: host CLI] | Container runtime & build engine | Industry-standard OCI containerization format. |
| `esbuild` & `postject` | 0.28.2 / 1.0.0-alpha.6 [VERIFIED: package.json:27-28] | Single-Executable Application (SEA) compiler | Produces standalone native binary with zero runtime npm dependencies. |
| `debian:bookworm-slim` | 12 (latest) | Minimal Linux runtime container base | Provides glibc runtime required by Node SEA with minimal footprint (~80MB base). |

### Supporting
| Library / Tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| `docker/build-push-action` | v6 [CITED: github.com/docker/build-push-action] | GitHub Action for multi-platform Docker builds | Standard CI/CD builder in GitHub Actions workflows. |
| `docker/metadata-action` | v5 [CITED: github.com/docker/metadata-action] | Docker image tagging and OCI labels | Generates semver and latest tags automatically from release events. |
| `docker/setup-buildx-action` | v3 [CITED: github.com/docker/setup-buildx-action] | Buildx multi-platform toolkit | Required for multi-arch (`linux/amd64`, `linux/arm64`) image publishing. |

---

## Architecture Patterns

### System Architecture Diagram

```
                        ┌──────────────────────────────────────────────┐
                        │              Execution Context               │
                        │                                              │
                        │  CLI Flags: --config, --write, --dry-run... │
                        │  Env Vars:  LIVESYNC_COUCHDB_URL...          │
                        └──────────────────────┬───────────────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │   src/cli/index.ts      │
                                  │   (parseCliArgs)        │
                                  └────────────┬────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │   src/config/loader.ts  │
                                  │   (loadConfig)          │
                                  └────────────┬────────────┘
                                               │
                        ┌──────────────────────┴──────────────────────┐
                        │                                             │
             [Config File Provided]                         [No Config File]
                        │                                             │
                        ▼                                             ▼
          ┌───────────────────────────┐                 ┌───────────────────────────┐
          │ Read & Parse YAML File    │                 │ Synthesize Configuration  │
          │ Apply Env Var Overrides   │                 │ Purely from Env Vars      │
          └─────────────┬─────────────┘                 └─────────────┬─────────────┘
                        │                                             │
                        └──────────────────────┬──────────────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │ LiveSyncConfigSchema    │
                                  │ (Zod Validation)        │
                                  └────────────┬────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │ Path Safety & Redaction │
                                  │ (CONF-03, SAFE-04)      │
                                  └────────────┬────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │ Command Execution:      │
                                  │ daemon | sync | inspect │
                                  └─────────────────────────┘
```

### Environment Variable Mapping Table

All environment variables follow the canonical `LIVESYNC_*` prefix, with backward-compatible aliases:

| Environment Variable | Alias / Fallback | Target Config Path | Type / Description | Default / Example |
|----------------------|------------------|--------------------|-------------------|-------------------|
| `LIVESYNC_COUCHDB_URL` | `COUCHDB_URL` | `remote.url` | `string` (valid HTTP/S URL without embedded credentials) | `http://couchdb:5984` |
| `LIVESYNC_COUCHDB_DATABASE` | `LIVESYNC_DATABASE_NAME`, `COUCHDB_DATABASE` | `remote.database` | `string` (valid CouchDB database name) | `obsidian_vault` |
| `LIVESYNC_COUCHDB_USER` | `LIVESYNC_COUCHDB_USERNAME`, `COUCHDB_USER` | `remote.username` | `string` (optional CouchDB username) | `admin` |
| `LIVESYNC_COUCHDB_PASSWORD` | `COUCHDB_PASSWORD` | `remote.password` | `string` (plaintext secret or secret ref) | `secretpassword` |
| `LIVESYNC_VAULT_PATH` | `VAULT_PATH` | `vault.path` | `string` (filesystem path to local Obsidian vault) | `/vault` (in Docker) |
| `LIVESYNC_VAULT_DEDICATED` | — | `vault.dedicated` | `boolean` (`"true"`, `"1"`, `"false"`) | `false` |
| `LIVESYNC_DATABASE_PATH` | `LIVESYNC_STATE_PATH` | `state.path` | `string` (path to SQLite state database file) | `/data/.state.db` (in Docker) |
| `LIVESYNC_ENCRYPTION_PASSPHRASE` | `LIVESYNC_PASSPHRASE` | `encryption.passphrase` | `string` (E2EE encryption passphrase) | `my-e2ee-pass` |
| `LIVESYNC_ENCRYPTION_ENABLED` | — | `encryption.enabled` | `boolean` (explicit toggle or auto-enabled if passphrase present) | `false` (or `true` if passphrase set) |
| `LIVESYNC_WRITE` | `LIVESYNC_WRITE_MODE` | `cli.write` | `boolean` (enables bidirectional write synchronization in daemon) | `false` |
| `LIVESYNC_PERIODIC_SCAN_SEC` | — | `cli.periodicScanSec` | `number` (interval in seconds for full reconciliation scan) | `300` |
| `LIVESYNC_CONCURRENCY` | — | `cli.concurrency` | `number` (concurrency worker limit) | `4` |
| `LIVESYNC_DEBOUNCE_MS` | — | `cli.debounceMs` | `number` (filesystem debounce delay in ms) | `300` |

---

### Multi-Stage Dockerfile Pattern

```dockerfile
# ==============================================================================
# Stage 1: Build & Package Standalone SEA Executable
# ==============================================================================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Separate dependency install for caching
COPY package.json package-lock.json* ./
RUN npm ci

# Copy sources and build tools
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Build standalone Single-Executable Application
RUN npm run build:sea

# ==============================================================================
# Stage 2: Minimal Distributable Runtime Image
# ==============================================================================
FROM debian:bookworm-slim AS runner

# Install SSL certificates for HTTPS CouchDB remotes and timezone database
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates tzdata && \
    rm -rf /var/lib/apt/lists/*

# Copy standalone binary
COPY --from=builder /app/dist/obsidian-livesync-headless /usr/local/bin/obsidian-livesync-headless
RUN chmod +x /usr/local/bin/obsidian-livesync-headless

# Create default mount directories
RUN mkdir -p /vault /data

# Default environment configuration
ENV LIVESYNC_VAULT_PATH=/vault \
    LIVESYNC_DATABASE_PATH=/data/.state.db

VOLUME ["/vault", "/data"]

ENTRYPOINT ["/usr/local/bin/obsidian-livesync-headless"]
CMD ["daemon"]
```

---

### GitHub Actions Release Workflow Pattern (`.github/workflows/docker-publish.yml`)

```yaml
name: Publish Docker Image

on:
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  docker-release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=latest,enable=${{ !github.event.release.prerelease }}

      - name: Build and push Docker image
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Environment Variable Validation | Custom regex / ad-hoc if-statements | `LiveSyncConfigSchema.safeParse()` via Zod | Prevents discrepancy between file-based validation rules and env-based validation rules. |
| Multi-arch Container Compilation | Custom Docker build scripts with qemu hooks | `docker/setup-buildx-action` & `docker/build-push-action` | Handles cross-compilation, layer caching, and manifest creation automatically. |
| Docker Image Tagging | Shell string manipulations in CI | `docker/metadata-action` | Adheres strictly to OCI image specifications and handles semver, prereleases, and commit SHAs cleanly. |

---

## Common Pitfalls

### Pitfall 1: Leaking Environment Secrets in Logs or Diagnostics
**What goes wrong:** Secret credentials supplied via `LIVESYNC_COUCHDB_PASSWORD` or `LIVESYNC_ENCRYPTION_PASSPHRASE` appear in unhandled errors, debug logs, or JSON status reports.
**Why it happens:** When loading from YAML, `resolveSecret()` is invoked, but when loading directly from environment variables, secrets might bypass `redactor.registerSecret()`.
**How to avoid:** Explicitly register any resolved `remotePassword` and `encryptionPassphrase` with `SecretRedactor` during config synthesis, before any network or SQLite operations.

### Pitfall 2: Path Safety Check Failure for Docker `/vault` Mount
**What goes wrong:** `CONF-03` path safety rejects `/` as vault root. If a user mounts to `/vault`, `path.resolve('/vault')` is valid, but if someone mistakenly sets `LIVESYNC_VAULT_PATH=/`, it must be rejected with a clear error message.
**Why it happens:** Path checks in `loader.ts` check `vaultPath === '/'` and root directory equality.
**How to avoid:** Retain exact `CONF-03` checks: ensure `/vault` is allowed as a dedicated directory, but `/` (root) and `~` (home) remain strictly forbidden.

### Pitfall 3: Incompatible SSL Certificates in Minimal Docker Image
**What goes wrong:** When running inside `debian:bookworm-slim` or `scratch`, `fetch()` to HTTPS CouchDB remotes fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `fetch failed`.
**Why it happens:** Minimal containers do not include system CA certificate bundles by default.
**How to avoid:** Always run `apt-get install -y --no-install-recommends ca-certificates` in the runner container stage.

### Pitfall 4: SQLite Database Overlapping with Vault in Container
**What goes wrong:** User mounts `/vault` and forgets to specify `LIVESYNC_DATABASE_PATH`, causing state database to potentially collide with vault directory.
**Why it happens:** Default state base on host is `~/.local/share/...`, which might not exist or might resolve inside container `/root`.
**How to avoid:** In Dockerfile, explicitly set `ENV LIVESYNC_DATABASE_PATH=/data/.state.db` and declare separate volumes `/vault` and `/data`.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker | Container build & testing | ✓ | 29.8.0 | Mocked integration tests |
| Node.js / npm | Build & test execution | ✓ | v25.6.1 / 11.2.0 | — |
| GitHub Actions CI | Release publishing | N/A (CI platform) | Hosted Runner | Local `docker build` |

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.11 |
| Config file | `vitest.config.ts` |
| Quick run command | `npm run test:unit` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| **ENV-01** | CLI runs without `--config` using purely environment variables | Unit / CLI | `npx vitest run tests/unit/env-config.test.ts` | ❌ Wave 0 Gap |
| **ENV-02** | `LIVESYNC_*` variables properly override/synthesize config with validation & redaction | Unit | `npx vitest run tests/unit/env-loader.test.ts` | ❌ Wave 0 Gap |
| **DOCKER-01** | Multi-stage Docker build succeeds and creates minimal runnable artifact | Integration | `docker build -t obsidian-livesync-headless:test .` | ❌ Wave 0 Gap |
| **DOCKER-02** | Container uses `/vault` and `/data/.state.db` volume defaults safely | Integration | `docker run --rm obsidian-livesync-headless:test inspect --help` | ❌ Wave 0 Gap |
| **DOCKER-03** | Container starts headless daemon by default | Integration | `docker inspect obsidian-livesync-headless:test` | ❌ Wave 0 Gap |
| **CI-01** | GitHub Actions workflow syntax and GHCR configuration valid | Lint / Action | `.github/workflows/docker-publish.yml` validation | ❌ Wave 0 Gap |

### Sampling Rate
- **Per task commit:** `npm run test:unit`
- **Per wave merge:** `npm run test:unit && npm run audit:release`
- **Phase gate:** Full test suite green + Docker build verified + Release audit clean.

---

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | CouchDB credentials and E2EE passphrases securely ingested via environment variables. |
| V4 Access Control | Yes | Path safety checks ensure container processes cannot write outside `/vault` or `/data`. |
| V5 Input Validation | Yes | Strict Zod validation on all environment variable values before network or disk access. |
| V6 Cryptography | Yes | E2EE encryption key derivation using verified salt and passphrase. |
| V14 Configuration | Yes | Sensitive values redacted from logs and error messages; no hardcoded secrets in Dockerfile. |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Environment Variable Secret Leakage | Information Disclosure | All environment-injected passwords and passphrases registered with `SecretRedactor`. |
| Malicious Volume Mount Path Traversal | Tampering / Elevation of Privilege | Vault path checks reject root directory (`/`) and home directory escapes. |
| Base Image Supply Chain Vulnerabilities | Tampering | Pinned official base image (`node:24-bookworm-slim`, `debian:bookworm-slim`). |
