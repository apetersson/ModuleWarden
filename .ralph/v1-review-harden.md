# Ralph Loop: Review & Harden v1 Core Implementation

Thoroughly review the 4 completed tasks (TASK-1.1, 1.2, 1.3, 1.16) for correctness gaps, missing tests, schema/API consistency, Docker/Prisma reproducibility, job idempotency, and any overlooked AC items. Fix all findings, then expand to next tasks.

## Goals
- Gather comprehensive review evidence (all tests pass, all packages typecheck)
- Run advisor for thorough review with concrete evidence
- Fix all concrete findings with commits and backlog updates
- Repeat until advisor finds nothing
- Then expand scope to remaining tasks (TASK-1.4, 1.5, etc.)

## Checklist
- [x] Gather review evidence (tests, typecheck, file structure)
- [x] Run advisor with evidence packet
- [x] Implement fixes from first review pass — singleton key collision
- [x] Re-run tests and advisor — sign-off obtained
- [x] Review clean — no remaining findings
- [x] Expand scope: review remaining completed tasks (TASK-1.4, 1.5, 1.6, 1.10)
- [x] Build Docker audit-runner image — tests now all pass (102 tests)
- [x] Fix: tarball route upstream fetch and Verdaccio proxy missing try/catch → 502 instead of crash 500
- [x] Fix: capability.test.ts typecheck — missing `as const` on summary literals

## Next: Implement TASK-1.7 (PI RPC agentic audit harness)
TASK-1 (Epic) is NOT complete — 8/8 ACs unchecked, 6 sub-tasks still To Do.
This loop now transitions from review to implementing the next critical unblocked task.

Dependencies all met: TASK-1.3 (schema), 1.6 (audit runner), 1.16 (pg-boss) — all Done.

## Goals
- [ ] Implementation plan for TASK-1.7 shared with user for approval
- [ ] PI RPC audit harness implemented (ACs 1-9)
- [ ] All new tests pass alongside existing 102
- [ ] Typecheck clean across all packages

## Verification
- `pnpm install` clean
- `pnpm -r test` — all tests pass
- `pnpm build` — all packages typecheck clean
- Docker image `modulewarden-audit-runner` built