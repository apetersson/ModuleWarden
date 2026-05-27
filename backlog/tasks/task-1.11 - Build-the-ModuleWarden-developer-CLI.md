---
id: TASK-1.11
title: Build the ModuleWarden developer CLI
status: To Do
assignee: []
created_date: '2026-05-27 17:19'
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
- [ ] #1 `modulewarden preflight` imports/checks the current project lockfile, reports missing/blocked/quarantined versions, and enqueues reviews when appropriate.
- [ ] #2 `modulewarden status` shows pending reviews and effective dependency gate state for the current project or requested package.
- [ ] #3 `modulewarden explain <pkg@version>` shows verdict, reason summary, evidence references, prompt/model versions as allowed by role, and alternatives.
- [ ] #4 `modulewarden request <pkg@version>` explicitly requests an upstream version audit and returns the job/status URL.
- [ ] #5 `modulewarden doctor` checks registry config, auth token, lockfile detection, API reachability, and CI readiness.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement a Node CLI package that authenticates with a static developer token, reads local npm/pnpm/yarn config and lockfiles, calls ModuleWarden APIs, and prints concise actionable output. CLI-triggered reviews should call API endpoints that enqueue pg-boss jobs; the CLI must not talk directly to pg-boss or Postgres.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 CLI integration tests cover normal developer flows without requiring direct Verdaccio access.
<!-- DOD:END -->
