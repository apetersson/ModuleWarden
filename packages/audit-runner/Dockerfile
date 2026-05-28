# ── ModuleWarden Audit Runner ─────────────────────────────────
# Disposable container image for PI-based agentic audit runs.
# Each container gets a fresh workspace, run-specific inputs,
# the RPC bridge server, the audit orchestrator, and audit tools.
# Does NOT include core prompts, model credentials, Postgres
# credentials, or Verdaccio credentials.

FROM node:20-alpine AS base

# Install system tools needed for package inspection + networking
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
    python3 \
    netcat-openbsd

# Enable corepack for pnpm
RUN npm install -g corepack@latest && \
    corepack enable && \
    corepack prepare pnpm@latest --activate

# Install PI as the agentic audit runtime
RUN npm install -g @earendil-works/pi-coding-agent@latest

# Create workspace directory structure
RUN mkdir -p /workspace/inputs /workspace/output /workspace/prepared-evidence && \
    chmod -R 777 /workspace

WORKDIR /workspace

# ── Copy the RPC bridge server ────────────────────────────────
# Built from packages/audit-rpc-server
COPY packages/audit-rpc-server/dist/ /app/rpc-bridge/

# ── Copy the PI audit orchestrator ────────────────────────────
# Built from packages/audit-runner/src/orchestrator.ts
COPY packages/audit-runner/dist/orchestrator.js /app/orchestrator/index.js

# ── Copy the entrypoint ───────────────────────────────────────
COPY packages/audit-runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
