# Ralph Loop: Complete TASK-1 (ModuleWarden v1 Epic)

Complete all remaining sub-tasks of TASK-1 in dependency order. Commit frequently, push each commit, run full test suite after each step. Parallel read-only reviewer (deepseek-v4-pro) provides feedback.

## Dependency Order
1. TASK-1.7 — PI RPC agentic audit harness (starts now)
2. TASK-1.9 — Capability-delta extraction & evidence preparation
3. TASK-1.8 — Prompt packs, escalation, re-audit scheduling
4. TASK-1.13 — Replay evaluation harness & quality metrics
5. TASK-1.14 — Security tests
6. TASK-1.11 — Developer CLI
7. TASK-1.12 — Web UI
8. TASK-1.15 — Documentation

## Current Iteration: Implement TASK-1.7 (PI RPC Audit Harness)

### Implementation plan (approved):
1. Create `packages/audit-rpc-server/` — Fastify HTTP server with 8 RPC tool endpoints
2. Add structured verdict types to `packages/shared/`
3. Update `packages/audit-runner/Dockerfile` — include PI + RPC bridge + entrypoint
4. Create `handlers/audit-run.ts` — pg-boss handler that launches container, monitors PI, captures verdict
5. Wire into existing container-runner + job system
6. Write tests, run full suite, get reviewer sign-off

## Checklist
- [ ] RPC bridge server implemented (all 8 tool endpoints)
- [ ] Verdict types defined in shared package
- [ ] Dockerfile updated with PI + bridge
- [ ] Worker handler wired
- [ ] Tests pass
- [ ] Reviewer sign-off

## Verification
- `pnpm install` clean
- Full test suite passes
- Typecheck clean across all packages

## Ad hoc review note (2026-05-28)
- Completed requested code/architecture review and wrote findings to `docs/review/gpt-1.md`.
- Verification observed: `pnpm -r typecheck` fails in `@modulewarden/web-ui` due missing React type packages; `pnpm -r test` fails in `@modulewarden/prisma-client` because `postgres:5432` is unavailable.
