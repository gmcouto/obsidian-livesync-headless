---
quick_id: 260906-n3e
slug: please-make-docker-respect-docker-user-s
description: Please make docker respect docker user setup, to run in rootless mode
status: complete
date: 2026-09-06
commit: 40abd3a
---

# Quick Task Summary: Rootless Docker & Non-Root User Setup

## Changes Made
1. **Dockerfile**:
   - Added creation of dedicated unprivileged group and user `livesync` (UID 1000, GID 1000) with home directory `/home/livesync`.
   - Created `/vault`, `/data`, and `/home/livesync` with ownership `livesync:livesync` and permissive permissions (`chmod -R 777`) to allow arbitrary UID/GID execution in rootless Docker, Podman, and user-namespace mapped environments.
   - Configured `ENV HOME=/home/livesync`.
   - Set `USER livesync` directive in the runner stage so the container runs as non-root by default.
2. **Integration Tests (`tests/integration/docker-daemon.test.ts`)**:
   - Added automated image build in `beforeAll`.
   - Verified image metadata (`Config.User === 'livesync'`, `HOME=/home/livesync`).
   - Added tests confirming container runs as `livesync` (UID 1000) by default and can execute and write to `/vault` and `/data` with arbitrary custom UIDs (e.g. `--user 1001:1001`).
3. **Documentation (`README.md`)**:
   - Updated Docker Quickstart and Docker Compose documentation to detail non-root execution (`livesync`, UID 1000:1000), custom UID/GID pass-through via `--user <uid>:<gid>`, and `user: "1000:1000"` compose directive.

## Verification
- Docker image build passed (`docker build -t obsidian-livesync-headless:test .`).
- All 5 Docker container integration tests passed (`tests/integration/docker-daemon.test.ts`).
- All 44 unit test suites (255 tests) passed.
- Release safety audit passed (`npm run audit:release`).
