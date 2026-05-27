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

## Next: Expand scope to remaining tasks (TASK-1.4, TASK-1.6, etc.)

## Verification
- `pnpm install` clean
- `npx vitest run` in packages/prisma-client — pass
- `npx vitest run` in packages/worker — pass
- `npx tsc --noEmit` in packages/worker — clean
- Backlog updated for each fix