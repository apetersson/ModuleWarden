# ── ModuleWarden Audit Runner ─────────────────────────────────
# Disposable container image for agentic audit runs.
# The image includes both the RPC bridge server and the PI orchestrator.

# ── Stage 1: Install workspace dependencies needed by the RPC bridge ────────
FROM node:22-alpine AS deps
RUN npm install -g pnpm@9
WORKDIR /app
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml ./
COPY packages/audit-runner/package.json packages/audit-runner/
COPY packages/audit-rpc-server/package.json packages/audit-rpc-server/
COPY packages/shared/package.json packages/shared/
COPY packages/prisma-client/package.json packages/prisma-client/
COPY packages/api-proxy/package.json packages/api-proxy/
COPY packages/worker/package.json packages/worker/
COPY packages/web-ui/package.json packages/web-ui/
RUN pnpm install --frozen-lockfile

FROM node:22-alpine

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

# Install PI as the agentic audit runtime plus source-formatting helpers for
# inspecting minified npm artifacts without changing the canonical evidence.
RUN npm install -g \
    @earendil-works/pi-coding-agent@latest \
    prettier@3 \
    js-beautify@1

# Create workspace directory structure
RUN mkdir -p /workspace/inputs /workspace/output /workspace/prepared-evidence && \
    chmod -R 777 /workspace

WORKDIR /workspace

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages/audit-rpc-server/node_modules /app/packages/audit-rpc-server/node_modules

# Copy the orchestrator (built locally before docker build)
COPY packages/audit-runner/dist/orchestrator.js /app/orchestrator/index.js

# Copy the bundled RPC bridge server (built locally before docker build)
COPY packages/audit-rpc-server/dist/bundle.js /app/packages/audit-rpc-server/dist/index.js

# Copy the entrypoint
COPY packages/audit-runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
