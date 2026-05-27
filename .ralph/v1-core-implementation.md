# Ralph Loop: v1 Core Implementation

Implement TASK-1.1 -> TASK-1.2 -> TASK-1.3 -> TASK-1.16 sequentially, with frequent commits and backlog tracking.

## Goals
- Complete all 4 tasks with all acceptance criteria checked and Definition of Done satisfied
- Each task is committed separately with conventional commit messages
- Backlog is updated as progress is made (AC checks, notes, final summaries)

## Dependency Chain
TASK-1.1 (architecture doc) -> TASK-1.2 (monorepo scaffold) -> TASK-1.3 (Prisma schema) -> TASK-1.16 (pg-boss jobs)

## Checklist
- [x] TASK-1.1: Write architecture/threat-model document (`docs/architecture.md`)
- [x] TASK-1.2: Scaffold pnpm monorepo, Docker Compose, dev scripts, shared config
- [x] TASK-1.3: Implement Prisma schema, migrations, and repository APIs
- [x] TASK-1.16: Implement pg-boss job definitions, idempotency, workers, scheduling

## Verification
- Each task: all ACs checked, DoD satisfied, final summary written, status set to Done
- Frequent commits after meaningful milestones
- Backlog reflects real progress

## Notes
- **Iteration 1 (TASK-1.1)**: Wrote docs/architecture.md covering all 11 ACs. Committed as `docs: add v1 architecture and threat model contract`. Backlog updated: all ACs checked, DoD satisfied, final summary added, status set to Done.
- **Iteration 2 (TASK-1.2)**: Scaffolded full monorepo with 7 packages, Docker Compose, shared config, dev scripts, audit-runner image. Committed as `feat: scaffold TypeScript monorepo and Docker Compose stack`. Pushed. Advisor reviewed. Backlog updated: all ACs/DoD checked, status Done.
- **Iteration 3 (TASK-1.3)**: Implemented full Prisma schema (16 models), auto-generated migration, repository APIs for all domains, 9 integration tests. Port 5422. Commits: schema+APIs, tests. Backlog updated: all ACs/DoD checked, Done.
- **Iteration 4 (TASK-1.16)**: Implemented pg-boss job queue wrapper with typed job definitions, deterministic idempotency keys, configurable concurrency/retry/timeout per job type, convenience methods for all 7 job types, and scheduling helpers. 10 integration tests pass. Committed as `feat: implement pg-boss event and job orchestration`.