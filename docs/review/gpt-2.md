# Code & Architecture Review - GPT-2

Review date: 2026-05-28

Scope: current working tree review of the ModuleWarden monorepo, with emphasis on the npm registry gate, audit/RPC path, job orchestration, developer workflows, and conformance to `docs/architecture.md`.

Note: the working tree already contains uncommitted changes in API proxy, worker, shared tests, and `.ralph/`. I treated those as current code and did not revert them.

## Executive Summary

ModuleWarden still does not enforce its core v1 security contract end to end. The most severe issue is in the registry gate: filtered packuments still include blocked/quarantined/unreviewed versions and preserve upstream tarball URLs, so npm clients can bypass ModuleWarden and fetch packages directly from npm. Recent changes also replaced the API proxy's pg-boss client with raw inserts into `pgboss.schedule`, which do not enqueue immediate jobs and are likely to fail silently. The internal RPC route refactor is also incomplete: the audit RPC bridge calls `/internal/*`, while the API proxy now registers those handlers without the `/internal` prefix.

The architecture document is strong, but the implementation is currently closer to a prototype skeleton than an enforceable dependency gate.

## Critical Findings

### C-1: Packument filtering is fail-open; blocked and unreviewed versions remain installable

Files:
- `packages/api-proxy/src/services/filter.ts:24`
- `packages/api-proxy/src/services/filter.ts:27`
- `packages/api-proxy/src/services/filter.ts:30`
- `packages/api-proxy/src/services/filter.ts:36`
- `packages/api-proxy/src/services/filter.ts:41`
- `packages/api-proxy/src/routes/packument.ts:60`
- `packages/shared/src/npm-types.ts:43`
- `README.md:46`
- `docs/architecture.md:133`

`filterToApproved()` copies non-allowed versions into the returned packument and only adds a `deprecated` message. npm treats `deprecated` as a warning, not an install denial. An exact install such as `npm install package@blockedVersion` can still resolve the version metadata and follow its `dist.tarball`.

This directly contradicts the typed contract in `FilteredPackument` ("versions only contains approved package versions") and the architecture promise that blocked versions remain invisible to npm clients.

Impact: the primary gate is bypassable through normal npm behavior. Blocked, quarantined, and unreviewed versions should be omitted from `versions`, or returned only through an npm-compatible failure path that does not include an installable tarball.

### C-2: Allowed packuments preserve upstream tarball URLs, bypassing Verdaccio and exact reviewed artifacts

Files:
- `packages/api-proxy/src/services/filter.ts:27`
- `packages/api-proxy/src/services/filter.ts:43`
- `packages/shared/src/npm-types.ts:13`
- `packages/api-proxy/src/routes/tarball.ts:147`
- `README.md:56`

For allowed versions, the code returns `versionData` unchanged. That object contains the upstream registry's `dist.tarball`. npm clients receiving this packument will download directly from npm instead of `/:package/-/:filename` on ModuleWarden/Verdaccio.

Impact: even approved installs do not necessarily use the promoted tarball or the exact bytes reviewed. The tarball route and promotion path become largely irrelevant unless all tarball URLs are rewritten to ModuleWarden-controlled URLs and the proxy verifies the exact approved integrity.

### C-3: The API proxy no longer enqueues review jobs correctly

Files:
- `packages/api-proxy/src/index.ts:19`
- `packages/api-proxy/src/index.ts:31`
- `packages/api-proxy/src/index.ts:34`
- `packages/api-proxy/src/routes/tarball.ts:186`
- `packages/api-proxy/src/routes/tarball.ts:201`
- `packages/worker/src/jobs/queue.ts:97`

The new `enqueuePackageReviewLight()` bypasses `pg-boss` and writes raw SQL into `pgboss.schedule`. That is the recurring schedule table, not the immediate job queue path used by `JobQueue.send()`. The table also requires fields such as `cron`, and the Prisma call passes the bind values as one array argument rather than as separate parameters.

The function catches all errors and returns `null`, while the tarball route still tells the developer that "A review has been enqueued."

Impact: on-demand tarball requests can fail to create any review job while reporting success. This breaks cold-start/developer-driven review flow and violates the "pg-boss owns durable jobs" architecture boundary.

### C-4: Internal RPC routes are registered at the wrong paths

Files:
- `packages/api-proxy/src/routes/internal.ts:39`
- `packages/api-proxy/src/routes/internal.ts:63`
- `packages/api-proxy/src/routes/internal.ts:126`
- `packages/api-proxy/src/routes/internal.ts:171`
- `packages/api-proxy/src/routes/internal.ts:202`
- `packages/audit-rpc-server/src/index.ts:260`
- `packages/audit-rpc-server/src/index.ts:274`
- `packages/audit-rpc-server/src/index.ts:302`
- `packages/audit-rpc-server/src/index.ts:319`

`registerInternalRoutes()` says routes are scoped to `/internal/*`, but `app.register()` is called without `{ prefix: '/internal' }`. The scoped routes are therefore `/predecessor-diff`, `/web-search`, `/evidence`, and `/verdict`. The in-container RPC bridge still calls `/internal/predecessor-diff`, `/internal/web-search`, `/internal/evidence`, and `/internal/verdict`.

Impact: all proxied audit tools receive 404s from the API proxy, including verdict submission. The audit may write a local `verdict.json`, but the control plane will not persist the decision through the intended RPC path.

### C-5: Built Docker runtime cannot start because workspace packages export TypeScript source

Files:
- `packages/shared/package.json:13`
- `packages/prisma-client/package.json:16`
- `packages/prisma-client/package.json:18`
- `packages/worker/package.json:5`
- `packages/worker/package.json:16`
- `Dockerfile:30`
- `Dockerfile:44`

Workspace package exports point at `src/*.ts`, while Docker runs built JavaScript with plain `node packages/*/dist/index.js`. I verified this with:

```text
node packages/api-proxy/dist/index.js
```

It failed before connecting to the database:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module .../packages/prisma-client/src/repositories/projects.js imported from .../packages/prisma-client/src/index.ts
```

Impact: the built API and worker containers are not runnable as packaged. Package `main`/`exports` should point to `dist/*.js`, with `types` pointing to `dist/*.d.ts`.

## High Findings

### H-1: The documented CLI preflight/status/explain workflow does not match API routes

Files:
- `packages/cli/src/index.ts:43`
- `packages/cli/src/index.ts:71`
- `packages/cli/src/index.ts:85`
- `packages/cli/src/index.ts:120`
- `packages/api-proxy/src/routes/admin.ts:41`
- `packages/api-proxy/src/routes/status.ts:21`
- `packages/api-proxy/src/routes/status.ts:61`

The CLI calls `/admin/import-lockfile`, but no route registers that endpoint. `modulewarden status` with no package calls `/status`, but the API only registers `/status/:package`. `modulewarden explain <pkg>@<ver>` calls `/explain/${name}@${version}`, while the API route is `/explain/:package/:version`. The split logic also mishandles scoped packages like `@scope/pkg@1.2.3`.

Impact: the README's first developer workflow cannot work through the CLI. Lockfile import may exist as a service, but it is not exposed through the HTTP API used by the CLI.

### H-2: Missing lockfile integrity is converted into fake hashes

Files:
- `packages/shared/src/services/lockfile.ts:93`
- `packages/shared/src/services/lockfile.ts:166`
- `packages/shared/src/services/lockfile.ts:230`
- `README.md:56`

When npm, pnpm, or yarn lock entries lack integrity, the parser fabricates strings such as `sha1-${packageName}-${version}` or a base64-derived `sha512-*`. Exact hash approval is a central security invariant, so a synthetic value is dangerous: it can be reviewed, stored, and displayed as if it identifies real package bytes.

Impact: ModuleWarden can create decisions for artifacts it has not cryptographically identified. Missing integrity should become an unresolved state that triggers upstream resolution and byte hashing, or quarantine if it cannot be resolved.

### H-3: The audit runner still lacks the RPC bridge process

Files:
- `packages/audit-runner/Dockerfile:39`
- `packages/audit-runner/entrypoint.sh:48`
- `packages/audit-runner/src/orchestrator.ts:141`
- `packages/audit-rpc-server/src/index.ts:385`

The audit runner image copies only the orchestrator and entrypoint. The entrypoint comment says the RPC bridge runs in the background, but it never starts `@modulewarden/audit-rpc-server`. The orchestrator waits for the bridge and then drops into tool-only/file-only fallback.

Impact: PI cannot use the intended tool API, and verdict persistence depends on fallback files rather than the RPC bridge. This remains a blocker even after the API route prefix is fixed.

### H-4: Recorded-open egress is documented but not implemented

Files:
- `docs/architecture.md:276`
- `docs/architecture.md:280`
- `docs/architecture.md:287`
- `packages/worker/src/services/container-runner.ts:69`
- `packages/worker/src/services/container-runner.ts:79`
- `packages/worker/src/services/container-runner.ts:168`
- `packages/worker/src/services/container-runner.ts:253`

`ContainerRunner.ensureNetwork()` creates a plain Docker bridge network. There is no DNS/TCP capture, no egress artifact creation, and no explicit block for Docker host/link-local/internal ranges. The worker later captures files from `/workspace/output`, but no network trace is produced by the runner.

Impact: the implementation does not satisfy the recorded-open egress model. Network behavior cannot be used as evidence, and malicious package code may still reach destinations the architecture says should be blocked unless Docker/network policy is added outside this code.

### H-5: The web UI is wired to endpoints that do not exist in the served deployment

Files:
- `packages/web-ui/src/main.tsx:4`
- `packages/web-ui/src/main.tsx:55`
- `packages/web-ui/src/main.tsx:147`
- `Dockerfile:56`
- `packages/api-proxy/src/routes/status.ts:21`

The UI fetches `/api/status` and `/api/admin/queue-stats`. The API proxy exposes no `/api` prefix, no root `/status` collection endpoint, and no `/admin/queue-stats` route. The Docker image serves the Vite preview directly and does not configure a proxy from `/api` to `api-proxy`.

Impact: the UI can build and its tests can pass while the runtime dashboard remains empty/nonfunctional.

## Medium Findings

### M-1: Predecessor selection can choose the wrong baseline

Files:
- `packages/worker/src/handlers/subscriptions.ts:47`
- `packages/worker/src/handlers/subscriptions.ts:52`
- `packages/worker/src/handlers/subscriptions.ts:67`
- `packages/api-proxy/src/routes/internal.ts:79`
- `packages/api-proxy/src/routes/internal.ts:115`

Subscription polling chooses the first allowed candidate ordered by `createdAt`, not by semver, publish time, or dependency graph lineage. The internal predecessor endpoint uses manual numeric splitting and still returns empty diff structures even when it finds a predecessor.

Impact: the core "version diff against the last-known-good predecessor" thesis can silently review the wrong baseline or no real diff at all.

### M-2: Admin override authentication remains inconsistent and defaults to a known token

Files:
- `packages/api-proxy/src/routes/admin.ts:27`
- `docker-compose.yml:50`
- `packages/shared/src/config.ts:91`

The admin route reads `MW_ADMIN_TOKENS` and falls back to `mw-admin-token-change-me`, while Compose/config use `MW_AUTH_ADMIN_TOKENS`. Deployments can believe they configured admin tokens while the route still accepts the default.

Impact: security-admin override is one of the highest privilege operations in the system; it should fail closed unless the configured auth variable is present.

### M-3: The admin override path can create invalid decisions for unseen versions

Files:
- `packages/api-proxy/src/routes/admin.ts:87`
- `packages/api-proxy/src/routes/admin.ts:106`
- `packages/prisma-client/prisma/schema.prisma:305`
- `packages/prisma-client/prisma/schema.prisma:307`

If no prior decision exists, the admin route creates a `Decision` with `reviewJobId: 'admin-override'`. The schema requires `Decision.reviewJobId` to reference a real `ReviewJob`.

Impact: overrides for previously unseen versions fail at runtime, or require out-of-band data setup. Either create a real admin review job or model admin decisions without a required review job relation.

### M-4: Promotion still fetches fresh upstream bytes after approval

Files:
- `packages/worker/src/handlers/promotion.ts:101`
- `packages/shared/src/services/upstream.ts:67`
- `packages/shared/src/services/upstream.ts:78`

Promotion builds a tarball URL, re-fetches from npm, and streams to Verdaccio without hashing the fetched bytes against `tarballHash`. This issue is partly masked by C-2 because clients currently bypass Verdaccio, but it still violates exact-artifact promotion semantics.

Impact: a time-of-check/time-of-use mismatch can promote bytes different from those reviewed.

## Verification Notes

Commands run:

```text
pnpm -r typecheck
pnpm --filter @modulewarden/api-proxy typecheck
pnpm --filter @modulewarden/worker typecheck
pnpm --filter @modulewarden/audit-rpc-server typecheck
pnpm --filter @modulewarden/shared test
pnpm --filter @modulewarden/api-proxy test
pnpm --filter @modulewarden/audit-rpc-server test
pnpm --filter @modulewarden/web-ui test
node packages/api-proxy/dist/index.js
```

Results:
- `pnpm -r typecheck` fails in `@modulewarden/web-ui` because `@types/react` and `@types/react-dom` are missing.
- Targeted typechecks pass for `@modulewarden/api-proxy`, `@modulewarden/worker`, and `@modulewarden/audit-rpc-server`.
- `@modulewarden/shared`, `@modulewarden/audit-rpc-server`, and `@modulewarden/web-ui` tests pass.
- `@modulewarden/api-proxy` tests fail because the test database at `postgres:5432` is unavailable.
- `node packages/api-proxy/dist/index.js` fails with `ERR_MODULE_NOT_FOUND` due package exports resolving to TypeScript source.

## Recommended Remediation Order

1. Make packument filtering truly approved-only and rewrite every allowed tarball URL to ModuleWarden-controlled URLs.
2. Restore pg-boss API usage for enqueueing; split a lightweight producer from worker registration instead of writing pg-boss internals.
3. Fix internal RPC route prefixing and add integration tests that exercise the audit RPC bridge against the API proxy.
4. Fix workspace package `exports`/`main` to run built JavaScript in Docker.
5. Expose and test the CLI/API workflow for lockfile import, status, and explain.
6. Start the RPC bridge in the audit-runner image and persist fallback verdicts explicitly if fallback remains.
7. Implement real recorded-open egress capture/blocking before relying on network behavior as evidence.
8. Stop fabricating lockfile integrity values; resolve or quarantine unknown artifact identity.
