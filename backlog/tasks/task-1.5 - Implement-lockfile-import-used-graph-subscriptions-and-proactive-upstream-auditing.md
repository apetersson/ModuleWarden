---
id: TASK-1.5
title: >-
  Implement lockfile import, used-graph subscriptions, and proactive upstream
  auditing
status: To Do
assignee: []
created_date: '2026-05-27 17:18'
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
- [ ] #1 CLI and API can import a project lockfile and store direct plus transitive package versions.
- [ ] #2 Imported dependencies are enqueued for audit before they become allowed baselines.
- [ ] #3 The subscription worker polls upstream metadata for used packages and records upstream dist-tags separately from approved client-facing tags.
- [ ] #4 New upstream versions for subscribed packages enqueue version-diff audits against the last allowed predecessor when one exists.
- [ ] #5 Cold-start packages without a predecessor are marked as full-review/cold-start cases, not silently treated as normal diffs.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Parse npm, pnpm, and yarn lockfiles enough for v1. Store project dependency graphs through Prisma. Subscribe to all packages in the used graph. Use pg-boss schedules/workers to poll upstream npm metadata and enqueue reviews for newer versions or changed tarball metadata.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Tests cover npm-lock, pnpm-lock, and yarn-lock happy paths plus transitive package subscription.
<!-- DOD:END -->
