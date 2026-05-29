# Review Fixes — Packages Architecture Review 2026-05-29

Fix all critical, high, and medium findings from the architecture review in `docs/reviews/packages-architecture-review-2026-05-29.md`.

Worktree: `claude-review-fixes` (branch `claude-review-fixes`)
Working directory: `/Users/andreas/code/ModuleWarden/claude-review-fixes`

## Goals
- Fix all critical bugs (C1, C2, C3) in the review
- Fix high-severity findings (H1, H2)
- Fix medium-severity findings (M1–M6)
- Address honesty-of-evidence stubs (§4)
- Address lower-priority cleanups (§5)

## Checklist _(all complete)_
- [x] **C1 + M1** — Lockfile import wiring (preflight is dead) + pnpm v9 format support
  - Modified `packages/shared/src/services/lockfile.ts`: added `parseLockfileContent()`, pnpm v9 format support (no leading `/` for unscoped), made `parseLockfile` delegate to content parser
  - Modified `packages/api-proxy/src/services/lockfile-import.ts`: `importLockfile` now accepts content+format, removed filesystem dep
  - Modified `packages/api-proxy/src/routes/admin.ts`: creates/resolves project by filename (upsert, handles TOCTOU), passes pgBossSend
  - Modified `packages/api-proxy/src/index.ts`: resolves queue before passing to internal/admin routes (also fixes C2)
  - Updated tests: both `shared` (10/10 pass) and `api-proxy` (lockfile-import tests use content-based API)
  - **DeepSeek review**: ALL GOOD (minor notes N-1..N-4, N-2 TOCTOU and N-4 path separators fixed)
- [x] **C2** — Auto-promotion on ALLOW never fires; queue captured by value at registration time
  - Fixed in `packages/api-proxy/src/index.ts`: calls `await getQueue()` before `registerInternalRoutes` and `registerAdminRoutes`, passing live queue reference, not `null`
- [x] **C3** — Escalation case mismatch (uppercase vs lowercase comparison)
  - Fixed in `packages/api-proxy/src/services/escalation.ts`: normalize verdict to uppercase at function entry, compare against `'QUARANTINE'` and `'BLOCK'`
- [x] **H1** — `checkAnyAuth` double-sends 403 before admin token check
  - Fixed in `packages/api-proxy/src/middleware/auth.ts`: `checkAnyAuth` now does silent hash matching for both dev and admin tokens, only sends a response after both lists are exhausted
- [ ] **H2 / M2** — Container resource limits + dep-fan-out gating (unauthenticated amplification)
- [x] **M3** — Shell-string construction of docker command (use execFile / argv array)
  - `packages/worker/src/services/container-runner.ts`: all docker commands (create, start, inspect, kill, logs) now use `execFileSync`/`execFileAsync` with argv arrays
  - `packages/shared/src/services/capability-extract.ts`: `find` command now uses `execFileSync('find', [...args])` with proper argv array; also fixed `-name ".jsx"` → `-name "*.jsx"` (missing `*`)
- [x] **M4** — Admin override rejects scoped packages (regex missing `/`)
  - Fixed in `packages/api-proxy/src/routes/admin.ts:47`: regex now allows `@scope/name` format
- [x] **M5** — `sha384` integrity hashed with `sha256` → false mismatch
  - Fixed in `packages/shared/src/services/upstream.ts`: `sha384-` integrities now use `sha384` hash algorithm
- [x] **M6** — Hardcoded default admin token in web bundle (flag for non-demo use)
  - Added prominent JSDoc warning comment in `packages/web-ui/src/main.tsx`
- [x] **§4** — Honesty-of-evidence stubs labeled
  - `internal.ts:168` — predecessor-diff already had L-1 comment
  - `audit-rpc-server/index.ts:329` — added `observedNetworkConnections` stub comment
  - `shared/src/services/capability-extract.ts` — added regex-not-AST comment
  - `worker/handlers/model-escalation.ts` — added stub comment + fixed evidence bundle lookup bug
  - `internal.ts:300` — added contentHash stub comment
- [x] **H2 / M2** — Container resource limits + dep-fan-out gating
  - M2: Added `--memory`, `--cpus`, `--pids-limit` to docker create args (defaults: 1024m, 1 CPU, 100 pids)
  - H2: Added `MAX_PIPELINE_DEPTH=10` and `MAX_PIPELINE_STEPS=500` constants to pipeline handler
  - H2: `resolveDependencyDag` now accepts `maxSteps` parameter; DFS stops when `visited.size >= maxSteps`
- [x] **§5** — Selected lower-priority cleanups
  - CLI `remove-override` command: implemented the missing command handler
  - Redundant `boss.fail()` + re-throw: added comment noting potential redundancy
  - (Deduplication of parseSemver and other refactors deferred — cosmetic, not blocking)

## Verification
- Run `pnpm build` across all packages after each fix
- Run existing test suites: `pnpm test` in affected packages
- Manual checks for each fix (see Notes)

## Notes
- Priority per review §7: C1+M1 → C2 → C3+H1 → M2/H2 → §4 → §5
- C1 and M1 are grouped because fixing lockfile import also requires supporting pnpm v9 format
- C2 and C3 are independent but both affect `/internal/verdict` route
- Edit files directly in the `claude-review-fixes` worktree
