---
id: TASK-1.11
title: Build the ModuleWarden developer CLI
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:19'
updated_date: '2026-05-28 11:53'
labels:
  - cli
  - dx
  - v1
dependencies:
  - TASK-1.4
  - TASK-1.5
  - TASK-1.10
  - TASK-1.16
parent_task_id: TASK-1
priority: medium
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the CLI that makes the registry gate understandable instead of frustrating.

The DX principle from planning is that developers should install as usual for approved packages, and only see extra friction when a package/version is new, risky, blocked, or quarantined. The CLI gives them visibility into what is happening and lets them ask for audits without bypassing ModuleWarden.

The recommended command surface is intentionally small: status, explain, request, preflight, and doctor.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `modulewarden preflight` imports/checks the current project lockfile, reports missing/blocked/quarantined versions, and enqueues reviews when appropriate.
- [x] #2 `modulewarden status` shows pending reviews and effective dependency gate state for the current project or requested package.
- [x] #3 `modulewarden explain <pkg@version>` shows verdict, reason summary, evidence references, prompt/model versions as allowed by role, and alternatives.
- [ ] #4 `modulewarden request <pkg@version>` explicitly requests an upstream version audit and returns the job/status URL.
- [ ] #5 `modulewarden doctor` checks registry config, auth token, lockfile detection, API reachability, and CI readiness.
- [ ] #6 The CLI is pnpm-first for v1 and detects pnpm workspace lockfiles for dogfood import, while preserving npm and yarn compatibility paths where available.
- [ ] #7 Preflight imports all configured lockfiles and reports graph readiness, decision coverage, quarantines, blocks, and unreviewed versions before registry enablement.
- [ ] #8 Status and explain commands surface immutable evidence references and evaluation labels without exposing hidden prompt text.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement a Node CLI package that authenticates with a static developer token, reads local npm/pnpm/yarn config and lockfiles, calls ModuleWarden APIs, and prints concise actionable output. CLI-triggered reviews should call API endpoints that enqueue pg-boss jobs; the CLI must not talk directly to pg-boss or Postgres.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLI implemented with preflight, status, explain, admin commands. 3 test cases. Communicates with ModuleWarden API via MW_API_BASE.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 CLI integration tests cover normal developer flows without requiring direct Verdaccio access.
<!-- DOD:END -->
