# Code & Architecture Review — GPT-1

Review date: 2026-05-28

Scope: read-only review of the ModuleWarden repository, with emphasis on the v1 architecture contract in `docs/architecture.md`, the audit runner/RPC path, registry gating, persistence, and CI/build health.

## Executive summary

The current implementation has several blockers before it can enforce the v1 security promise. The largest gaps are in the audit execution path: the audit-runner image is not wired to include/start the RPC bridge, audit containers are not given the package artifact or predecessor evidence they need, internal verdict/evidence writes are unauthenticated by default and not bound to a specific run, and successful container completion can leave review jobs stuck in `RUNNING`. There are also exact-hash/provenance issues around packument filtering and promotion.

## Critical findings

### 1. Audit runner image/entrypoint does not actually run the RPC bridge

**Files:**
- `packages/audit-runner/Dockerfile:39-47`
- `packages/audit-runner/entrypoint.sh:48-52`
- `docker-compose.yml:104-108`

The audit-runner Dockerfile only copies the orchestrator and entrypoint; it does not copy `packages/audit-rpc-server` or start it. The entrypoint comment says two processes run, but the script only launches `node /app/orchestrator/index.js`. The orchestrator therefore cannot reach `http://127.0.0.1:${MW_RPC_PORT}/health` and falls back to local inspection.

There is also a build-context mismatch: Compose builds the audit-runner with `context: packages/audit-runner`, but that Dockerfile uses `COPY packages/audit-runner/dist/orchestrator.js ...`, which is relative to the repository root and will not exist in that context.

**Impact:** the PI/RPC audit harness is not operational. Verdicts are not submitted through the intended RPC bridge, and audits degrade to fallback behavior.

### 2. Audit containers are not given the inputs required by the architecture contract

**Files:**
- `packages/worker/src/handlers/audit.ts:57-66`
- `packages/worker/src/services/container-runner.ts:129-158`

The worker constructs `ContainerInputs` with only `rpcToken`, `rpcPort`, `packageName`, and `packageVersion`. It does not provide the package tarball, predecessor baseline tarball, prepared evidence, diff, instructions, API base URL, or model endpoint configuration.

**Impact:** the core v1 thesis — semantic review of a version diff against the last allowed predecessor — cannot be fulfilled by the container. Even if the bridge started, the audit has little/no package material to inspect.

### 3. Internal RPC endpoints are unauthenticated by default and not run-scoped

**Files:**
- `packages/api-proxy/src/routes/internal.ts:15-19`
- `packages/api-proxy/src/routes/internal.ts:143-157`
- `packages/api-proxy/src/routes/internal.ts:185-208`
- `docker-compose.yml:38-51`

`checkAuth()` returns `true` when `MW_RPC_TOKEN` is unset, and Compose does not set `MW_RPC_TOKEN` for the API service. Evidence and verdict endpoints then select the latest `RUNNING` audit globally rather than validating a run ID/token binding.

**Impact:** a default/misconfigured deployment can forge evidence/verdicts. Concurrent audits can also cross-contaminate: a verdict from one container can complete another package's running audit.

### 4. Successful audit completion can leave reviews stuck in `RUNNING`

**Files:**
- `packages/api-proxy/src/routes/internal.ts:217-225`
- `packages/worker/src/handlers/audit.ts:96-124`

`/internal/verdict` marks the audit run and review job `COMPLETED`, but after the container exits the audit handler unconditionally updates the same review job back to `RUNNING`. If the bridge is unavailable and the container only writes a local `verdict.json`, no decision is created at all.

**Impact:** completed audits may never become effective decisions or promotions; review state can regress after a valid verdict.

### 5. Runtime package exports point at TypeScript source instead of built JavaScript

**Files:**
- `packages/prisma-client/package.json:16-20`
- `packages/shared/package.json:13-23`
- `packages/worker/package.json:5-20`

Workspace package exports point to `src/*.ts`. Running built JS under Node resolves those exports back to TypeScript sources; in local verification, `node packages/api-proxy/dist/index.js` failed while importing `@modulewarden/prisma-client` because source files import `.js` paths that do not exist in `src`.

**Impact:** Docker/runtime startup is likely broken even after TypeScript compilation. Package `main`/`exports` should target `dist/*.js` with `types` targeting `dist/*.d.ts`.

## High findings

### 6. Exact reviewed hash can be bypassed in packument filtering

**Files:**
- `packages/api-proxy/src/services/decisions.ts:47-52`
- `packages/api-proxy/src/services/filter.ts:104-115`

Decisions are keyed by `version::hash`, but `getDecisionsForVersions()` also inserts a fallback key by version. `filterToApproved()` falls back to the version key when an upstream version has a hash that does not match the reviewed hash.

**Impact:** if an upstream tarball is replaced or a hash mismatch occurs, the packument can still present that version as allowed. This conflicts with the architecture's exact-hash approval semantics.

### 7. Promotion fetches from upstream after allow without verifying bytes against the reviewed hash

**Files:**
- `packages/worker/src/handlers/promotion.ts:101-120`
- `packages/shared/src/services/upstream.ts:59-86`

The promotion handler fetches a fresh tarball URL from npm after the decision and passes `tarballHash` to `promoteTarballToVerdaccio()`, but the fetched bytes are not hashed/validated before being published.

**Impact:** TOCTOU/provenance risk. Promotion should publish the exact artifact that was reviewed or verify the fetched stream against the approved integrity before writing to Verdaccio.

### 8. Container execution uses shell string interpolation for Docker and copy commands

**Files:**
- `packages/worker/src/services/container-runner.ts:74-83`
- `packages/worker/src/services/container-runner.ts:120-183`
- `packages/worker/src/services/container-runner.ts:250-264`

Docker network names, image names, paths, labels, env values, and file paths are interpolated into shell strings passed to `execSync`. Quoting is incomplete for embedded quotes/metacharacters.

**Impact:** injection-prone and hard to test. Prefer `spawn`/`execFile` with argv arrays and validate Docker identifiers and paths.

### 9. Admin override auth reads the wrong env var and has a known default token

**Files:**
- `packages/api-proxy/src/routes/admin.ts:27-30`
- `docker-compose.yml:50`
- `packages/shared/src/config.ts:83-87`

Compose/config use `MW_AUTH_ADMIN_TOKENS`, but the admin route reads `MW_ADMIN_TOKENS` and falls back to `mw-admin-token-change-me`.

**Impact:** deployments that think they configured admin tokens may silently accept the hard-coded default override token.

### 10. Admin overrides can violate referential integrity for unseen versions

**Files:**
- `packages/api-proxy/src/routes/admin.ts:87-114`
- `packages/prisma-client/prisma/schema.prisma:282-286`

When no prior decision exists, the override route creates a decision with `reviewJobId: 'admin-override'`, but `Decision.reviewJobId` is a required relation to `ReviewJob`.

**Impact:** overrides for previously unseen package versions are likely to fail at runtime.

## Medium findings

### 11. Predecessor lookup uses lexicographic version ordering

**File:** `packages/api-proxy/src/routes/internal.ts:63-67`

`version: { lt: version }` and `orderBy: { version: 'desc' }` compare strings, not semver.

**Impact:** predecessor diffs can use the wrong baseline, especially around versions such as `1.9.0` vs `1.10.0`.

### 12. Evidence file paths are persisted after deleting the workspace

**Files:**
- `packages/worker/src/handlers/audit.ts:72-88`
- `packages/worker/src/handlers/audit.ts:131-132`

The handler records evidence `filePath` values inside the temp workspace, then deletes that workspace.

**Impact:** evidence records point to files that no longer exist, undermining audit reproducibility.

### 13. CI health is currently red

Commands run:

```text
pnpm -r typecheck
pnpm -r test
```

Results:
- `pnpm -r typecheck` fails in `@modulewarden/web-ui` because `@types/react` and `@types/react-dom` are missing.
- `pnpm -r test` passes shared/audit-rpc/web-ui tests, then fails in `@modulewarden/prisma-client` because the test DB at `postgres:5432` is unavailable.

**Impact:** regressions in the critical audit path may be hidden because the repo does not currently have a clean baseline verification path.

## Recommended remediation order

1. Fix package exports/runtime startup and audit-runner Docker build context.
2. Wire the audit-runner image to include and start the RPC bridge before the orchestrator.
3. Bind RPC tokens to specific `AuditRun` IDs; fail closed when no token is configured.
4. Pass actual tarballs, predecessor artifacts, diffs, evidence, API base URL, and model config into containers.
5. Make verdict handling idempotent and avoid status regression after container completion.
6. Remove version-only approval fallbacks and verify exact hashes during packument filtering and promotion.
7. Replace shell-based Docker invocation with argv-based process execution.
8. Clean up admin auth/override persistence and add tests for unseen-version overrides.
