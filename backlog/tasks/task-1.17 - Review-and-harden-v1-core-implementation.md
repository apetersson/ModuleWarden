---
id: TASK-1.17
title: Review and harden v1 core implementation
status: Done
assignee:
  - '@agent-k'
created_date: '2026-05-27 20:01'
updated_date: '2026-05-27 20:03'
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
- [x] #1 Gather review evidence: all tests pass, all packages typecheck
- [x] #2 Run advisor with evidence packet
- [x] #3 Fix all concrete findings from review
- [x] #4 Re-run advisor until no findings remain
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Fixed pg-boss test singleton key collisions by adding per-run unique RUN_ID

- Verified all 19 tests pass (10 worker + 9 prisma)

- All packages typecheck clean (shared, api-proxy, cli, worker)

- Prisma schema validates, Docker Compose config validates, pnpm install clean
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Thorough review of 4 completed tasks (TASK-1.1/1.2/1.3/1.16). Found and fixed pg-boss test singleton key collision bug: singleton keys with 24h window caused dedup collisions across test runs. Fixed by adding per-run unique RUN_ID to test keys. All 19 tests pass, all packages typecheck, Prisma schema valid, Docker Compose valid. Advisor sign-off obtained after fix.
<!-- SECTION:FINAL_SUMMARY:END -->
