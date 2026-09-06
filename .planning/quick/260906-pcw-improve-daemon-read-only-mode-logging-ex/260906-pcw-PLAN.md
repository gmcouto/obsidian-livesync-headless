# Quick Task: Improve daemon read-only mode logging and handle LIVESYNC_WRITE

## Objectives
1. Explain clearly why the system is in read-only mode and how to enable write/bidirectional mode.
2. Honor `LIVESYNC_WRITE=true` from environment variables in daemon mode without requiring `--write` on the command line.
3. Defer banner display until the effective write mode is resolved from configuration.
4. Improve write grant missing error message with clear WHY and FIX sections, including the Docker command to arm.
