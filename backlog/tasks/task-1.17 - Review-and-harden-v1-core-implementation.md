---
id: TASK-1.17
title: Review and harden v1 core implementation
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 20:01'
labels:
  - review
dependencies: []
parent_task_id: TASK-1
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Thoroughly review the 4 completed tasks (TASK-1.1, 1.2, 1.3, 1.16) for correctness gaps, missing tests, schema/API consistency, Docker/Prisma reproducibility, job idempotency, and any overlooked AC items. Fix all concrete findings. Repeat until advisor finds nothing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Gather review evidence: all tests pass, all packages typecheck
- [ ] #2 Run advisor with evidence packet
- [ ] #3 Fix all concrete findings from review
- [ ] #4 Re-run advisor until no findings remain
<!-- AC:END -->
