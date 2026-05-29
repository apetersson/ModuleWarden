# ModuleWarden — Architecture & Code Review (TypeScript packages)

**Date:** 2026-05-29
**Scope:** `packages/{api-proxy, audit-rpc-server, audit-runner, cli, evaluation, shared, web-ui, worker}`
**Reviewer:** Claude (Opus 4.8), with stronger-model advisory pass

---

## 1. Summary

The TypeScript surface is well-structured and, in its security-critical
*serving* path, fundamentally sound: the tarball gate is hash-keyed, promotion
verifies integrity before publishing, RPC tokens are per-run and hashed, and the
audit container is meaningfully hardened. Most prior security-review tags
(S-x, C-x, H-x) correspond to real, sensible fixes.

However, the **two primary end-to-end flows the product is built around are
broken by wiring bugs**, and both slipped past the test suite because tests
exercise functions in isolation rather than route wiring:

1. **Lockfile import / `preflight` is non-functional** — the documented primary
   developer entry point imports nothing.
2. **Automatic Verdaccio promotion on ALLOW never fires in the normal flow** —
   approved packages can fail to install.write 

There is also a coherent secondary theme worth surfacing given this is an
*underwriting* product: several evidence signals are **stubbed but presented as
real**, which is in tension with CLAUDE.md's "none of them lies about the others."

Depth note: `api-proxy`, `worker`, `audit-runner`, `audit-rpc-server`, `cli`,
and `shared` were read in full on the critical paths. `web-ui/main.tsx` (2014
lines) was reviewed for its real risks (token handling, XSS) but not line-by-line.
`packages/evaluation` contains no source (only `tsbuildinfo`).

---

## 2. Critical bugs

### C1. Lockfile import is wired wrong — `preflight` imports nothing
**Files:** `api-proxy/src/routes/admin.ts:213`, `api-proxy/src/services/lockfile-import.ts:26`, `shared/src/services/lockfile.ts:30`

`importLockfile(projectId, lockfilePath, pgBossSend?)` reads a file from disk:
`parseLockfile(lockfilePath)` → `readFileSync(filePath)`. The admin route calls
it as:

```ts
const result = await importLockfile(filename, content);
```

So `projectId = filename` and `lockfilePath = <entire lockfile text>`. The
function then runs `existsSync(content)` → `false` → returns early with
`errors: ["Lockfile not found: <content…>"]` and all counts `0`. The route
returns `201` with zeros; the CLI prints "Imported 0 packages."

This is structural, not edge-case: the server (in a container) can never read
the client's file — the design clearly intends to receive **content**, but
`importLockfile`/`parseLockfile` were never adapted to parse content. Note
`shared/src/services/lockfile.ts:53` already has an unused, content-based
`detectLockfileFormat(content)` — the content path was started and abandoned.

Even if `existsSync` were bypassed: `projectId` is a filename (not a `Project`
row id, FK problem), and the route never passes `pgBossSend`, so
`enqueuedReviews` would be `0` regardless.

**Why tests missed it:** `lockfile-import.test.ts` calls `importLockfile(projectId, lockfilePath)`
with real temp files — testing the function, never the route contract.

**Fix:** make `importLockfile` accept raw content + format (use
`detectLockfileFormat`), resolve/create a real `Project`, and pass a
`pgBossSend` that enqueues `package-review`.

---

### C2. Auto-promotion on ALLOW never fires in the RPC flow → `npm install` can 502
**Files:** `api-proxy/src/index.ts:165`, `api-proxy/src/routes/internal.ts:346`, `worker/src/handlers/audit.ts:315`

`buildServer()` registers internal routes with the queue captured **by value**
at registration time:

```ts
await registerInternalRoutes(app, _queue ?? undefined); // _queue is null here
```

`_queue` is only created lazily by `getQueue()`, which has not run during
`buildServer()`. So inside `/internal/verdict`, `queue` is permanently
`undefined`, and the `if (verdict === 'ALLOW' && queue …)` promotion enqueue
(and the model-escalation enqueue) is **dead code**. This part is airtight.

Three promotion triggers exist, and the net effect is that the *normal* path
doesn't promote:

- **RPC path** (`/internal/verdict`, the normal flow): dead (`queue` undefined).
- **Worker fallback** (`audit.ts:315`): gated on `!existingDecision`. But
  `/internal/verdict` already created the decision, so this is skipped in the
  normal flow. (It only runs on the race where the container exits before the
  POST commits — i.e. nondeterministic, not a reliable backstop.)
- **Dashboard manual promote** (`dashboard.ts:810`): works correctly.

**Accurate claim:** auto-promotion is broken in the normal RPC flow; only the
manual dashboard promote is reliable.

**User-visible symptom (from `tarball.ts:160-195`):** for an ALLOW verdict with
`registryReady` true but no promotion, the tarball route still routes to
Verdaccio, the artifact isn't there, and the client gets a **502 "Tarball not
found in backing registry."** An approved package fails to install.

**Fix:** `await getQueue()` before `registerInternalRoutes`, or pass a
`() => getQueue()` getter the handler resolves per request.

---

### C3. Escalation never triggers for quarantine/block — case mismatch
**Files:** `api-proxy/src/routes/internal.ts:307,375`, `api-proxy/src/services/escalation.ts:39,51`

`/internal/verdict` normalizes the verdict to **uppercase**
(`'ALLOW'|'BLOCK'|'QUARANTINE'`) and calls
`shouldEscalateVerdict(verdict, …)`. But `shouldEscalateVerdict` compares
against **lowercase**:

```ts
if (verdict === 'quarantine') return true;   // never true — verdict is 'QUARANTINE'
…
if (verdict === 'block') { …hedging check… }  // never reached
```

So the headline rules — "always escalate quarantines" and "escalate hedged
blocks" — never fire from the production RPC path. Only the score-based fallbacks
(risk > 0.7, findings > 5, confidence < 0.3) can trigger. This silently
undermines the three-layer "DeepSeek second opinion on QUARANTINE" architecture.

(Also moot today because of C2's undefined `queue`, and because the escalation
job is itself a stub — see Q2/§4 — but it's an independent logic bug that will
bite once C2 is fixed.)

**Fix:** lower-case before comparison, or compare against uppercase constants.

---

## 3. High / medium findings

### H1. `checkAnyAuth` double-sends — admin tokens rejected on dev-or-admin routes
**File:** `api-proxy/src/middleware/auth.ts:131-152` (affects `routes/status.ts` `/status`, `/status/:package`, `/status/:package/:version`, `/explain/*`)

`checkAnyAuth` tries dev tokens first via `checkToken`, which **sends a 403 on
mismatch**. It then falls through to admin tokens. With an admin token and both
lists configured (config requires both), the dev branch sends `403`, then the
admin branch matches and returns `true` — but the reply is already sent. The
handler runs and calls `reply.send(...)` on an already-sent reply ("Reply was
already sent"). Net: a **valid admin token gets 403** on every `requireAnyAuth`
route. Dev tokens work (early return before any send).

**Fix:** make the dev attempt non-responding (a pure boolean match that doesn't
write the reply), and only emit 401/403 once after both lists are tried.

### H2. Unauthenticated registry routes amplify into the audit pipeline (cost/DoS)
**Files:** `api-proxy/src/routes/packument.ts:319,350` (`enqueuePackageAndDeps`), `worker/src/services/container-runner.ts`

`GET /:package` and the tarball route are correctly unauthenticated (npm clients
need them), but they **drive the expensive pipeline**: a packument miss fans out
to upstream fetches for every direct dependency and enqueues `package-review`
jobs → `audit-container-exec` → Docker containers that run untrusted package code
(`sandbox-execute` `run-script`). Idempotency dedups *identical* requests, but
distinct package names bypass it. Combined with M2 (no container resource
limits), this is an unauthenticated amplification vector into the sandbox. Rate
limiting (100/min/IP) helps but the per-request cost is very high. Consider
gating dep fan-out behind project enablement and/or a stricter budget.

### M1. `shouldEscalate`/promotion enqueue aside — pnpm v9 lockfiles parse to empty
**File:** `shared/src/services/lockfile.ts:154-181`

The pnpm parser only accepts keys starting with `/` (`/pkg@version`), the v5/v6
format. Modern pnpm (lockfileVersion 9, default since pnpm 9 / 2024) uses
`pkg@version` keys without the leading slash and a separate `snapshots:` section,
so `if (!key.startsWith('/')) continue;` skips **every** entry. Even after C1 is
fixed, current pnpm lockfiles import zero packages. (CLAUDE.md treats
`pnpm-lock.yaml` as the primary input.)

### M2. Audit container has no resource limits
**File:** `worker/src/services/container-runner.ts:177-190`

`docker create` sets `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
`--read-only`, `--tmpfs`. Good. But there is **no `--memory`, `--cpus`, or
`--pids-limit`.** Untrusted `npm install` / `npm run` inside the sandbox can
fork-bomb or exhaust host memory. Add resource caps (ties into H2).

### M3. Shell-string construction of the `docker` command
**File:** `worker/src/services/container-runner.ts:136-198`

The container command is assembled by string concatenation and run via
`execSync`, interpolating `packageName`/`packageVersion` into
`-e "MW_PACKAGE_NAME=…"`. `containerName` is sanitized; the env values are not. A
`"` in a value would break quoting. npm's own name rules make this hard to reach
in practice (the package must exist upstream), so risk is low — but prefer
`execFile('docker', [...args])` with an argv array for defense-in-depth. Same
pattern in `capability-extract.ts:158` (`find "${dir}"`).

### M4. Admin override rejects scoped packages
**File:** `api-proxy/src/routes/admin.ts:47`

`/^@?[a-z0-9][a-z0-9._-]*$/` has no `/`, so `@scope/name` fails validation —
admin overrides can't be created for scoped packages. Use a proper npm-name
regex.

### M5. `sha384` integrity is hashed with `sha256` → false integrity mismatch
**File:** `shared/src/services/upstream.ts:86-91`

`integrity.startsWith('sha256-') || integrity.startsWith('sha384-') ? 'sha256'`
hashes `sha384-…` integrities with SHA-256, guaranteeing a mismatch and a failed
promotion. npm almost always uses sha512 so it rarely bites, but it's wrong.

### M6. Hardcoded default admin token in the web bundle
**File:** `web-ui/src/main.tsx:17,1806`

`LOCAL_DEMO_ADMIN_TOKEN = 'mw-admin-token-change-me'` is shipped in the client
bundle and prefilled into the token field; the admin bearer token is stored in
`localStorage`. Fine for the offline demo, but if any deployment leaves that
value in `MW_AUTH_ADMIN_TOKENS` (it passes the ≥16-char check), it's a known
admin credential. `localStorage` also exposes the token to any XSS. Acceptable
for the hackathon; flag before any non-demo use.

---

## 4. Honesty-of-evidence theme (stubbed but presented as real)

CLAUDE.md states the three surfaces never lie about each other, and this evidence
feeds an underwriting verdict. Several signals are placeholders that *read* as
real to the model and the dashboard:

- **`predecessor-diff` always returns `hasPredecessor:false`**
  (`internal.ts:153-164`). Documented as L-1, but it means the entire
  `capability-delta` / `package-diff` machinery in `shared` is unused by the live
  audit, and the model always operates cold-start.
- **`observedNetworkConnections: []` always** (`audit-rpc-server/index.ts:329`).
  The sandbox never observes network egress; "recorded-open egress" in
  `container-runner` is a network *name*, not actual recording. Empty ≠ "none
  observed."
- **Capability extraction is regex, not AST** — `handleStaticChecks` comments
  "Use shared AST-based capability extraction (ARCH-03)"
  (`audit-rpc-server/index.ts:242`) but `extractCapabilities`
  (`shared/services/capability-extract.ts`) is pure regex over file text:
  evadable, and matches inside strings/comments. Also `-name ".jsx"` (missing
  `*`, line 159) means `.jsx` files are never scanned.
- **Model escalation is a stub** (`worker/handlers/model-escalation.ts`) — it
  records an `EvaluationLabel`, no second model is called. Additionally the
  caller passes `evidenceBundleId: auditRunId` (`internal.ts:392`), but the
  handler looks that id up as an `EvidenceArtifact` — it would throw "not found"
  if it ever ran.
- **`/internal/evidence` writes `contentHash: "sha256-" + Date.now()`**
  (`internal.ts:286`) — a timestamp, not a hash, despite the evidence-integrity
  framing.

None of these are wrong to *have* as stubs in a 36-hour build; the
recommendation is to label them as such in the dashboard/report so the
underwriting narrative stays honest.

---

## 5. Lower-priority / quality

- **`evaluation` package is empty** (only `tsbuildinfo`). Evaluation logic lives
  in `shared/services/evaluation-*` and the web-ui `/admin/evaluation` route.
  State this as a placeholder rather than a package.
- **Duplicated `parseSemver`/`semverSortDesc`** in `packument.ts` and
  `filter.ts`; duplicated `decisionForVersion`/`getDecisionForPackumentVersion`.
  Hoist to `shared`.
- **N+1 override lookups** in `decisions.ts:getDecisionsForVersions` (one
  `getBestActiveOverrideForPackageVersion` per version). For popular packages
  with many versions this is a per-packument storm.
- **`filterToApproved` dist-tag fallback** rewrites *every* tag to the single
  highest allowed version (`filter.ts:59`), so a `legacy`/`next` tag can silently
  point at the newest release.
- **`getStatusInfo`** resolves "latest by createdAt" ignoring tarball hash
  (`policy.ts:112`), so the developer-facing status can describe a different hash
  than the gate would actually serve. (The enforcing path is hash-keyed, so this
  is cosmetic, but it can confuse.)
- **CLI:** `help` advertises `remove-override`, but `cmdAdmin` implements only
  `override` and `list-overrides` (`cli/src/index.ts:50,261`).
- **Low-confidence:** `queue.work` calls `boss.fail(name, job.id)` *and* re-throws
  (`worker/jobs/queue.ts:282-284`). On pg-boss v11 the thrown error already fails
  the job; the explicit `fail()` is likely redundant and may log a
  state-transition error. Worth a quick check against v11 handler semantics.

---

## 6. What's solid (keep)

- Tarball gate is hash-keyed and fails closed; BLOCK/QUARANTINE → 403, unreviewed
  → enqueue + 404 (`tarball.ts`).
- Promotion verifies SHA integrity on the buffered tarball before publishing and
  wraps verification in a serializable transaction with pre/post TOCTOU checks
  (`promotion.ts`, `upstream.ts`).
- Per-run RPC tokens: 32-byte random, SHA-256 hashed at rest, validated against
  `AuditRun` rows scoped to `status='RUNNING'`, redacted in archives
  (`audit.ts`, `internal.ts`, `container-runner.ts`).
- Admin auth uses hashed tokens + `timingSafeEqual` with TTL refresh
  (`middleware/auth.ts`).
- Dashboard `$queryRawUnsafe` uses bound `$1` params throughout; the only
  interpolation is the operator-controlled Postgres schema identifier — no SQL
  injection.
- Typed pg-boss wrapper with idempotency keys, dead-letter handling, and
  forensic failure context (`jobs/queue.ts`).

---

## 7. Suggested priority order

1. **C1** lockfile import wiring (preflight is dead) + **M1** pnpm v9 format.
2. **C2** promotion queue wiring (installs of approved packages fail).
3. **C3** escalation case mismatch + **H1** `checkAnyAuth` double-send.
4. **M2/H2** container resource limits + dep-fan-out gating.
5. §4 honesty labels (cheap; high value for an underwriting demo).
6. §5 cleanups.
