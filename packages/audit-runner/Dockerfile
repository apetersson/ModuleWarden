# ── ModuleWarden Audit Runner ─────────────────────────────────
# Disposable container image for PI-based agentic audit runs.
# Each container gets a fresh workspace, run-specific inputs, and
# audit tools. Does NOT include core prompts, model credentials,
# Postgres credentials, or Verdaccio credentials.

FROM node:20-alpine AS base

# Install system tools needed for package inspection
RUN apk add --no-cache \
    git \
    ripgrep \
    jq \
    curl \
    wget \
    bash \
    coreutils \
    openssl \
    ca-certificates \
    build-base \
    python3

# Enable corepack for pnpm, install pnpm and yarn
RUN npm install -g corepack@latest && \
    corepack enable && \
    corepack prepare pnpm@latest --activate && \
    npm install -g yarn@1 2>/dev/null || true

# Create workspace directory structure
RUN mkdir -p /workspace/inputs /workspace/output /workspace/prepared-evidence && \
    chmod -R 777 /workspace

WORKDIR /workspace

# ── Runtime entrypoint ──────────────────────────────────────
# The worker injects run-specific workspace, RPC token, and inputs
# before starting the container. The entrypoint starts RPC mode.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
