---
status: resolved
trigger: "When I push a delete operation, the other GUIs of Obsitian skip the delete operation for some reason, I think we are pushing the delete operation wrong: The GUI replication processor says: \"[ReplicateResultProcessor] Skipped unexpected non-note document: \" and then the file name."
created: 2026-09-06
updated: 2026-09-06
symptoms:
  expected: "Obsidian GUI clients process the logical deletion document pushed by obsidian-livesync-headless and delete/trash the corresponding note in their local vaults."
  actual: "Obsidian GUI client replication processor logs '[ReplicateResultProcessor] Skipped unexpected non-note document: <path>' and skips deleting the file."
  errors: "[ReplicateResultProcessor] Skipped unexpected non-note document: <filename>"
  reproduction: "Push a file deletion via obsidian-livesync-headless, then observe Obsidian GUI client sync log."
---

## Current Focus
- hypothesis: "DeletionWriter was creating documents with `type: 'notes'` (legacy v1 LiveSync type) instead of `type: 'plain'`. In upstream Obsidian LiveSync's `ReplicateResultProcessor`, `isNoteEntry(doc)` only accepts `type === 'plain' || type === 'newnote'`. When `type` was `'notes'`, `isNoteEntry` returned false, causing the GUI to log `[ReplicateResultProcessor] Skipped unexpected non-note document:` and skip deleting the local file."
- test: "Update `DeletionWriter` to emit `type: 'plain'`, update tests, and verify against unit tests and real CouchDB mixed-client interop suite."
- expecting: "All unit, characterization, and real CouchDB interop tests pass, and deletions are correctly recognized as note documents."
- next_action: "None. Fix verified and resolved."

## Resolution
- root_cause: "In `src/livesync/deletion-writer.ts`, `deletionDoc` had `type: 'notes'`. In LiveSync (both `@vrtmrz/livesync-commonlib` and Obsidian GUI plugin), `isNoteEntry(doc)` checks `doc.type == 'newnote' || doc.type == 'plain'`. When `type: 'notes'` was pushed, the Obsidian GUI skipped the document as a non-note document."
- fix: "Changed `type: 'notes'` to `type: 'plain'` in `src/livesync/deletion-writer.ts` (and updated test fixtures in `tests/unit/deletion-writer.test.ts` and `tests/integration/couchdb-harness.ts`)."
- verification: "Unit tests in `tests/unit/deletion-writer.test.ts`, all 45 unit test suites (272 tests), characterization suites (23 tests), and real CouchDB integration suite `tests/integration/mixed-client-interop.test.ts` (11 tests including logical deletions) all passed."
- files_changed:
  - src/livesync/deletion-writer.ts
  - tests/unit/deletion-writer.test.ts
  - tests/integration/couchdb-harness.ts
