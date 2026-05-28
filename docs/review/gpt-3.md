# Code & Architecture Re-Audit - GPT-3

Review date: 2026-05-28

Scope: re-audit after `fc5d282 fix(review): address GPT-2 review findings (C-1 through H-5)`. I reviewed the current clean `main` tree, focusing on whether the GPT-2 findings were actually fixed and whether the core registry/audit architecture now works end to end.

## Executive Summary

Some fixes landed, but the system is still not ready to enforce the v1 security contract. Packuments now omit non-allowed versions, and `/internal/*` route prefixing is fixed. However, exact-hash enforcement is still bypassable through the version fallback in decision lookup, the CLI and admin workflow remain miswired, the web UI no longer compiles, and the audit runner still does not start the RPC bridge. Several changes converted visible failures into placeholders rather than working product behavior.

## Critical Findings

### C-1: Exact-hash approval can still be bypassed in packument filtering

Files:
- `packages/api-proxy/src/services/decisions.ts:47`
- `packages/api-proxy/src/services/decisions.ts:50`
- `packages/api-proxy/src/services/filter.ts:105`
- `packages/api-proxy/src/services/filter.ts:111`
- `README.md:56`

`getDecisionsForVersions()` still adds a fallback decision keyed only by version. `filterToApproved()` first checks `version::upstreamHash`, then falls back to `decisions.get(version)`. If upstream serves a changed tarball hash for a previously allowed version, the packument still includes that version as allowed.

I verified this with a direct filter call: a decision for `sha512-old` allowed an upstream packument whose `dist.integrity` was `sha512-new`.

Impact: this violates the exact package-version-hash approval model. The packument path must not use version-only fallbacks for installable metadata.

### C-2: The web UI does not compile or build

Files:
- `packages/web-ui/src/main.tsx:58`
- `packages/web-ui/src/main.tsx:64`

The recent UI change introduced mismatched `try`/`catch` braces in `fetchStatus()`. Both TypeScript and Vite fail:

```text
src/main.tsx(65,5): error TS1472: 'catch' or 'finally' expected.
vite build: Expected "finally" but found "}"
```

Impact: the `web-ui` Docker target cannot build, so `docker compose build` is broken.

### C-3: Audit containers still do not run the RPC bridge

Files:
- `packages/audit-runner/Dockerfile:39`
- `packages/audit-runner/Dockerfile:41`
- `packages/audit-runner/entrypoint.sh:48`
- `packages/audit-runner/entrypoint.sh:52`

The audit runner image still copies only the orchestrator. The entrypoint says it runs two processes, but it never starts `@modulewarden/audit-rpc-server`. The orchestrator therefore falls back to tool-only/file-only behavior.

Impact: PI cannot call the intended tool API, and verdict/evidence persistence through `/internal/*` remains non-operational in real audit containers.

### C-4: Docker builds still depend on untracked generated `dist` output

Files:
- `Dockerfile:23`
- `Dockerfile:24`
- `Dockerfile:27`
- `Dockerfile:39`
- `Dockerfile:40`
- `Dockerfile:42`
- `packages/shared/package.json:13`
- `packages/prisma-client/package.json:16`

`shared` and `prisma-client` now export `dist`, which is directionally correct. But `dist` is not tracked, and the Dockerfile does not build `@modulewarden/shared` or `@modulewarden/prisma-client` before building/running API and worker stages. A clean Docker context without local generated files will not contain the exported modules.

Impact: the previous "exports point to source" bug is only partially fixed. Builds can pass locally when stale `dist` folders happen to exist, but clean container builds remain fragile.

## High Findings

### H-1: The CLI preflight/status/explain workflow is still not wired to API routes

Files:
- `packages/cli/src/index.ts:43`
- `packages/cli/src/index.ts:71`
- `packages/cli/src/index.ts:85`
- `packages/cli/src/index.ts:120`
- `packages/api-proxy/src/routes/admin.ts:41`
- `packages/api-proxy/src/routes/status.ts:21`
- `packages/api-proxy/src/routes/status.ts:61`

The CLI still calls `/admin/import-lockfile`, but no API route registers that endpoint. `modulewarden status` with no package still calls `/status`, but only `/status/:package` exists. `modulewarden explain` still builds `/explain/${name}@${version}` instead of `/explain/:package/:version`, and its split logic still mishandles scoped packages.

Impact: the documented developer workflow in the README remains broken.

### H-2: Admin override auth still reads the wrong env var and accepts a known default

Files:
- `packages/api-proxy/src/routes/admin.ts:27`
- `packages/api-proxy/src/routes/admin.ts:28`
- `packages/shared/src/config.ts:93`
- `docker-compose.yml:50`

The route reads `MW_ADMIN_TOKENS` and falls back to `mw-admin-token-change-me`; config and Compose use `MW_AUTH_ADMIN_TOKENS`.

Impact: deployments can believe they configured admin auth while the override API still accepts the default token.

### H-3: The web UI was "fixed" by disabling data loading

Files:
- `packages/web-ui/src/main.tsx:55`
- `packages/web-ui/src/main.tsx:61`
- `packages/web-ui/src/main.tsx:152`
- `packages/web-ui/src/main.tsx:154`

The UI no longer calls nonexistent `/api/status` and `/api/admin/queue-stats`, but it now fetches `/health` and sets packages to `[]`; queue stats are also hard-coded to `[]`.

Impact: even after the syntax error is fixed, the dashboard will always show empty status/queue data. This is not a functional replacement for the missing API/UI contract.

### H-4: On-demand package review enqueueing is still fragile and can report false success

Files:
- `packages/api-proxy/src/index.ts:23`
- `packages/api-proxy/src/index.ts:31`
- `packages/api-proxy/src/index.ts:38`
- `packages/api-proxy/src/routes/tarball.ts:186`
- `packages/api-proxy/src/routes/tarball.ts:201`

The raw `pgboss.schedule` insert was replaced with `PgBoss.send()`, which is better. But the API proxy does not create the queue, does not use the queue wrapper's retry/singleton/idempotency policy, and catches all send errors as `null`. The tarball route ignores that result and still says a review was enqueued.

Impact: if the worker has not created the queue yet, or enqueueing fails, users receive a false review-enqueued message and no durable work is created.

### H-5: Empty lockfile integrity is still treated as package identity

Files:
- `packages/shared/src/services/lockfile.ts:93`
- `packages/shared/src/services/lockfile.ts:124`
- `packages/shared/src/services/lockfile.ts:164`
- `packages/shared/src/services/lockfile.ts:228`
- `packages/api-proxy/src/services/lockfile-import.ts:68`

The parser no longer fabricates fake hashes, which is an improvement. But it now returns `integrity: ''`, and lockfile import stores that empty string as `PackageVersion.tarballHash`. That still lets the system create review jobs and decisions for a version without a cryptographic artifact identity.

Impact: exact-hash semantics remain weakened. Missing integrity should be resolved to actual bytes before review, or represented as an unresolved/quarantine state that cannot become an `ALLOW` for installable metadata.

## Medium Findings

### M-1: Worker package exports were not updated

Files:
- `packages/worker/package.json:5`
- `packages/worker/package.json:16`

`shared` and `prisma-client` moved to `dist` exports, but `@modulewarden/worker` still advertises `src/index.ts` and `src/jobs/*.ts`. Any package importing `@modulewarden/worker` from built JavaScript will hit the same source/export problem the previous review flagged.

### M-2: Predecessor diff endpoint still returns empty diffs

Files:
- `packages/api-proxy/src/routes/internal.ts:106`
- `packages/api-proxy/src/routes/internal.ts:122`

The semver comparison was improved, including pre-release handling. But even when a predecessor is found, the endpoint returns empty `fileDiff`, `dependencyDiff`, `lifecycleScriptDiff`, and `capabilityDelta`.

Impact: the audit prompt still cannot receive the prepared semantic diff promised by the architecture.

### M-3: Recorded-open egress is still only documented

Files:
- `packages/worker/src/services/container-runner.ts:69`
- `packages/worker/src/services/container-runner.ts:79`
- `packages/worker/src/services/container-runner.ts:168`
- `packages/worker/src/services/container-runner.ts:249`

The runner still creates a plain Docker bridge network and captures output files only. There is no DNS/TCP metadata capture and no explicit host/link-local/internal network blocking in this code.

Impact: network behavior cannot yet be trusted as audit evidence.

## Improved Since GPT-2

- Packument filtering now omits blocked/quarantined/unreviewed versions instead of returning them as deprecated.
- Internal RPC routes are now registered under `/internal`.
- Promotion now hashes fetched tarball bytes before publishing to Verdaccio.
- Admin override creation now creates a sentinel `ReviewJob` instead of using a literal invalid foreign key.
- Lockfile parsing no longer invents synthetic hash strings.

## Verification Notes

Commands run:

```text
pnpm -r typecheck
pnpm --filter @modulewarden/api-proxy test
pnpm --filter @modulewarden/shared test
pnpm --filter @modulewarden/worker typecheck
pnpm --filter @modulewarden/cli typecheck
pnpm --filter @modulewarden/web-ui test
pnpm --filter @modulewarden/web-ui build
pnpm --filter @modulewarden/api-proxy build
pnpm --filter @modulewarden/worker build
node packages/api-proxy/dist/index.js
node packages/worker/dist/index.js
```

Results:
- `pnpm -r typecheck` fails in `@modulewarden/web-ui` due the syntax error in `main.tsx`.
- `pnpm --filter @modulewarden/web-ui build` fails with the same syntax error.
- `pnpm --filter @modulewarden/api-proxy build` passes in this workspace.
- `pnpm --filter @modulewarden/worker build` passes in this workspace.
- `pnpm --filter @modulewarden/worker typecheck` and `pnpm --filter @modulewarden/cli typecheck` pass.
- `@modulewarden/shared` tests pass.
- `@modulewarden/web-ui` tests pass despite the syntax error because they only inspect source strings and do not compile the app.
- `@modulewarden/api-proxy` tests still fail because the test database at `postgres:5432` is unavailable.
- `node packages/api-proxy/dist/index.js` and `node packages/worker/dist/index.js` now reach database startup and fail because `postgres` is unavailable, rather than failing on module resolution in this local generated-output state.

## Recommended Next Steps

1. Remove version-only decision fallbacks from installable packument filtering.
2. Fix `web-ui/src/main.tsx` syntax and add a build/compile assertion to the web UI test path.
3. Wire the audit-runner image to build/copy/start the RPC bridge.
4. Make Docker stages build all workspace runtime dependencies from source before running built JS.
5. Implement the missing CLI/API routes or adjust the CLI to match the API.
6. Fail closed on admin auth unless `MW_AUTH_ADMIN_TOKENS` is configured.
7. Treat missing lockfile integrity as unresolved identity, not an empty hash.
