---
id: TASK-1.1
title: Design the v1 architecture and threat model contract
status: To Do
assignee: []
created_date: '2026-05-27 17:18'
labels:
  - architecture
  - threat-model
  - v1
dependencies: []
parent_task_id: TASK-1
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Document the implementation contract for ModuleWarden v1 before deep feature work starts. The contract must be explicit enough to prevent future scope drift back into a vague “LLM artifactory” idea.

V1 scope is npm-only and focused on compromised-maintainer malicious version bumps in packages already present in the organization’s dependency graph. It may include exploit-discovery prompts, intent-mismatch review, and known-pattern checks, but the market claim to prove is “compromise catcher,” not “general novel vulnerability oracle.”

The architecture must capture the actual trust boundaries: developers only talk to ModuleWarden; ModuleWarden is the only writer/promoter into Verdaccio; audit containers are disposable and untrusted; the local OpenAI-compatible model endpoint is controlled by the operator; core prompts are hidden from developers and attackers but not promised to be secret from root infrastructure admins.

The architecture must also lock the persistence and asynchronous execution choices: Prisma is the application DB access layer, Postgres is the system of record, and pg-boss is the only durable event/job orchestration mechanism. Redis and Redis-backed queues are out of scope for v1.

The document should also explain the important critique from planning: shared vendor telemetry is valuable, static rules are bypassable, LLMs are not magic on arbitrary minified tarballs, and the defensible advantage is private semantic diff review over bounded version changes with rich evidence collection.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The document distinguishes supply-chain malware, compromised-maintainer version bumps, and novel vulnerability discovery as separate threat classes.
- [ ] #2 The document states that v1 optimizes for package-version diff review against a previously allowed predecessor.
- [ ] #3 The document explains why private prompts help: attackers cannot cheaply test against the exact prompt/rubric, unlike public static rules.
- [ ] #4 The document explicitly says prompts are hidden from developers and package code, but not protected from root administrators in v1.
- [ ] #5 The document defines allow, block, quarantine, override, re-audit, and currently allowed until revoked semantics.
- [ ] #6 The document states that Prisma owns DB access and pg-boss owns durable jobs/events; it explicitly excludes Redis from v1 architecture.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create an architecture/threat-model document in the repo that defines components, data flow, trust boundaries, threat model, non-goals, and v1 success criteria. Use this as the source of truth for subsequent tasks.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Architecture document reviewed against every major planning decision in this thread.
<!-- DOD:END -->
