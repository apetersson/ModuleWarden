# ── ModuleWarden Audit Runner ─────────────────────────────────
# This image is used by worker jobs to create disposable PI audit
# containers. Each container gets a fresh workspace, run-specific
# inputs, and audit tools. It does NOT include core prompts, model
# credentials, Postgres credentials, or Verdaccio credentials.

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

# Install Node.js package managers
RUN npm install -g pnpm@9 yarn@1

# Install PI runtime (agentic research harness)
# PI is installed separately per-run or baked into a derived image.
# For v1, we install the CLI for RPC mode.
RUN npm install -g @earendil-works/pi-coding-agent

# Create workspace directory
RUN mkdir -p /workspace && chmod 777 /workspace

WORKDIR /workspace

# ── Runtime entrypoint ──────────────────────────────────────
# The worker injects run-specific workspace, RPC token, and inputs
# before starting the container. The entrypoint waits for RPC
# instructions from ModuleWarden.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
