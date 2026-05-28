---
id: TASK-30
title: 'Epic: Security and code quality audit remediation'
status: To Do
assignee: []
created_date: '2026-05-28'
updated_date: '2026-05-28'
labels:
  - epic
  - security
  - quality
  - hardening
dependencies:
  - TASK-29
priority: high
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Comprehensive audit of ~17,000 lines across `packages/` (audit-runner, web-ui, prisma-client, shared, cli, audit-rpc-server, api-proxy, worker) identified **34 findings** across 5 categories. Track and remediate all findings before production deployment.

The audit report is at `docs/audit-report-2026-05-28.md` (generated independently from this task).

Three findings were already fixed as part of TASK-29 / subsequent commits:
- SEC-01 (partial): Hardcoded default admin/dev tokens removed via `readRequiredList()`
- SEC-04: Hardcoded Verdaccio promotion token removed
- BUG-05: `supersedeEvidenceArtifact` status assignment fixed (old → SUPERSEDED, new → ACTIVE)

**31 findings remain open** across 5 categories.

<!-- SECTION:DESCRIPTION:END -->

## Security Issues (8 remaining)

### SEC-01 (remaining) — `readList` fallback removed but auth token validation gap
- **What:** `readRequiredList()` validates tokens are present at startup, but doesn't validate format (no min-length, no character constraints).
- **Files:** `packages/shared/src/config.ts`
- **Priority:** High

### SEC-02 — RPC token reused as API authorization token
- **What:** Audit RPC bridge uses same `MW_RPC_TOKEN` for PI authentication AND outbound API calls. Violates distinct-token-scope principle.
- **Files:** `packages/audit-rpc-server/src/index.ts`
- **Priority:** High

### SEC-03 — SQL injection surface via `$queryRawUnsafe` in dashboard
- **What:** Dashboard uses `$queryRawUnsafe` with static queries (currently safe), but pattern normalizes unsafe raw queries. `queue-stats` uses parameterized `$1` but is inconsistent.
- **Files:** `packages/api-proxy/src/routes/dashboard.ts`
- **Priority:** High
- **Fix:** Replace with Prisma type-safe query builders (`prisma.reviewJob.findMany(...)`) for all dashboard queries. Use only `$queryRaw` (parameterized) if raw SQL is needed.

### SEC-05 — Weak tarball integrity with `unresolved:` prefix fallback
- **What:** When integrity hash can't be resolved, code falls back to `unresolved:package@version` — a synthetic hash providing zero integrity verification.
- **Files:** `packages/api-proxy/src/routes/tarball.ts`, `packages/worker/src/handlers/reviews.ts`
- **Priority:** Medium
- **Fix:** Reject tarball if hash cannot be resolved from upstream registry. Fail closed.

### SEC-06 — Static analysis regexes trivially evaded
- **What:** Two independent regex-based static analysis implementations (`capability-extract.ts` and `audit-rpc-server/src/index.ts`) that are trivially evaded via string concatenation, template literals, dynamic require.
- **Files:** `packages/shared/src/services/capability-extract.ts`, `packages/audit-rpc-server/src/index.ts`
- **Priority:** Medium
- **Fix:** Consolidate to single AST-aware implementation (acorn/babel). Detect `require.resolve`, `import()`, indirect access, string obfuscation.

### SEC-07 — `hasLifecycleScript` computed from all scripts, not just install hooks
- **What:** `hasLifecycleScript` flag is set for ANY scripts (including `test`, `lint`), not just install-phase hooks (`preinstall`, `install`, `postinstall`, `prepare`). Over-flags and trains reviewers to ignore it.
- **Files:** `packages/api-proxy/src/routes/tarball.ts`
- **Priority:** Low
- **Fix:** Only set `hasLifecycleScript: true` for install-phase lifecycle hooks.

### SEC-08 — Evidence redaction only filters keys, not values
- **What:** Dashboard evidence redaction checks JSON key names but not string values. Does not recurse into nested objects or array elements. A string like `Bearer sk-abc123` passes through if the key is not sensitive.
- **Files:** `packages/api-proxy/src/routes/dashboard.ts`
- **Priority:** Low
- **Fix:** Implement recursive redaction of keys AND string values. Use credential-pattern matching (Bearer tokens, base64 > 40 chars).

### SEC-09 — `checkAdmin` middleware duplicated across route files
- **What:** Identical `checkAdmin` function (~20 lines) duplicated verbatim in `admin.ts` and `dashboard.ts`.
- **Files:** `packages/api-proxy/src/routes/admin.ts`, `packages/api-proxy/src/routes/dashboard.ts`
- **Priority:** Medium
- **Fix:** Extract into shared Fastify plugin or middleware hook.

## Logic Bugs (5 remaining)

### BUG-01 — Empty `tarballHash: ''` fallback creates orphan records
- **What:** Admin override route uses `tarballHash: ''` in unique constraint lookup when no hash provided. Creates synthetic hash `override:package:version` that won't match any tarball.
- **Files:** `packages/api-proxy/src/routes/admin.ts`
- **Priority:** High
- **Fix:** Look up all matching versions without tarballHash filter, pick most recent, or require explicit hash.

### BUG-02 — `getLatestAllowedVersion` uses misleading relation name
- **What:** `predecessorDecisions` relation on `PackageVersion` is semantically confusing — it's actually decisions *about* this version, not decisions where this version is a predecessor.
- **Files:** `packages/prisma-client/prisma/schema.prisma`, `packages/prisma-client/src/repositories/package-versions.ts`
- **Priority:** Medium
- **Fix:** Rename Prisma relation from `predecessorDecisions` to `decisions` via migration, or add clarifying comment.

### BUG-03 — Shell injection risk in sandbox-execute `require()` call
- **What:** `execSync` interpolates user-controlled `params.moduleName` into a shell command. Single-quote escaping is insufficient against `$()`, backticks, `;`, `|`.
- **Files:** `packages/audit-rpc-server/src/index.ts`
- **Priority:** Medium
- **Fix:** Use `execFileSync` with separated args, or pass script via temp file/stdin. Never construct shell commands via string interpolation.

### BUG-04 — Race condition in promotion.ts decision staleness check
- **What:** TOCTOU race between `newerDecision` check and `promoteTarballToVerdaccio()` call — another worker could create a BLOCK decision in between.
- **Files:** `packages/worker/src/handlers/promotion.ts`
- **Priority:** Medium
- **Fix:** Wrap decision verification + promotion in `$transaction` with `SELECT ... FOR UPDATE` or appropriate isolation level.

### BUG-06 — `getActiveModelProfile()` picks most recently created, not truly "active"
- **What:** After `isFallback` column removal, there is no explicit active flag. Most recently created profile becomes the active one — if an admin creates a test profile, it takes over production audits.
- **Files:** `packages/prisma-client/src/repositories/model-profiles.ts`
- **Priority:** Low
- **Fix:** Add `active` boolean field to `ModelProfile` (migration). Default newest to active, deactivate old ones.

## Architecture Issues (6 remaining)

### ARCH-01 — PI process management lacks robustness
- **What:** Fixed 2-second sleep for PI startup with no readiness check. Stderr captured but never checked. `promptAccepted` flag only checked after verdict timeout.
- **Files:** `packages/audit-runner/src/orchestrator.ts`
- **Priority:** High

### ARCH-02 — `isMainModule` detection fragile
- **What:** Checks `process.argv[1]` for file extension — breaks on rename, bundler output, test runners.
- **Files:** `packages/audit-rpc-server/src/index.ts`
- **Priority:** Medium
- **Fix:** Use standard `process.argv[1] === fileURLToPath(import.meta.url)`.

### ARCH-03 — Duplicate static analysis implementations
- **What:** Capability extraction in both `capability-extract.ts` and `handleStaticChecks()` in audit RPC server — can diverge, causing inconsistent findings.
- **Files:** `packages/shared/src/services/capability-extract.ts`, `packages/audit-rpc-server/src/index.ts`
- **Priority:** Medium
- **Fix:** RPC server should import `extractCapabilities()` from shared package.

### ARCH-04 — PgBoss connection managed in two places
- **What:** API proxy uses raw PgBoss without retry/dedup; worker uses `JobQueue` wrapper with full retry policy. Inconsistent job submission.
- **Files:** `packages/api-proxy/src/index.ts`, `packages/worker/src/index.ts`
- **Priority:** Medium
- **Fix:** Have API proxy use same `JobQueue` class, or extract shared connection.

### ARCH-05 — Container runner uses Docker CLI instead of SDK
- **What:** `ContainerRunner` shells out to `docker` CLI for create/start/inspect/kill/rm. Error handling via CLI output parsing, no streaming logs.
- **Files:** `packages/worker/src/services/container-runner.ts`
- **Priority:** Low
- **Fix:** Use `dockerode` or Docker HTTP API directly.

### ARCH-06 — No versioning strategy for evidence artifacts
- **What:** Evidence artifacts have lineage via `supersedesEvidenceArtifactId` but no schema version field. Old artifacts become unparseable if format evolves.
- **Files:** `packages/prisma-client/prisma/schema.prisma`
- **Priority:** Low
- **Fix:** Add `schemaVersion` field to `EvidenceArtifact`, defaulting to `1`.

## Code Quality Issues (6 remaining)

### QUAL-01 — Pervasive `as any` type assertions
- **What:** `as any` used extensively to bypass Prisma enum types at the data persistence boundary. Silent acceptance of invalid strings.
- **Files:** Multiple repository files in `packages/prisma-client/src/repositories/`
- **Priority:** Medium
- **Fix:** Import and use generated Prisma enum types (`EvidenceType`, `EvidenceStatus`, etc.) instead of casting.

### QUAL-02 — Monolithic `main.tsx` (58KB)
- **What:** Single file containing entire web UI (dashboard, kanban, admin, evidence viewer, prompts, campaigns, evaluations). No component decomposition.
- **Files:** `packages/web-ui/src/main.tsx`
- **Priority:** Medium
- **Fix:** Decompose into page-level components and shared UI components with separate test files.

### QUAL-03 — Duplicated `checkAdmin` auth middleware (also SEC-09)
- **What:** See SEC-09 above.
- **Priority:** Medium

### QUAL-04 — Silent error swallowing in catch blocks
- **What:** Empty catch blocks (`catch { /* ignore */ }`) pervasive across handlers — hide evidence creation failures, metadata snapshots, lockfile import errors.
- **Files:** `packages/worker/src/handlers/reviews.ts` + others
- **Priority:** Medium
- **Fix:** Every catch block must log at minimum with operation name and error. Distinguish benign vs actionable failures via log level.

### QUAL-05 — Magic strings for queue names
- **What:** Queue names like `'package-review'`, `'audit-container-exec'` repeated as string literals across 10+ files. `JOB_TYPES` constant exists but is not consistently used.
- **Files:** Multiple handler files in `packages/worker/src/handlers/`
- **Priority:** Low
- **Fix:** Use `JOB_TYPES` constant everywhere.

### QUAL-06 — Missing input validation in admin override route
- **What:** `scope`, `packageName` (npm naming rules), version format, reason length not validated. Accepts arbitrary strings.
- **Files:** `packages/api-proxy/src/routes/admin.ts`
- **Priority:** Low
- **Fix:** Validate scope against `OverrideScope` enum, packageName against npm naming regex, version as valid semver, reason length.

## Observability Issues (6 remaining)

### OBS-01 — No structured logging
- **What:** All logging uses `console.log`/`console.error` with ad-hoc prefixes. No correlation IDs, no log levels, no aggregation.
- **Files:** Entire codebase
- **Priority:** High
- **Fix:** Adopt structured JSON logger (pino). Include timestamp, level, message, correlationId, package, component.

### OBS-02 — No metrics or health endpoints for job processing
- **What:** `/health` returns `{ status: 'ok' }` with no dependency checks (Postgres, pg-boss, Verdaccio, model endpoint). No Prometheus/OTel metrics.
- **Files:** `packages/api-proxy/src/index.ts`
- **Priority:** High
- **Fix:** Add dependency health checks. Export Prometheus metrics for queue depth, latency, failure rate, container startup time, verdict distribution.

### OBS-03 — No alerting for dead-lettered jobs
- **What:** Dead-lettered jobs transition to `DEAD_LETTER` status with no notification, webhook, or alert. Operators must manually poll.
- **Files:** `packages/worker/src/jobs/queue.ts`
- **Priority:** High
- **Fix:** Log at error level, emit structured event, add notification channel (Slack/webhook/email), dashboard alert widget.

### OBS-04 — No correlation ID across distributed audit pipeline
- **What:** Audit run flows through API proxy → worker → container → RPC bridge → PI → internal API calls with no shared correlation ID across log entries.
- **Files:** Entire pipeline
- **Priority:** Medium
- **Fix:** Propagate `correlationId` through job payloads, HTTP headers, container env, and log entries at every stage.

### OBS-05 — Evidence post-processing is effectively a no-op
- **What:** `evidence-post-process` handler validates existence then passes through status with no enrichment, analysis, or transformation.
- **Files:** `packages/worker/src/handlers/evidence-post-process.ts`
- **Priority:** Low
- **Fix:** Implement actual post-processing or remove the job type.

### OBS-06 — No audit trail for admin actions beyond Override records
- **What:** Admin overrides are recorded but `adminIdentity` is hardcoded to `'admin'`. Lockfile imports, campaign triggers, model/profile changes have no audit record.
- **Files:** `packages/api-proxy/src/routes/admin.ts`
- **Priority:** Low
- **Fix:** Extract actor identity from structured tokens, record audit log entry for every admin action via Fastify `onResponse` hook.

## Already Fixed (via TASK-29 + follow-up)

- SEC-01 (partial): Auth token defaults removed — going further with format validation remains
- SEC-04: Verdaccio promotion token hardcoded default removed
- BUG-05: `supersedeEvidenceArtifact` status assignment fixed

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 All 31 open findings are resolved or explicitly deferred with rationale in the task or subtask.
- [ ] #2 No finding status changes without an audit trail (decision record in findings log).
- [ ] #3 Each fix includes a test or manual verification step.
- [ ] #4 Each fix is linked to its finding ID in the commit message.
- [ ] #5 The original audit report is annotated with fix status per finding, or a log is kept.
<!-- AC:END -->
