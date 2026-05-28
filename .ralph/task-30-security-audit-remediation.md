# Epic: Security and code quality audit remediation (TASK-30)

Implement all 31 open findings from the security & code quality audit across `packages/`.

## Workflow Phases

### Phase 1: Fix all open findings
Work through the 31 findings by priority. Each fix must include a clear commit with the finding ID in the message.

### Phase 2: External audit via subagent
After all fixes are committed, run the dump script and have deepseek-v4-pro audit the codebase for any remaining/new findings.

### Phase 3: Remediate new findings
Add any new findings as subtasks to the task-30 epic and fix them.

### Phase 4: Repeat
Repeat Phase 2-3 until the subagent returns zero findings.

## Phase 1 Checklist (31 findings)

### Security Issues (8)
- [x] SEC-01 (remaining): Add min-length/character-format validation for auth tokens in `readRequiredList()`
- [x] SEC-02: Split RPC token — use distinct tokens for PI auth vs outbound API calls
- [ ] SEC-03: Replace `$queryRawUnsafe` with type-safe Prisma queries in dashboard
- [x] SEC-05: Reject tarball if integrity hash cannot be resolved from upstream (fail closed)
- [x] SEC-06: Consolidate to single AST-aware implementation for static analysis (combined with ARCH-03)
- [x] SEC-07: Only set `hasLifecycleScript: true` for install-phase lifecycle hooks
- [x] SEC-08: Implement recursive redaction of keys AND string values in evidence
- [x] SEC-09: Extract `checkAdmin` into shared Fastify plugin/middleware

### Logic Bugs (5)
- [x] BUG-01: Fix empty `tarballHash: ''` fallback in admin override route
- [ ] BUG-02: Fix misleading `predecessorDecisions` relation name or add clarifying comment
- [x] BUG-03: Fix shell injection risk in sandbox-execute — use `execFileSync`
- [ ] BUG-04: Fix TOCTOU race in promotion.ts — wrap in `$transaction` with lock
- [ ] BUG-06: Add `active` boolean field to `ModelProfile` (migration)

### Architecture Issues (6)
- [ ] ARCH-01: Fix PI process management — readiness check instead of fixed sleep, check stderr
- [x] ARCH-02: Fix fragile `isMainModule` detection
- [x] ARCH-03: Deduplicate static analysis — RPC server should import from shared
- [x] ARCH-04: Use shared `JobQueue` class in API proxy
- [ ] ARCH-05: Container runner — use Docker SDK instead of CLI (or defer with rationale)
- [ ] ARCH-06: Add `schemaVersion` field to `EvidenceArtifact`

### Code Quality (6)
- [ ] QUAL-01: Replace `as any` with generated Prisma enum types
- [ ] QUAL-02: Decompose monolithic `main.tsx` (58KB) — or defer with rationale
- [x] QUAL-03: Extract duplicated `checkAdmin` (same as SEC-09)
- [ ] QUAL-04: Fix silent error swallowing — every catch block must log
- [x] QUAL-05: Use `JOB_TYPES` constant everywhere instead of magic strings
- [x] QUAL-06: Add input validation in admin override route

### Observability (6)
- [ ] OBS-01: Adopt structured JSON logger (pino)
- [ ] OBS-02: Add dependency health checks and Prometheus/OTel metrics
- [ ] OBS-03: Add alerting for dead-lettered jobs
- [ ] OBS-04: Propagate `correlationId` across distributed audit pipeline
- [ ] OBS-05: Fix evidence post-processing or remove the job type
- [ ] OBS-06: Implement audit trail for admin actions

## Verification
- Each fix is tested or manually verified
- Commits include finding ID in message
- After Phase 1: run dump + subagent audit, record output

## Notes
