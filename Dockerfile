# ==============================================================================
# Stage 1: Build & Package Standalone SEA Executable
# ==============================================================================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Separate dependency install for layer caching
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

# Install SSL root certificates for HTTPS CouchDB remotes and timezone data
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates tzdata && \
    rm -rf /var/lib/apt/lists/*

# Copy standalone binary from builder stage
COPY --from=builder /app/dist/obsidian-livesync-headless /usr/local/bin/obsidian-livesync-headless
RUN chmod 755 /usr/local/bin/obsidian-livesync-headless

# Create dedicated non-root user and group (UID/GID 1000)
RUN groupadd -g 1000 livesync && \
    useradd -u 1000 -g livesync -m -d /home/livesync -s /bin/sh livesync

# Create default mount directories (/vault for Obsidian vault, /data for storing sync state database)
# and set permissive permissions for rootless & custom UID execution
RUN mkdir -p /vault /data /home/livesync && \
    chown -R livesync:livesync /vault /data /home/livesync && \
    chmod -R 777 /vault /data /home/livesync

# Default environment configuration
ENV HOME=/home/livesync \
    LIVESYNC_VAULT_PATH=/vault \
    LIVESYNC_STATE_PATH=/data/state.db

USER livesync

VOLUME ["/vault", "/data"]

ENTRYPOINT ["/usr/local/bin/obsidian-livesync-headless"]
CMD ["daemon"]
