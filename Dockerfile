# ── ModuleWarden Docker Compose Build ──────────────────────
# Multi-stage build for API/proxy, worker, and web UI.

# ── Stage 1: Install dependencies ──────────────────────────
FROM node:20-alpine AS deps
RUN npm install -g pnpm@9
WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml ./
COPY packages/api-proxy/package.json packages/api-proxy/
COPY packages/worker/package.json packages/worker/
COPY packages/web-ui/package.json packages/web-ui/
COPY packages/shared/package.json packages/shared/
COPY packages/prisma-client/package.json packages/prisma-client/
RUN pnpm install --frozen-lockfile

# ── Stage 2: API / Proxy ────────────────────────────────────
FROM node:20-alpine AS api-proxy
RUN npm install -g pnpm@9
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY packages/shared packages/shared
COPY packages/prisma-client packages/prisma-client
COPY packages/api-proxy packages/api-proxy
RUN pnpm --filter @modulewarden/api-proxy build
EXPOSE 8080
CMD ["node", "packages/api-proxy/dist/index.js"]

# ── Stage 3: Worker ──────────────────────────────────────────
FROM node:20-alpine AS worker
RUN npm install -g pnpm@9
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY packages/shared packages/shared
COPY packages/prisma-client packages/prisma-client
COPY packages/worker packages/worker
RUN pnpm --filter @modulewarden/worker build
EXPOSE 9090
CMD ["node", "packages/worker/dist/index.js"]

# ── Stage 4: Web UI ──────────────────────────────────────────
FROM node:20-alpine AS web-ui
RUN npm install -g pnpm@9
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY packages/shared packages/shared
COPY packages/web-ui packages/web-ui
RUN pnpm --filter @modulewarden/web-ui build
EXPOSE 3000
CMD ["pnpm", "--filter", "@modulewarden/web-ui", "exec", "vite", "preview", "--host", "0.0.0.0", "--port", "3000"]
