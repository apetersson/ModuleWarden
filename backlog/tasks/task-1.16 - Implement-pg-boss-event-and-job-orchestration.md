---
id: TASK-1.16
title: Implement pg-boss event and job orchestration
status: To Do
assignee: []
created_date: '2026-05-27 17:21'
labels:
  - jobs
  - events
  - pg-boss
  - postgres
  - v1
dependencies:
  - TASK-1.3
parent_task_id: TASK-1
priority: high
ordinal: 6500
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the event and job orchestration layer on top of Postgres using pg-boss. ModuleWarden has many asynchronous flows: exact tarball requests enqueue audits, CLI preflight enqueues missing package reviews, subscription polling discovers upstream versions, audit workers launch PI containers, suspicious first-pass results enqueue model escalation, prompt/model/pattern changes enqueue re-audit campaigns, and promotion jobs publish allowed tarballs into Verdaccio.

The explicit implementation decision is: use pg-boss for all durable events, background jobs, retries, scheduling, and worker coordination. Do not introduce Redis, BullMQ, Sidekiq-style Redis queues, or any separate queue broker in v1. Postgres is already required for provenance and decisions, so jobs and events should live in the same operational boundary.

The pg-boss layer must be treated as part of the product safety model, not just plumbing. Duplicate package-version audits must collapse to one active job, retries must not promote stale or superseded decisions, and every job should be correlated with persisted review/audit/evidence rows.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pg-boss is the only queue/event library planned for v1; no Redis service or Redis-backed queue appears in Compose, docs, or architecture.
- [ ] #2 Typed job definitions exist for package review enqueueing, upstream subscription polling, audit container execution, model escalation, re-audit campaigns, evidence post-processing, and Verdaccio promotion.
- [ ] #3 Jobs use deterministic idempotency keys for package name/version/tarball hash/audit context so duplicate tarball fetches and preflights do not create duplicate audits.
- [ ] #4 Retries, timeouts, cancellation, and dead-letter handling are documented and persist enough context to explain failed or abandoned audits.
- [ ] #5 Worker concurrency limits are configurable per job type, especially for expensive PI/container/model workloads.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a shared job module that wraps pg-boss with typed job names, payload schemas, idempotency keys, retry policies, scheduling helpers, and worker registration. Wire API/proxy, CLI/preflight handlers, subscription pollers, audit workers, prompt re-audit campaigns, escalation runs, and Verdaccio promotion through this module.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Integration tests prove enqueue/dedupe/retry/dead-letter behavior using Postgres and pg-boss only.
<!-- DOD:END -->
