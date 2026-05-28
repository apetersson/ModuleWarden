# ── ModuleWarden Audit Runner ─────────────────────────────────
# Disposable container image for agentic audit runs.
# The orchestrator runs PI in RPC mode (when model endpoint configured)
# or falls back to tool-only inspection.
# RPC bridge server TBD: requires fastify bundled — tracked separately.

FROM node:20-alpine

# System tools for package inspection
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
RUN npm install -g corepack@latest && corepack enable && corepack prepare pnpm@latest --activate

# Install PI as the agentic audit runtime
RUN npm install -g @earendil-works/pi-coding-agent@latest

# Create workspace directory structure
RUN mkdir -p /workspace/inputs /workspace/output /workspace/prepared-evidence && \
    chmod -R 777 /workspace

WORKDIR /workspace

# Copy the orchestrator (built locally before docker build)
COPY packages/audit-runner/dist/orchestrator.js /app/orchestrator/index.js

# Copy the entrypoint
COPY packages/audit-runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
