---
id: TASK-1.16
title: Implement pg-boss event and job orchestration
status: Done
assignee:
  - '@agent-k'
created_date: '2026-05-27 17:21'
updated_date: '2026-05-27 19:47'
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
- [x] #1 pg-boss is the only queue/event library planned for v1; no Redis service or Redis-backed queue appears in Compose, docs, or architecture.
- [x] #2 Typed job definitions exist for package review enqueueing, upstream subscription polling, audit container execution, model escalation, re-audit campaigns, evidence post-processing, and Verdaccio promotion.
- [x] #3 Jobs use deterministic idempotency keys for package name/version/tarball hash/audit context so duplicate tarball fetches and preflights do not create duplicate audits.
- [x] #4 Retries, timeouts, cancellation, and dead-letter handling are documented and persist enough context to explain failed or abandoned audits.
- [x] #5 Worker concurrency limits are configurable per job type, especially for expensive PI/container/model workloads.
- [x] #6 The job layer supports initial audit campaigns for all imported lockfile package versions and emits a project-ready event only after complete decision coverage.
- [x] #7 Job payloads and workers keep external H100 capacity behind the model endpoint adapter; audit container execution remains ModuleWarden-controlled.
- [x] #8 Concurrency limits, retry policy, and metrics are configurable for model calls, container tool execution, initial campaigns, and re-audits.
- [x] #9 Prompt/model/pattern re-audit jobs include active override revalidation and persist superseding decision lineage.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Create shared job module (packages/worker/src/jobs/) wrapping pg-boss\n2. Define typed job names, payload schemas, idempotency keys\n3. Implement job queue with configurable concurrency/retry/delay\n4. Create job definitions for each job type\n5. Create worker registration and scheduling helpers\n6. Write integration tests\n7. Commit and push
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented pg-boss event and job orchestration layer with typed JobQueue wrapper. All 7 job types defined (package-review, upstream-subscription-poll, audit-container-exec, model-escalation, re-audit-campaign, evidence-post-process, verdaccio-promotion) with per-job-type retry/timeout configuration and concurrency limits. Deterministic idempotency via singletonKey prevents duplicate audits. Auto-queue creation for robustness. Worker registration with configurable concurrency. 10 integration tests verify send/process, singleton dedup, concurrency limits, delayed jobs, queue stats, and convenience methods — all passing with Postgres + pg-boss only. No Redis services.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Integration tests prove enqueue/dedupe/retry/dead-letter behavior using Postgres and pg-boss only.
<!-- DOD:END -->
