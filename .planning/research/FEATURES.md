# Feature Research

**Domain:** Headless Self-hosted LiveSync-compatible vault file synchronisation
**Researched:** 2026-09-03
**Confidence:** MEDIUM
**Compatibility authority:** Existing Self-hosted LiveSync clients and CouchDB content

## Research Scope and Classification Rule

This report covers only normal vault-file synchronisation through the CouchDB-backed LiveSync preset. Here, **table stakes** means behavior required to avoid data loss, corruption, or protocol divergence in mixed-client operation—not merely a feature users would find convenient. A feature is deferred only when its absence does not weaken that safety contract.

Findings were cross-checked against current `vrtmrz/obsidian-livesync` main at `ba8f910` (2026-09-03), current `vrtmrz/livesync-commonlib` main at `c3d2255` (2026-09-02), and official CouchDB/PouchDB documentation. The overall confidence remains MEDIUM because Commonlib explicitly describes itself as a pre-1.0, non-general-purpose SDK and its compatibility exports are still moving.

## Feature Landscape

### Table Stakes (Required for Safe Mixed-Client Operation)

| Feature | Why Required | Complexity | Required Behavior | Evidence Confidence |
|---------|--------------|------------|-------------------|---------------------|
| Read-only first-contact inspection | An existing database can encode incompatible encryption, path, filename-case, chunk, or version choices. Any registration or file write before inspection can alter the compatibility authority. | HIGH | Probe connectivity, database identity, version/chunk ranges, lock state, preferred tweaks, security seed, and representative documents without writing remote milestone/node data. Fail closed if any required fact is unavailable. | MEDIUM |
| Explicit compatibility approval and write arming | A headless process cannot replace an Obsidian mismatch dialogue by silently accepting defaults. | HIGH | Produce a stable compatibility report. Allow writes only after the effective remote profile is accepted locally. Never make this device authoritative for an existing remote as a side effect of connecting. Compatible-but-lossy chunk differences may be adopted locally; incompatible differences must stop. | MEDIUM |
| Complete LiveSync document codec | Mixed databases contain multiple normal-file shapes and special/system documents. Misclassifying `plain`, `newnote`, legacy `notes`, `leaf`, or non-file entries can corrupt content. | HIGH | Read current text/binary metadata, required `eden`, child chunk lists, and supported legacy file shapes. Preserve unknown fields and skip unknown document types with a visible unsupported-state error. Never rewrite a document merely to normalise it. | MEDIUM |
| Path and metadata fidelity | The metadata ID is derived from the path, case policy, underscore handling, and optional obfuscation. `ctime`, `mtime`, `size`, type, and logical deletion affect reflection and diagnosis. | HIGH | Use the upstream path-to-ID rules; preserve vault-relative paths, Unicode, timestamps, binary/text type, and case behavior. Validate `actualDocumentId === path2id(declaredPath)` before reflection or mutation. Quarantine mismatched/ambiguous metadata rather than repairing it automatically. | MEDIUM |
| Current and legacy-compatible encryption reads/writes | A wrong passphrase or wrong algorithm can make valid content appear corrupt. Current clients may encounter older encrypted revisions in the same database. | HIGH | Support negotiated E2EE mode, current HKDF transform, supported V1 fallback reads, encrypted chunks, sync/security material, Eden, and path-obfuscated metadata. Verify decryption before any write; unknown encryption markers or failed authentication stop the affected item and block unsafe write enablement. | MEDIUM |
| Chunk creation, validation, and assembly | File metadata and chunk documents are separate, non-transactional CouchDB writes. Readers may observe metadata before all chunks arrive. | HIGH | Support negotiated hash/splitter/chunk-size conventions and text/binary encoding. Validate chunk ID/content and reconstructed file size/content. Write all chunks successfully before metadata; inspect every bulk result. On read, retry through a bounded known producer and classify missing, corrupt, transient, and unsupported outcomes separately. | MEDIUM |
| Finite pull and materialisation | The first safe vertical path must prove the client can understand the authoritative remote without changing it. | HIGH | Pull to a local replica/staging area, retain revision trees and deletion tombstones, wait for the finite catch-up boundary, validate decrypt/chunks/metadata, then plan filesystem actions. An incomplete pull must remain resumable and must not be reported as success. | MEDIUM |
| Bidirectional one-shot convergence | `sync` must synchronize both the remote database and the vault, not just replicate databases or run an mtime mirror independently. | HIGH | Start with preflight and remote catch-up; scan the vault; reconcile using exact provenance/history; apply safe local and remote writes; run the opposite replication direction as needed; and finish only after callbacks/writes settle and a final reconciliation finds no actionable safe work. Repeated invocations must be idempotent. | MEDIUM |
| Daemon startup catch-up before live work | Opening watchers against stale local state can reinterpret remote changes as local edits or deletions. | HIGH | Run the same preflight and finite catch-up as one-shot, reconcile the vault, then enable filesystem watching and the remote live feed. Never enable remote writes because the process is unattended. | MEDIUM |
| Durable continuous operation | CouchDB live feeds disconnect, processes restart, and filesystem watchers overflow or coalesce events. | HIGH | Preserve opaque checkpoints; use heartbeats/retry with bounded exponential backoff and jitter; expose paused/active/denied/fatal states; serialize work per path; suppress self-generated file events; perform periodic/restart full reconciliation; cancel and drain cleanly on shutdown. Polling may be a fallback, not a different consistency model. | MEDIUM |
| Exact revision provenance | CouchDB records revision ancestry but not which peer produced a revision; the deterministic winner may not be the branch displayed locally. | HIGH | Persist device-local `path -> { revision, observedStorageMtime? }` only after successful reflection/write. Treat revision as authoritative and mtime as diagnostic. Reconstruct provenance only when bytes match exactly one available revision; ambiguity remains unresolved. | MEDIUM |
| Conservative conflict preservation | Replication can create multiple live leaves. Winner, latest mtime, highest generation, or same path do not prove user intent. | HIGH | Enumerate every live leaf and available ancestry. Collapse byte-identical leaves; auto-merge text/structured data only from the nearest available shared ancestor and only for non-overlapping changes. Keep delete-vs-modify, binary differences, missing bodies, unrelated generation-one leaves, and stale/concurrent resolutions unresolved. Never hide conflicts after reflecting the winner. | MEDIUM |
| Branch-correct edits, deletes, and renames | While a conflict is live, attaching a local operation to the database winner can erase the branch actually edited by the user. | HIGH | Extend the exact displayed revision. A case-only rename stays in the same tree. A cross-path rename stores the target first, then logically deletes only the proven displayed source branch. If provenance is unproved, preserve every source branch and the target copy for review. | MEDIUM |
| LiveSync logical deletion semantics | LiveSync's `deleted` metadata marker and CouchDB's `_deleted` tombstone are not interchangeable during a live file conflict. | HIGH | Represent an ordinary user file deletion as a non-purging logical-deletion child of the proven revision. Replicate existing CouchDB tombstones without attempting payload decryption. Never purge history. An unproved local deletion must not delete any remote branch. | MEDIUM |
| Recoverable local reflection | Remote deletion or overwrite is the highest-risk local effect of an unattended client. | MEDIUM | Use temp-write, fsync/close, atomic replace where supported, and post-write verification before recording provenance. Move remotely deleted/replaced local files into a private recoverable trash/quarantine with collision-safe names and an audit record; if recovery cannot be guaranteed, stop before removal. | MEDIUM |
| Stable target-file policy | Different inclusion rules in each direction create resurrection loops and phantom deletions. | MEDIUM | Synchronize the same normal-file set in both directions, reserve the synchronizer's state/trash paths, and validate ignore rules at startup. Exclude Customisation Sync/system namespaces rather than treating their documents as vault files. | MEDIUM |
| Dry-run with an enforceable no-write boundary | A report-only mode is useful only if it is structurally incapable of mutating CouchDB or the vault. | MEDIUM | `--dry-run` performs remote reads, local scans, decoding, and conflict analysis, then emits intended actions and blockers. Construct the run with read-only remote/local capabilities; do not merely branch around selected write calls. Distinguish `create`, `update`, `logical-delete`, `trash`, `conflict`, `skip`, and `blocked`. | MEDIUM |
| Actionable observability and exit semantics | Unattended success cannot mean merely that the process stayed alive. Silent skips can conceal divergence indefinitely. | MEDIUM | Emit human and JSON logs with run ID, mode, direction, path/document ID (redactable), revision, checkpoint, counts, duration, retry state, and categorized outcome. Redact credentials, passphrases, setup URIs, encrypted payloads, and sensitive headers. Non-zero exits/health states distinguish incompatibility, authentication, corruption, unresolved conflict, partial write, and transient outage. | MEDIUM |
| Mixed-client conformance gate | Schema-level unit tests cannot prove interoperability with revision trees and real client behavior. | HIGH | Release only against fixtures and two-client scenarios produced by current Obsidian LiveSync: encrypted/obfuscated data, text/binary files, legacy/current entries, chunks, remote deletion, concurrent edits, conflict resolution propagation, case-only/cross-path rename, restart, and corrupt/missing chunks. | MEDIUM |

### Differentiators (Add After the Safety Contract Is Proven)

| Feature | Value Proposition | Complexity | Boundary | Evidence Confidence |
|---------|-------------------|------------|----------|---------------------|
| Explainable synchronization plan | Makes a headless safety decision auditable before and after execution. | MEDIUM | Machine-readable plan shows evidence used for every action: local hash, displayed revision, remote leaves, merge base, and why automation was permitted or blocked. | MEDIUM |
| Read-only forensic inspector | Lets operators diagnose conflicts and corruption without opening Obsidian or mutating the tree. | MEDIUM | List all live leaves, available ancestors, logical deletions, chunk availability, metadata-ID mismatches, and vault comparison; export a selected readable revision to a separate recovery path. | MEDIUM |
| Guided local recovery workflow | Reduces recovery time while retaining explicit operator intent. | HIGH | Restore quarantined files or create a new successor from a selected available historical revision. Recheck exact revisions immediately before mutation; do not add remote rebuild/repair powers. | MEDIUM |
| Compatibility drift report | Gives early warning when newer Obsidian clients introduce schema, tweak, or algorithm values this binary does not support. | MEDIUM | Report observed plugin/commonlib/protocol values, supported ranges, and first unsupported documents; remain read-only until upgraded. | MEDIUM |
| Deterministic daemon status endpoint/file | Improves orchestration without creating a remote-control API. | LOW | Local-only health output exposes last successful catch-up, live-feed state, queue depth, unresolved count, checkpoint age, and whether writes are armed. It must not expose secrets or accept mutation commands. | MEDIUM |
| Adaptive but equivalent feed/poll operation | Works behind proxies that cannot hold `_changes` connections while preserving one consistency contract. | MEDIUM | Switch only between live feed and checkpointed finite polling; both use the same reconciliation, provenance, conflict, and retry engine. | MEDIUM |
| Compatibility corpus and replay tool | Turns mixed-client regressions into reproducible release evidence. | HIGH | Consume sanitized CouchDB exports/fixtures and file-event traces offline; replay without connecting to a private database. This is a strong maintenance differentiator, not a runtime user requirement. | MEDIUM |

### Anti-Features (Explicitly Exclude)

| Feature | Why It Looks Useful | Why It Is Unsafe or Out of Scope | Required Alternative |
|---------|---------------------|----------------------------------|----------------------|
| Automatic newest-mtime/highest-revision winner | Simple unattended conflict policy | Time and generation do not prove ancestry, displayed branch, or user intent; upstream explicitly treats mtime as diagnostic except for a legacy binary compatibility behavior. | Exact provenance plus conservative ancestry-based merge; leave ambiguous conflicts unresolved. |
| Bypass version/tweak checks in daemon mode | Avoids interactive prompts | Converts lack of UI into permission to reinterpret an existing database. Current upstream CLI does this for its daemon, but it violates this project's fail-closed contract. | Separate read-only inspection and explicit local approval before daemon write arming. |
| Bidirectional writes on first contact | Feels like instant setup | A stale or empty local vault can overwrite, resurrect, or delete authoritative remote content before a baseline exists. | Pull/validate first, generate a dry-run plan, then explicitly arm writes. |
| Treat CouchDB winner as the local displayed revision | Avoids local provenance state | The winner is deterministic database policy, not evidence of which conflict branch the local user edited. | Persist exact device-local revision provenance and reconstruct only from a unique byte match. |
| Use `_deleted` or purge for ordinary file deletion | Appears to remove a file cleanly | A tombstone can remove a deletion-vs-modification decision from the set of live branches; purge destroys replication history. | Write LiveSync-compatible `deleted` metadata on the proven branch; reserve existing `_deleted` handling for replicated tombstones. |
| Automatic conflict-branch deletion or corrupt-data cleanup | Keeps the database tidy | Missing chunks, compacted bodies, and losing leaves may contain the only copy of user data. | Preserve and surface; offer read-only inspection and narrowly confirmed exact-revision recovery later. |
| Remote reset, rebuild, overwrite, drop, purge, compaction, or garbage collection | Common repair/storage-management requests | These operations can erase remote-only changes and materially exceed file synchronization. GC can also make unresolved history unreadable. | Diagnose and export evidence; direct operators to supported upstream administration outside this executable. |
| Remote lock/unlock, milestone mutation, node acceptance, or `_replicator` job management | Convenient automation | These are remote administration, persist authority/credentials remotely, or mutate the compatibility gate itself. | Read status only; administration remains external. |
| Obsidian UI or plugin lifecycle management | Familiar setup and conflict dialogs | Recreates Obsidian rather than delivering a headless file client. | CLI reports, JSON plans, stable exit codes, and external operator workflows. |
| Customisation Sync, plugin/theme/snippet management, or hidden-file feature semantics | Those files live near the vault | They use separate namespaces, selection rules, and conflict behavior and can overlap ordinary files dangerously. | Synchronize only the agreed normal vault-file namespace. |
| Object Storage or P2P transports | Broader compatibility | They use different replication and chunk-delivery capabilities and would multiply the v1 safety surface. | CouchDB-backed LiveSync preset only. |
| Arbitrary partial/selective vault sync | Saves space or bandwidth | Asymmetric filters can cause resurrection, false deletion, and mixed-client disagreement about ownership. | One validated, symmetric normal-file target policy; reconsider only with a protocol-level ownership model. |
| One-shot mtime mirror presented as full sync | Easy to implement | Current upstream CLI documents that its `mirror` does not infer local deletion, skips conflicts, and compares mtime for paired files; by itself it is not safe mixed-client convergence. | Integrated remote catch-up, provenance-aware reconciliation, bidirectional replication, and final convergence check. |
| Silent skip on unknown/corrupt/oversized data | Lets most files continue | Operators may see a green run while the vault diverges or data remains unreadable. | Continue only where isolation is proven, but finish degraded/non-zero with itemized blockers. |
| Synchronizer marketed as backup | Encourages operational reliance | Replication propagates deletions and conflicts; retained chunks/history may later become unavailable. | State explicitly that independent versioned backups are required. |

## Feature Dependencies

```text
[Read-only remote inspection]
    └──requires──> [Secret-safe connection configuration]
    └──produces──> [Negotiated compatibility profile]
                         ├──requires──> [Version/tweak classification]
                         ├──requires──> [Encryption + path codec]
                         └──requires──> [Document + chunk codec]

[Finite pull into local replica]
    └──requires──> [Negotiated compatibility profile]
    └──requires──> [Checkpointed replication]
    └──requires──> [Chunk validation and bounded retrieval]
    └──enables───> [Read-only dry-run plan]
                         └──enables───> [Recovery-safe local materialisation]

[Exact revision provenance]
    ├──enables───> [Safe bidirectional one-shot]
    ├──enables───> [Branch-correct edit/delete/rename]
    └──enables───> [Conservative conflict handling]

[Safe bidirectional one-shot]
    ├──requires──> [Recovery-safe local materialisation]
    ├──requires──> [Logical deletion semantics]
    ├──requires──> [Conflict preservation]
    └──enables───> [Daemon startup catch-up]
                         └──enables───> [Continuous feed + filesystem watcher]
                                              └──requires──> [Retry, reconciliation, shutdown]

[Structured observability] ──spans──> [Every stage and every blocked item]

[Destructive DB operations] ──conflict-with──> [Preservation-first product boundary]
```

### Dependency Notes

- **Inspection precedes all write-capable components:** even upstream compatibility helpers may update milestone/node data while checking. The first-contact path needs a deliberately read-only implementation, not a call to a helper that mixes assessment and registration.
- **The codec precedes sync logic:** conflict, deletion, provenance, and mtime decisions are meaningless until metadata and all referenced chunks are decoded and validated.
- **Chunks precede metadata on write:** CouchDB bulk operations are non-atomic. Every chunk result must succeed before publishing a metadata revision that references it.
- **A finite catch-up precedes daemon watchers:** this establishes a coherent local baseline and a bounded point at which unavailable chunks can be classified.
- **Provenance precedes automatic deletion and rename:** after the file body is gone, branch identity cannot be reconstructed from content. Deletion without recorded provenance must preserve all branches.
- **Recovery-safe local writes precede remote-deletion reflection:** a daemon should not remove the only local copy until it can prove a recoverable move or stop safely.
- **One-shot is the daemon's engine:** daemon mode should schedule the same reconciliation primitives, not implement separate semantics.

## MVP Definition

### Minimal Vertical Validation Slice

The smallest safe end-to-end slice is deliberately **read-only toward the remote**:

1. `inspect` an existing CouchDB database and emit a compatibility report without remote writes.
2. Run `sync --pull-only --dry-run` into a new local replica, decode encrypted/obfuscated metadata, assemble text and binary chunks, retain revision trees/tombstones, and produce planned filesystem actions.
3. Apply that plan only to an empty or dedicated staging vault using recovery-safe writes, then verify byte-for-byte materialisation and report unsupported/conflicted/unreadable entries as blockers.

This slice validates the hardest compatibility boundary against real LiveSync data without risking the remote. It is an engineering MVP, not yet the promised bidirectional synchronizer.

### Launch With (v1)

- [ ] Read-only discovery, compatibility report, and explicit write arming.
- [ ] Current plus required legacy document/path/encryption/chunk decoding and compatible writing.
- [ ] Pull-first, provenance-aware bidirectional one-shot convergence with enforceable dry-run.
- [ ] Exact revision provenance and conservative mixed-client conflict preservation.
- [ ] Provenance-gated logical deletion, branch-correct rename, and recoverable local trash/quarantine.
- [ ] Daemon built on finite startup catch-up, continuous `_changes` plus file watching, durable checkpoints, retries, and full reconciliation.
- [ ] Structured/redacted observability, stable non-zero degraded/failure outcomes, and mixed-client conformance tests.

### Add After Validation (v1.x)

- [ ] Read-only forensic revision/chunk inspector and safe export—add when first real-world unresolved conflicts appear.
- [ ] Explainable JSON action evidence—add once action categories and provenance schema stabilize.
- [ ] Local-only daemon status file/endpoint—add when service-manager integration needs richer health than exit/log state.
- [ ] Guided recovery from local quarantine or an available historical revision—add only after exact-revision recheck primitives are proven.
- [ ] Adaptive live-feed/poll fallback—add when proxy compatibility demands it; retain identical sync semantics.

### Future Consideration (v2+)

- [ ] Compatibility corpus/replay tooling for maintainers—valuable once sanitized real-world fixtures exist.
- [ ] Selective synchronization—consider only with an explicit ownership/deletion model that prevents asymmetric-filter data loss.

### Never Add

Obsidian UI, plugin lifecycle management, Customisation Sync, hidden-file feature semantics, remote administration, destructive database operations, Object Storage, P2P, and any automatic policy that discards unproved data.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Read-only inspection and write arming | HIGH | HIGH | P1 |
| Document/path/encryption/chunk compatibility | HIGH | HIGH | P1 |
| Pull-only finite materialisation | HIGH | HIGH | P1 |
| Enforceable dry-run | HIGH | MEDIUM | P1 |
| Exact revision provenance | HIGH | HIGH | P1 |
| Safe bidirectional one-shot | HIGH | HIGH | P1 |
| Conflict and logical-deletion preservation | HIGH | HIGH | P1 |
| Recovery-safe local reflection | HIGH | MEDIUM | P1 |
| Structured observability and failure states | HIGH | MEDIUM | P1 |
| Daemon continuous operation | HIGH | HIGH | P1, after one-shot |
| Forensic inspector/export | HIGH | MEDIUM | P2 |
| Explainable JSON evidence | MEDIUM | MEDIUM | P2 |
| Local daemon status surface | MEDIUM | LOW | P2 |
| Adaptive polling fallback | MEDIUM | MEDIUM | P2 |
| Guided historical/quarantine restore | MEDIUM | HIGH | P2 |
| Selective synchronization | LOW | HIGH | P3 / research-gated |

**Priority key:**

- P1: Required for a safe v1 promise.
- P2: Valuable after the core safety contract is validated.
- P3: Defer; current semantics are not safe enough to schedule.

## Reference Implementation Feature Analysis

| Behavior | Obsidian LiveSync 1.0.x | Current Upstream LiveSync CLI | Recommended Headless Product |
|----------|-------------------------|-------------------------------|------------------------------|
| First-contact mismatch handling | Interactive review can adopt remote settings, keep local settings, or cancel; incompatible changes may require reset/rebuild workflows. | `sync` uses user-initiated recovery paths, but daemon source explicitly disables config-mismatch checking because it cannot show the dialogue. | Read-only probe plus explicit, persistent local approval; never bypass in unattended mode and never expose rebuild. |
| One-shot vault convergence | Replication, scanning, and reflection are integrated in the plugin lifecycle. | `sync` replicates databases; `mirror` reconciles local DB/files separately, uses mtime for paired files, skips conflicts, and intentionally does not infer storage deletions. | One command orchestrates pull-first replication, validated scan, provenance-aware reconciliation, push/pull completion, and final convergence. |
| Continuous operation | Live replication and Obsidian file events. | Daemon performs initial replication, mirror scan, then `_changes`/watcher operation or interval polling with backoff. | Preserve this staged shape, but use the strict preflight and the exact same safety engine as one-shot. |
| Conflict behavior | Commonlib ancestry rules plus Obsidian dialogues and persistent device-local provenance. | Supports revision inspection and explicit keep-one-revision commands; unattended UI policy is limited. | Auto-resolve only byte-identical or provably non-overlapping shared-base cases; otherwise preserve and report for external review. |
| Local deletions | Remote removal follows Obsidian's trash preference; conflict-time deletion extends the displayed branch. | Daemon watches deletion; `mirror` intentionally restores a storage-only deletion unless `rm` is used. | Require proven displayed revision, write logical deletion, and retain a recoverable local copy/audit trail. |
| Dry-run | Interactive previews exist in selected workflows, not as a universal no-write mode. | No general dry-run command or option is documented in the current command surface. | Universal capability-level read-only mode is required before writes can be armed. |
| Observability | Notices, dialogues, status views, history/repair screens, and reports. | Human CLI logs, verbose mode, revision info, exit codes, and daemon state messages. | Human plus JSON events, stable reason codes, health state, secret redaction, and explicit degraded completion. |

## Roadmap Implications

Recommended feature order:

1. **Compatibility inspector and pull-only staging slice**—prove read-only remote discovery, config/tweak negotiation, codec coverage, encrypted chunk reconstruction, checkpoints, and observable blockers.
2. **Safe local reflection and provenance**—add atomic/recoverable filesystem writes, target filtering, metadata identity validation, and persistent exact-revision records.
3. **Bidirectional one-shot**—add ordinary revision writes, chunks-before-metadata ordering, logical deletion, rename semantics, conflict preservation, dry-run/apply, and final convergence.
4. **Daemonization**—reuse the one-shot engine for startup catch-up, then add live feed/watcher scheduling, retry, overflow reconciliation, shutdown, and health reporting.
5. **Forensics and recovery**—add revision/chunk inspection, export, and narrowly scoped local/historical restoration only after mixed-client behavior is validated.

Do not schedule daemon work before one-shot convergence and provenance are proven. A long-running unsafe synchronizer only increases the number of opportunities to apply a wrong decision.

## Sources

All confidence labels below use the research confidence classifier after cross-checking independent official sources; the resulting tier is MEDIUM.

### Self-hosted LiveSync (primary)

- [Current release history and synchronization fixes](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/updates.md) — MEDIUM
- [Conflict resolution and revision provenance specification](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/specs_conflict_resolution.md) — MEDIUM
- [Metadata document ID validation and repair design](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/design_docs/metadata_document_id_validation_and_repair.md) — MEDIUM
- [Chunk retrieval and waiting specification](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/design_docs/chunk_retrieval_and_waiting.md) — MEDIUM
- [Recovery guide](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/docs/recovery.md) — MEDIUM
- [Current upstream CLI behavior and command surface](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/src/apps/cli/README.md) — MEDIUM
- [Current upstream daemon and one-shot command implementation](https://github.com/vrtmrz/obsidian-livesync/blob/ba8f910865bdc5dab83f02941acfb82dcc3bdcb0/src/apps/cli/commands/runCommand.ts) — MEDIUM

### LiveSync Commonlib (primary)

- [Commonlib package scope and stability boundary](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/readme.md) — MEDIUM
- [File metadata, chunk, and system document types](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/common/models/db.type.ts) — MEDIUM
- [Matched, incompatible, and compatible-but-lossy tweak definitions](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/common/models/tweak.definition.ts) — MEDIUM
- [Remote milestone compatibility checks](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/pouchdb/LiveSyncDBFunctions.ts) — MEDIUM
- [Current and fallback encryption transforms](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/pouchdb/encryption.ts) — MEDIUM
- [Path/document-ID derivation and target-file helpers](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/string_and_binary/path.ts) — MEDIUM
- [Commonlib conflict and file-provenance contract](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/docs/conflict-resolution.md) — MEDIUM
- [Device-local file reflection provenance interface](https://github.com/vrtmrz/livesync-commonlib/blob/c3d2255ba1d57c21ed2348163bd985ede7446dbd/src/interfaces/FileReflectionProvenance.ts) — MEDIUM

### CouchDB and PouchDB (official documentation)

- [CouchDB replication protocol](https://docs.couchdb.org/en/stable/replication/protocol.html) — MEDIUM
- [CouchDB replication introduction](https://docs.couchdb.org/en/stable/replication/intro.html) — MEDIUM
- [CouchDB replication and conflict model](https://docs.couchdb.org/en/stable/replication/conflicts.html) — MEDIUM
- [CouchDB changes feed](https://docs.couchdb.org/en/stable/api/database/changes.html) — MEDIUM
- [CouchDB bulk-write transaction semantics](https://docs.couchdb.org/en/stable/api/database/bulk-api.html#bulk-documents-transaction-semantics) — MEDIUM
- [CouchDB local, non-replicating documents](https://docs.couchdb.org/en/stable/api/local.html) — MEDIUM
- [PouchDB replication guide](https://pouchdb.com/guides/replication.html) — MEDIUM
- [PouchDB replication API and lifecycle events](https://pouchdb.com/api.html#replication) — MEDIUM

---
*Feature research for: obsidian-livesync-headless*
*Researched: 2026-09-03*
