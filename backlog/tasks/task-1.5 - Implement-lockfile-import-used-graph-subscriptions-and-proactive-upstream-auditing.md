---
id: TASK-1.5
title: >-
  Implement lockfile import, used-graph subscriptions, and proactive upstream
  auditing
status: In Progress
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:18'
updated_date: '2026-05-27 20:19'
labels:
  - lockfile
  - subscriptions
  - v1
dependencies:
  - TASK-1.3
  - TASK-1.4
  - TASK-1.16
parent_task_id: TASK-1
priority: high
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the mechanism that makes approved-only metadata usable in practice.

Because npm clients only see approved versions, ModuleWarden must not wait passively for developers to discover upstream releases. It must import project lockfiles, understand the full used dependency graph including transitive packages, subscribe to those packages upstream, and proactively audit newer versions using pg-boss scheduled jobs.

The initial baseline decision from planning is strict: audit before allow. Existing dependencies are not grandfathered as clean. The system should avoid making claims about historical safety beyond the current decision and evidence it records.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 CLI and API can import a project lockfile and store direct plus transitive package versions.
- [x] #2 Imported dependencies are enqueued for audit before they become allowed baselines.
- [x] #3 The subscription worker polls upstream metadata for used packages and records upstream dist-tags separately from approved client-facing tags.
- [x] #4 New upstream versions for subscribed packages enqueue version-diff audits against the last allowed predecessor when one exists.
- [x] #5 Cold-start packages without a predecessor are marked as full-review/cold-start cases, not silently treated as normal diffs.
- [x] #6 Lockfile import discovers all package versions from all configured lockfiles, including direct, transitive, dev, build, optional, and CI-installed dependencies by default.
- [x] #7 The first dogfood import uses ModuleWarden workspace pnpm lockfile data as the curated initial campaign input.
- [x] #8 Initial import creates cold-start audit jobs for every imported package version and does not create admin-baseline allow decisions.
- [x] #9 Project registry enablement is blocked until the imported graph reaches complete decision coverage.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Create lockfile parser service (npm package-lock.json, pnpm pnpm-lock.yaml, yarn.lock)\n2. Create lockfile import service storing packages and creating subscriptions\n3. Implement subscription poll worker for proactive upstream auditing\n4. Handle cold-start (no predecessor) marking\n5. Wire up project graph readiness check after import\n6. Write tests for all lockfile formats and import flow\n7. Commit and push
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Lockfile parser handles npm (v6/v7+), pnpm (yaml), and yarn formats\n- Import service upserts PackageVersions, creates PackageSubscriptions, enqueues ReviewJobs\n- Cold-start: all imported versions enqueued as cold-start (PREFLIGHT trigger, no predecessor)\n- Subscription poll: fetchUpstreamPackument, finds new versions, enqueues diff or cold-start audits\n- Project readiness: checkProjectReadiness blocks registry until all packages have decisions\n- 13 new tests (6 parser + 7 import), all passing
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Tests cover npm-lock, pnpm-lock, and yarn-lock happy paths plus transitive package subscription.
<!-- DOD:END -->
