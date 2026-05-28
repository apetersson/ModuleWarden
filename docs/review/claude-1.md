# Code & Architecture Review — Claude-1

Review date: 2026-05-28
Reviewer: Claude Sonnet 4.6
Scope: Full read of all TypeScript source packages, Dockerfiles, Compose configuration, Prisma schema, and the architecture contract in `docs/architecture.md`.

---

## Executive Summary

ModuleWarden has a well-thought-out architecture contract and a clean monorepo structure. The Prisma schema is comprehensive, the job-type definitions are well-typed, and the core gateway semantics (filter → verdict → promote) are correctly conceived. However, several fundamental wiring issues prevent the system from working end-to-end in its current state. The most serious are: a global Fastify auth hook that would block all API routes when a token is configured, a static-env-var approach to "run-scoped" RPC tokens that makes the per-run isolation model structurally impossible, raw token storage in the database, and the api-proxy running a full pg-boss worker in-process alongside the HTTP server.

The GPT-1 review (`docs/review/gpt-1.md`) already catalogued build-context issues, the missing RPC bridge in the audit-runner image, and the admin auth env var mismatch. This review focuses on different findings not covered there.

---

## Critical Findings

### C-1: Internal RPC auth hook is applied globally, not scoped to internal routes

**Files:** `packages/api-proxy/src/routes/internal.ts:30-35`, `packages/api-proxy/src/index.ts:56-57`

`registerInternalRoutes` calls `app.addHook('onRequest', ...)` on the root Fastify instance, not inside a scoped plugin. In Fastify, hooks registered on the root instance apply to every route registered on that instance — including `/:package` (packument), `/:package/-/:filename` (tarball), `/admin/*`, `/status/*`, and `/health`.

The hook rejects any request where `checkAuth()` returns `false`. `checkAuth` fails closed when `MW_RPC_TOKEN` is empty, and the Compose file does not set `MW_RPC_TOKEN` on the api-proxy service. Result in a default deployment: every route on the api-proxy returns 401, including developer `npm install` requests and health checks.

If `MW_RPC_TOKEN` is set, only callers providing that exact token can reach any endpoint — breaking all developer and admin access.

**Fix:** Register internal routes inside a scoped Fastify plugin (`app.register(...)`) so the auth hook is isolated to `/internal/*` paths, or add a path guard in the hook body.

---

### C-2: Run-scoped RPC tokens cannot work with a static env var

**Files:** `packages/worker/src/handlers/audit.ts:54-55`, `packages/api-proxy/src/routes/internal.ts:16`, `packages/audit-rpc-server/src/index.ts:37,40`

The architecture requires "a run-scoped RPC token (short-lived, single-run scope)" (architecture §10). The worker does generate a fresh random token per run (`randomBytes(32).toString('hex')`), injects it into the container via `MW_RPC_TOKEN`, and the in-container RPC bridge uses it to authenticate inbound tool calls.

However, when the in-container bridge proxies calls to the main api-proxy at `/internal/*` (e.g., `handleProxyDiff`, `handleSubmitVerdict`), it sends the run-scoped token as `Authorization: Bearer <run-token>`. The api-proxy validates this against `process.env.MW_RPC_TOKEN` loaded once at startup — a single static value. Since each run generates a unique token, the static api-proxy token can never match the per-run token injected into the container.

The consequence is that all proxied RPC tool calls (`predecessor-diff`, `web-search`, `write-evidence`, `submit-verdict`) will receive 401 from the api-proxy in any deployment where `MW_RPC_TOKEN` is set. The verdict submission path from the container to the database is broken by design.

**Fix:** The api-proxy's `/internal/*` routes need to validate against per-run tokens stored in the `AuditRun` table (matched by a run ID passed in a separate header or path), not against a static env var. The token from the container should be looked up against `AuditRun.rpcTokenHash` for the specific run.

---

### C-3: Raw RPC token stored in the `rpcTokenHash` database column

**File:** `packages/worker/src/handlers/audit.ts:55-56`

```typescript
const rpcToken = randomBytes(32).toString('hex');
const rpcTokenHash = rpcToken; // In production, hash this
```

`rpcTokenHash` is stored verbatim in `AuditRun.rpcTokenHash`. The column name implies a hash; storing the raw token means anyone with read access to the database can retrieve tokens for any running or recent audit. Given that the architecture explicitly aims to limit credential exposure, the token should be stored as `sha256(rpcToken)` and the incoming token hashed before comparison.

---

### C-4: api-proxy runs a full pg-boss worker in-process

**Files:** `packages/api-proxy/src/index.ts:9,17-26`

The api-proxy imports `JobQueue` from `@modulewarden/worker` and starts it at server boot:

```typescript
import { JobQueue } from '@modulewarden/worker';
// ...
const queue = new JobQueue({ ... });
await queue.start();
```

This means the api-proxy container is simultaneously an HTTP gateway and a pg-boss worker. Combined with the dedicated `worker` Compose service, there are two pg-boss consumers competing for every job queue. pg-boss uses row-level locking so jobs won't be processed twice, but:

1. The api-proxy's in-process worker will register handlers (through `queue.start()`) even though no handlers are explicitly registered on the api-proxy's queue instance. Without handlers, the queue polls uselessly and holds DB connections.
2. If the api-proxy's queue instance does pick up a job intended for the worker service (which it can if it were to register handlers), it would run inside the HTTP server process without access to Docker, breaking container launch.
3. Both processes run pg-boss schema migrations on startup, introducing a migration race at cold start.

The api-proxy should not start a `JobQueue`; it should only enqueue jobs via a lightweight client or direct pg-boss `send` call. Alternatively, the worker package's queue client should be split from its handler-registration logic.

---

## High Findings

### H-1: Scoped package tarball URL is malformed during promotion

**File:** `packages/worker/src/handlers/promotion.ts:102`

```typescript
const tarballUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${encodeURIComponent(packageName)}-${packageVersion}.tgz`;
```

For a scoped package such as `@babel/core`, this generates:

```
https://registry.npmjs.org/%40babel%2Fcore/-/%40babel%2Fcore-7.21.0.tgz
```

The npm registry expects the scoped name encoded differently for tarballs. The correct URL is:

```
https://registry.npmjs.org/@babel/core/-/core-7.21.0.tgz
```

The tarball filename uses only the unscoped package name (`core-7.21.0.tgz`), not the full scoped name. For the scope itself in the path, npm accepts the `@scope/name` literally (not percent-encoded). Promotion will fail for every scoped package.

**Similarly** in `upstream.ts:promoteTarballToVerdaccio`, the Verdaccio PUT URL has the same issue at line 76.

---

### H-2: No integrity verification before promoting to Verdaccio

**File:** `packages/worker/src/handlers/promotion.ts:101-121`, `packages/shared/src/services/upstream.ts:59-95`

The promotion handler re-fetches the tarball from npm after an ALLOW decision is recorded. The fetched bytes are streamed directly into Verdaccio without computing and comparing the stream's hash against the approved `tarballHash`. This is a TOCTOU window: npm could serve a different tarball (e.g., if the package was subsequently yanked and re-published) and it would be silently promoted as if it were the reviewed artifact.

The architecture contract (§5, exact hash approval; §13, data flow) requires that promoted artifacts match the exact bytes audited.

---

### H-3: Evidence and verdict routes find the active run by global status, not by token binding

**File:** `packages/api-proxy/src/routes/internal.ts:174-177, 216-220`

Both `/internal/evidence` and `/internal/verdict` select the audit run by:

```typescript
await prisma.auditRun.findFirst({
  where: { status: 'RUNNING' },
  orderBy: { createdAt: 'desc' },
});
```

There is no validation that the request token corresponds to this specific run. If two audits run concurrently, the most-recently-started run will be selected. A container auditing package A can submit a verdict that is recorded against the concurrently-running audit for package B.

The fix is to look up `AuditRun` by the hashed RPC token (once C-2 and C-3 are addressed), ensuring each token is bound to exactly one run.

---

### H-4: `registerInternalRoutes` hook also blocks `/health`

**File:** `packages/api-proxy/src/index.ts:61-63`, `packages/api-proxy/src/routes/internal.ts:30-35`

The `/health` route is registered on the root app instance after all route groups. Because the global RPC auth hook from `registerInternalRoutes` fires on all routes, health checks from Docker, load balancers, or Compose's `healthcheck` stanza will also receive 401 unless the caller provides the RPC token. This will prevent the Compose `depends_on` health gate from passing and may prevent the worker from starting.

---

### H-5: No request body validation on internal endpoints

**File:** `packages/api-proxy/src/routes/internal.ts:167-276`

None of the internal endpoints (`/internal/evidence`, `/internal/verdict`, `/internal/web-search`) validate their request bodies. Accessing `.body.type`, `.body.verdict`, `.body.scores` etc. on a malformed or missing body will throw unhandled errors inside the route handler, causing Fastify to return a 500. Given these endpoints handle security-critical state mutations (writing evidence, recording verdicts), explicit schema validation is warranted.

---

### H-6: Synchronous polling loop blocks the Node.js event loop

**File:** `packages/worker/src/services/container-runner.ts:207-233`

The container completion polling loop calls `execSync(docker inspect ...)` synchronously inside an `async` function, then `await`s a `setTimeout` to yield. `execSync` is blocking — it holds the entire Node.js event loop while Docker responds. With `audit-container-exec` concurrency set to 2, two simultaneous audits will each block the event loop on every 500 ms poll tick. The existing `execAsync` import (`promisify(execCb)`) at line 7 should be used instead.

---

## Medium Findings

### M-1: Predecessor lookup doesn't handle pre-release semver

**File:** `packages/api-proxy/src/routes/internal.ts:73-96`

The predecessor-finding logic in `/internal/predecessor-diff` uses a manual numeric-parts comparison (split on `.`, compare element-wise). It correctly handles numeric versions but:

- Skips any version with a NaN part (line 77: `if (vParts.some(isNaN)) return false`). Pre-release versions like `1.0.0-rc.1` parse as `[1, 0, NaN]` and are silently excluded from the predecessor set.
- Does not distinguish pre-release from release (`1.0.0-rc.1 < 1.0.0` by semver spec).

For packages that use release candidates or pre-release tags in their normal version flow, the predecessor diff will silently skip those versions, potentially picking an older baseline than intended.

---

### M-2: `capability-extract.ts` uses a dynamic `require` inside a module-scope function

**File:** `packages/shared/src/services/capability-extract.ts:157-167`

```typescript
function findSourceFiles(dir: string): string[] {
  const { execSync } = require('node:child_process');
  // ...
}
```

This uses CommonJS `require()` inside an ES module (the workspace uses `"type": "module"` conventions with `.ts` sources compiled to ESM). This will throw a `ReferenceError: require is not defined` at runtime under native ESM. The import should be at the top of the file.

---

### M-3: `audit.ts` workspace cleanup races with evidence artifact recording

**File:** `packages/worker/src/handlers/audit.ts:148-213`

The handler records evidence artifact `filePath` values pointing to files inside the temp workspace (e.g., `/tmp/mw-audit-XXXX/evidence/result.json`). After recording artifacts, it calls `runner.cleanupWorkspace(result.workspacePath)` which does `rmSync(workspacePath, { recursive: true, force: true })`. The recorded `filePath` in `EvidenceArtifact` now points to a deleted file.

The file content is partially captured (first 10,000 bytes in the `content` JSON column), but `filePath` is stored as if the file still exists, creating misleading records. Any code or operator that tries to access those paths will find nothing.

---

### M-4: `admin.ts` creates decisions with a literal string as a foreign key

**File:** `packages/api-proxy/src/routes/admin.ts:106-114`

When no prior decision exists for a package version, the admin override route creates:

```typescript
await prisma.decision.create({
  data: {
    reviewJobId: latestDecision?.reviewJobId ?? 'admin-override',
    // ...
  },
});
```

`Decision.reviewJobId` is a non-nullable foreign key to `ReviewJob.id`. The string `'admin-override'` is not a valid UUID and does not correspond to any `ReviewJob` record. Prisma will throw a foreign key constraint violation at runtime for any admin override on a package that has never been reviewed.

The schema should either make `reviewJobId` nullable for admin-created decisions or create a sentinel `ReviewJob` for admin actors.

---

### M-5: Semver sort in `filter.ts` handles only three version parts

**File:** `packages/api-proxy/src/services/filter.ts:125-133`

`semverSortDesc` iterates exactly `i < 3` components. Versions with pre-release labels (e.g., `1.0.0-alpha.1`) are compared without the pre-release segment, causing potentially incorrect dist-tag rewrites when allowed and pre-release versions coexist. Consider using a proper semver library or the more robust compare logic already present in `internal.ts`.

---

### M-6: No caching or rate-limiting on upstream npm registry calls

**File:** `packages/shared/src/services/upstream.ts:9-27`, `packages/api-proxy/src/routes/packument.ts:40`

Every packument request triggers a fresh call to `registry.npmjs.org`. Under normal developer load (`npm install` on a project with 500 dependencies), this becomes 500 sequential or parallel upstream calls per install run. There is no caching layer (even a short TTL in-memory cache), no timeout configured on the `fetch` call, and no circuit breaker. A slow npm registry response will hang the Fastify request handler indefinitely.

---

### M-7: `audit-rpc-server` `checkToken` is fail-open when unprotected

**File:** `packages/audit-rpc-server/src/index.ts:52-55`

```typescript
function checkToken(token: string | undefined): boolean {
  if (!RPC_TOKEN) return true;   // open when unconfigured
  return token === RPC_TOKEN;
}
```

Contrast with the api-proxy's `checkAuth` which fails closed (`return false`). The RPC bridge inside the container accepts all tool calls when no token is configured. While the container is isolated, this means local processes inside the container (or any process reachable via the container network) can call tools that write evidence, execute sandboxed commands, and submit verdicts without any auth. For a threat model that includes auditing potentially malicious package code, this is a meaningful gap.

---

## Low Findings

### L-1: Default credentials committed to Compose

**File:** `docker-compose.yml:8,50,78`

`POSTGRES_PASSWORD: modulewarden`, `MW_AUTH_ADMIN_TOKENS: mw-admin-token-change-me`, and `MW_MODEL_ENDPOINT_API_KEY: sk-change-me` are literal defaults in the committed Compose file rather than using `${VAR:-default}` substitution. This makes the "change me" instruction easy to overlook and means `git log` exposes the historical default values.

---

### L-2: `verdaccio` image pinned to `latest`

**File:** `docker-compose.yml:21`

`image: verdaccio/verdaccio:latest` will pull a different image over time, making builds non-reproducible. Pin to a specific version (e.g., `verdaccio/verdaccio:5.30.3`).

---

### L-3: Worker container exposes port 9090 with no documented consumer

**File:** `docker-compose.yml:63-64`

The worker service exposes port 9090 (the RPC port) to the host. According to the architecture, the RPC port is internal — only the audit containers inside the Compose network should reach it. Exposing it to the host unnecessarily expands the attack surface. Remove the `ports` entry or replace with `expose`.

---

### L-4: `handleSandboxExecute` uses unsanitized `moduleName` in shell command

**File:** `packages/audit-rpc-server/src/index.ts:239`

```typescript
stdout = execSync(`node -e "try { const m = require('${params.moduleName.replace(/'/g, "\\'")}'); ... }`);
```

Replacing only `'` is insufficient to prevent command injection via backtick, `$()`, `\`, or other metacharacters. Because this runs inside the isolated audit container, the blast radius is limited — but the intent is to audit potentially malicious packages that may craft input to escape this command. Use `execFile` with argv or validate `moduleName` strictly against a package-name pattern before interpolation.

---

### L-5: `prisma-client` package exports point to `src/*.ts`, not `dist/*.js`

**File:** `packages/prisma-client/package.json` (exports field)

Runtime Node.js processes resolve package imports to the `exports` field. If exports map to `.ts` source files rather than compiled `.js` output, startup under Node (including in Docker) fails with `ERR_UNKNOWN_FILE_EXTENSION` or import resolution errors. This was flagged in GPT-1 (finding #5) and is confirmed: all packages must have `exports` pointing at `dist/` files, with `types` pointing at `dist/*.d.ts`.

---

## Architecture Observations

### A-1: Verdict state machine lacks a terminal COMPLETED transition from the api-proxy path

The `ReviewJob.status` lifecycle has a gap. When `/internal/verdict` is called from the container:
1. `AuditRun.status` → COMPLETED
2. `ReviewJob.status` → COMPLETED

But then `audit.ts` (the worker handler) unconditionally runs after `runner.run()` returns:
```typescript
await prisma.reviewJob.update({ data: { status: 'RUNNING' } }); // line ~204
```
This regresses a COMPLETED job back to RUNNING. The architecture should define a clear ownership rule: either the container's verdict call completes the job, or the worker does, not both. A status check before the unconditional update would prevent regression.

---

### A-2: `audit-container-exec` and `package-review` are separate jobs but always chained 1:1

In `reviews.ts`, every `package-review` job immediately enqueues an `audit-container-exec` job and does nothing else. These two job types could be collapsed into one, which would simplify the queue configuration, reduce DB round-trips, and eliminate the intermediate review-job status update. If the two-stage design is intentional (e.g., to allow lightweight pre-screening before container launch), that rationale should be documented.

---

### A-3: No network egress blocking for the audit container is enforced by the runner

**File:** `packages/worker/src/services/container-runner.ts:73-83, 168-180`

The architecture (§9) specifies "recorded-open egress: public internet only, with blocked destinations including host machine, internal Docker networks, and link-local metadata services." The container runner creates a bridge network (`mw-audit-net`) and assigns containers to it. A bridge network does provide NAT to the public internet, but it does not automatically block:

- Other containers on the same `mw-audit-net` network (if any are connected).
- The Docker host's IP (`172.17.0.1` or similar) unless iptables rules are added.
- Cloud metadata endpoints (e.g., `169.254.169.254`).

The current `docker create` command does not add `--add-host` exclusions, iptables drop rules, or custom DNS resolvers to enforce the recorded-open policy. The architecture promise is documented but not implemented. Consider using a dedicated network policy (e.g., iptables rules on the bridge, or a custom CNI plugin) and verifying with a test that the metadata endpoint is unreachable from inside the container.

---

### A-4: `UpstreamMetadataSnapshot` is populated but never queried

**File:** `packages/prisma-client/prisma/schema.prisma:65-77`, `packages/worker/src/handlers/subscriptions.ts`

The schema defines `UpstreamMetadataSnapshot` for storing periodic npm metadata snapshots. Reading the subscription poll handler shows snapshots are created, but nothing downstream reads them to detect new upstream versions or trigger review jobs. Without a consumer, subscription monitoring doesn't actually gate new versions — the subscription poll is data collection with no enforcement action.

---

## Positive Notes

- The Prisma schema is thorough and correctly models the decision supersession chain, override scopes, evidence artifact lineage, and evaluation labels. This is non-trivial to get right and the schema reflects clear design thinking.
- The `JobQueue` wrapper provides typed, idempotent job submission with deterministic `singletonKey` values, preventing duplicate audit jobs for the same package version. This is the right approach.
- The `filterToApproved` function correctly degrades gracefully — BLOCKED and QUARANTINED versions are presented as deprecated rather than missing, giving developers actionable error messages instead of cryptic `404`s.
- The architecture document itself is well-written, with explicit non-goals, trust boundaries, and a clear threat classification. Having this as a ratified contract makes it easier to evaluate implementation fidelity.
- The `ContainerRunner` enforces `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `--read-only` on audit containers. These are the right defaults for untrusted workloads.

---

## Recommended Remediation Order

1. **(C-1)** Scope the RPC auth hook to `/internal/*` only using a Fastify plugin.
2. **(C-2)** Replace static `MW_RPC_TOKEN` env var comparison with per-run token lookup against `AuditRun.rpcTokenHash`.
3. **(C-3)** Hash the RPC token before storing it in `AuditRun.rpcTokenHash`.
4. **(C-4)** Remove the in-process `JobQueue` from api-proxy; submit jobs via a thin client.
5. **(H-1)** Fix scoped package tarball URL construction in `promotion.ts` and `upstream.ts`.
6. **(H-2)** Verify tarball integrity against the approved hash before Verdaccio promotion.
7. **(H-3)** Bind `/internal/verdict` and `/internal/evidence` to the specific `AuditRun` identified by the hashed token.
8. **(H-6)** Replace `execSync` polling loop with `execAsync`.
9. **(M-4)** Make `Decision.reviewJobId` nullable for admin-actor decisions.
10. **(A-1)** Add a guard in `audit.ts` to prevent status regression after `/internal/verdict` has already completed the job.
11. **(A-3)** Implement and test the network egress policy for audit containers.
