# Ralph Loop: v1 Core Implementation

Implement TASK-1.1 -> TASK-1.2 -> TASK-1.3 -> TASK-1.16 sequentially, with frequent commits and backlog tracking.

## Goals
- Complete all 4 tasks with all acceptance criteria checked and Definition of Done satisfied
- Each task is committed separately with conventional commit messages
- Backlog is updated as progress is made (AC checks, notes, final summaries)

## Dependency Chain
TASK-1.1 (architecture doc) -> TASK-1.2 (monorepo scaffold) -> TASK-1.3 (Prisma schema) -> TASK-1.16 (pg-boss jobs)

## Checklist
- [ ] TASK-1.1: Write architecture/threat-model document (`docs/architecture.md`)
- [ ] TASK-1.2: Scaffold pnpm monorepo, Docker Compose, dev scripts, shared config
- [ ] TASK-1.3: Implement Prisma schema, migrations, and repository APIs
- [ ] TASK-1.16: Implement pg-boss job definitions, idempotency, workers, scheduling

## Verification
- Each task: all ACs checked, DoD satisfied, final summary written, status set to Done
- Frequent commits after meaningful milestones
- Backlog reflects real progress

## Notes
(Update with progress, decisions, blockers)