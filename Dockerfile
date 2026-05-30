# ── ModuleWarden Docker Compose Build ──────────────────────
# Multi-stage build for API/proxy, worker, and web UI.

# ── Stage 1: Install dependencies ──────────────────────────
FROM node:20-alpine AS deps
RUN npm install -g pnpm@9
WORKDIR /app
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml ./
COPY packages/api-proxy/package.json packages/api-proxy/
COPY packages/worker/package.json packages/worker/
COPY packages/web-ui/package.json packages/web-ui/
COPY packages/shared/package.json packages/shared/
COPY packages/prisma-client/package.json packages/prisma-client/
COPY packages/temporal-forecast/package.json packages/temporal-forecast/
RUN pnpm install --frozen-lockfile

# ── Stage 2: API / Proxy ────────────────────────────────────
FROM node:20-alpine AS api-proxy
RUN npm install -g pnpm@9
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages/api-proxy/node_modules /app/packages/api-proxy/node_modules
COPY --from=deps /app/packages/worker/node_modules /app/packages/worker/node_modules
COPY --from=deps /app/packages/shared/node_modules /app/packages/shared/node_modules
COPY --from=deps /app/packages/prisma-client/node_modules /app/packages/prisma-client/node_modules
COPY --from=deps /app/packages/temporal-forecast/node_modules /app/packages/temporal-forecast/node_modules
COPY --from=deps /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/tsconfig.base.json /app/
COPY packages/shared packages/shared
COPY packages/prisma-client packages/prisma-client
COPY packages/temporal-forecast packages/temporal-forecast
COPY packages/worker packages/worker
COPY packages/api-proxy packages/api-proxy
RUN pnpm --filter @modulewarden/prisma-client generate
RUN pnpm --filter @modulewarden/shared build
RUN pnpm --filter @modulewarden/prisma-client build
RUN pnpm --filter @modulewarden/temporal-forecast build
RUN pnpm --filter @modulewarden/worker build
RUN pnpm --filter @modulewarden/api-proxy build
EXPOSE 8080
CMD ["node", "packages/api-proxy/dist/index.js"]

# ── Stage 3: Worker ──────────────────────────────────────────
FROM node:20-alpine AS worker
RUN npm install -g pnpm@9
RUN apk add --no-cache docker-cli openssl git
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages/worker/node_modules /app/packages/worker/node_modules
COPY --from=deps /app/packages/shared/node_modules /app/packages/shared/node_modules
COPY --from=deps /app/packages/prisma-client/node_modules /app/packages/prisma-client/node_modules
COPY --from=deps /app/packages/temporal-forecast/node_modules /app/packages/temporal-forecast/node_modules
COPY --from=deps /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/tsconfig.base.json /app/
COPY packages/shared packages/shared
COPY packages/prisma-client packages/prisma-client
COPY packages/temporal-forecast packages/temporal-forecast
COPY packages/worker packages/worker
RUN pnpm --filter @modulewarden/prisma-client generate
RUN pnpm --filter @modulewarden/shared build
RUN pnpm --filter @modulewarden/prisma-client build
RUN pnpm --filter @modulewarden/temporal-forecast build
RUN pnpm --filter @modulewarden/worker build
EXPOSE 9090
CMD ["node", "packages/worker/dist/index.js"]

# ── Stage 4: Web UI ──────────────────────────────────────────
FROM node:20-alpine AS web-ui
ARG VITE_MW_API_BASE_URL
ENV VITE_MW_API_BASE_URL=${VITE_MW_API_BASE_URL:-}
RUN npm install -g pnpm@9
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages/web-ui/node_modules /app/packages/web-ui/node_modules
COPY --from=deps /app/packages/shared/node_modules /app/packages/shared/node_modules
COPY --from=deps /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/tsconfig.base.json /app/
COPY packages/shared packages/shared
COPY packages/web-ui packages/web-ui
RUN pnpm --filter @modulewarden/shared build
RUN pnpm --filter @modulewarden/web-ui build
EXPOSE 3000
CMD ["pnpm", "--filter", "@modulewarden/web-ui", "exec", "vite", "preview", "--host", "0.0.0.0", "--port", "3000"]
