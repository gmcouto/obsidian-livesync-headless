# Quick Plan: Add LIVESYNC_WRITE=auto-arm mode

## Overview
Implement `LIVESYNC_WRITE=auto-arm` (and `--auto-arm` / `--write=auto-arm`) mode.
In this mode:
1. Check trigger conditions on startup:
   - Vault folder is empty (0 user files)
   - State DB is empty (non-existent, 0 bytes, or 0 provenance/admission records)
   - Amount of changes locally are over 10 files since last sync (10 new files, or 10 deleted files locally, or total changes > 10)
   - Or write grant is missing
2. When triggered:
   - Clean up local vault (remove user files)
   - Clean up local state DB (remove or reinitialize SQLite state)
   - Perform read-only pull/sync to materialize all remote files into vault
   - Validate synchronization completed cleanly
   - Automatically arm (issue 5-tuple write grant)
3. Start daemon in bidirectional write mode with write capability.

## Tasks
1. **Config & Schema Support**: Update `schema.ts`, `loader.ts`, `cli/index.ts` to support `write: 'auto-arm' | boolean` and `autoArm: boolean`, parsing `LIVESYNC_WRITE=auto-arm` (and `--auto-arm`).
2. **Auto-Arm Core Implementation**: Create `src/domain/auto-arm.ts` with trigger detection (empty vault, empty state, >10 changes), vault/state cleanup, read-only pull execution, sync validation, and write-grant issuance.
3. **Daemon & CLI Integration**: Wire auto-arm orchestrator into `daemon.ts` and CLI, updating help output and logging.
4. **Unit & Integration Tests**: Add comprehensive unit tests covering all trigger conditions, cleanup, read-only sync, validation, auto-arming, and daemon startup.
