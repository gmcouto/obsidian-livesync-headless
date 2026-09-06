# obsidian-livesync-headless

## What This Is

`obsidian-livesync-headless` is a single runnable CLI application that synchronizes a local Obsidian vault directory with an existing Self-hosted LiveSync CouchDB database. It behaves as a compatible headless LiveSync client: one-shot operation brings both sides into sync, while daemon operation continuously watches local and remote changes and applies them safely.

The initial release supports only file synchronization through the LiveSync synchronization preset. Existing Obsidian LiveSync clients and their database content define the compatibility standard, but Obsidian UI behavior and plugin-management features are not part of the product.

## Core Value

Reliably synchronize an Obsidian vault without Obsidian while preserving every unproven local or remote change and never performing destructive database maintenance.

## Requirements

### Validated

- ✓ User can configure a LiveSync CouchDB connection, encryption settings, and destination vault directory without embedding secrets in source control. — Phase 1
- ✓ A first connection to an existing database discovers and validates remote configuration before any write is permitted. — Phase 1
- ✓ User can run a one-shot CLI command that safely synchronizes local and remote LiveSync data. — Phase 4
- ✓ User can interoperate with databases concurrently used by current Obsidian LiveSync clients, including their document, chunk, encryption, metadata, revision, and conflict conventions. — Phase 4
- ✓ User-initiated file deletions synchronize as LiveSync-compatible logical deletions without purging database history. — Phase 4
- ✓ Concurrent, ambiguous, unsupported, or corrupt states preserve data and stop or surface actionable diagnostics rather than guessing destructively. — Phase 4

### Active

- [ ] User can run a daemon command that continuously detects and synchronizes local and remote changes.
- [ ] The application is distributed as a single CLI executable suitable for unattended operation.

### Out of Scope

- Synchronization presets other than LiveSync — v1 targets one compatibility contract.
- A graphical user interface or Obsidian plugin — this product is deliberately headless and CLI-first.
- Obsidian plugin installation, enablement, upgrades, or lifecycle management — the application synchronizes files rather than managing Obsidian.
- LiveSync customisation-sync management for Obsidian plugins, themes, snippets, or UI configuration — v1 is limited to vault file synchronization.
- Creating, dropping, resetting, purging, compacting, rebuilding, or garbage-collecting a remote database — remote maintenance is explicitly prohibited.
- Treating locally generated state as a replacement standard for existing LiveSync data — Obsidian LiveSync clients remain authoritative for compatibility.
- Object Storage and peer-to-peer remote types — v1 targets the CouchDB-backed LiveSync path.

## Context

Self-hosted LiveSync currently runs inside Obsidian, which makes unattended synchronization on servers and other headless systems awkward. This project extracts the synchronization behavior into a standalone process configured with a connection definition and destination folder.

The remote database may already contain encrypted, chunked, conflicted, deleted, or legacy-compatible records created by other clients. Correctness therefore depends on protocol compatibility and revision provenance, not merely copying the newest file by timestamp. The initial implementation progresses as vertical slices: establish a guarded read-only connection, negotiate and pull remote configuration, materialize compatible content, execute safe bidirectional writes, and continuous daemon operation.

Logical file deletion is distinct from destructive database deletion. Normal file deletions are represented using LiveSync-compatible deletion revisions and reflected locally through a recoverable mechanism where the platform permits. Database-level destruction and maintenance remain unavailable by design.

## Constraints

- **Compatibility**: Current Obsidian Self-hosted LiveSync CouchDB data is the de-facto standard — mixed-client operation must not corrupt or silently reinterpret it.
- **Data safety**: Preserve unknown and conflicting content; require proven ancestry before automatic conflict resolution — avoiding loss outranks convenience.
- **Remote safety**: No database drop, reset, purge, rebuild, compaction, or garbage-collection capability — destructive administration must not be reachable through the application.
- **Bootstrap safety**: Inspect, negotiate, and pull remote configuration before enabling writes to an existing database — first contact must be fail-closed.
- **Scope**: Support only the LiveSync preset and CouchDB remote path in v1 — other presets and remote types are deferred.
- **Packaging**: Deliver a single CLI executable with one-shot and daemon modes — it must be straightforward to run unattended.
- **Secrets**: Credentials and encryption passphrases must be supplied at runtime or through ignored local configuration, never committed to version control.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Target full LiveSync file-data interoperability | Existing Obsidian clients and databases are the compatibility authority for synchronized files | ✓ Validated (Phase 4) |
| Exclude Obsidian UI and plugin management | The product's objective is headless file synchronization, not recreating Obsidian | ✓ Enforced |
| Synchronize logical deletion revisions | Preserve normal deletion semantics without erasing database history | ✓ Validated (Phase 4) |
| Prohibit destructive database operations | The application must never risk dropping, clearing, purging, or compacting user data | ✓ Enforced (Phase 4) |
| Ship a single CLI executable | Enables headless and unattended use with minimal deployment overhead | — Pending (Phase 6) |
| Start with guarded remote discovery and pull | Establish compatibility and safety before any mutation is allowed | ✓ Validated (Phase 1-3) |
| Explicit write arming bound to 5-tuple | Prevents accidental or misconfigured writes to unverified remotes | ✓ Validated (Phase 4) |
| Chunk-first push before note document metadata | Guarantees all content chunks exist remotely before parent revision is visible | ✓ Validated (Phase 4) |
| Build in vertical end-to-end slices | Produce an early working path to the real database and extend it safely | ✓ In Progress |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `$gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `$gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-06 after Phase 4*

