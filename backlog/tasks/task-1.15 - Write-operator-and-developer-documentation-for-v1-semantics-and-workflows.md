---
id: TASK-1.15
title: Write operator and developer documentation for v1 semantics and workflows
status: To Do
assignee: []
created_date: '2026-05-27 17:19'
labels:
  - docs
  - dx
  - v1
dependencies:
  - TASK-1.1
  - TASK-1.4
  - TASK-1.11
  - TASK-1.12
  - TASK-1.16
parent_task_id: TASK-1
priority: medium
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Document ModuleWarden in a way that matches what it actually does.

The docs must avoid vague AI security claims. They should explain the specific threat model, the private prompt/rubric idea, the approved-only registry behavior, why some versions are hidden from flexible semver resolution, what a current allow means, how re-audits happen, and how security admins handle quarantine/overrides.

Developer docs should make npm install feel normal for approved packages and explain exactly what to do when something fails. Operator docs should explain Docker Compose deployment, local OpenAI-compatible endpoint configuration, Verdaccio service-token boundaries, static tokens, audit image customization, Prisma migrations, pg-boss jobs/schedules, no-Redis architecture, and evidence retention.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Quickstart explains how to start Compose, configure npm registry, import a lockfile, run preflight, and install through ModuleWarden.
- [ ] #2 Threat model docs state v1 target, non-goals, prompt secrecy boundary, vendor-signal tradeoffs, and why the proof standard is attack replay.
- [ ] #3 Developer workflow docs cover normal installs, failed exact fetches, status, explain, request, preflight, and doctor commands.
- [ ] #4 Security-admin docs cover quarantine, block, override, evidence review, prompt additions, and re-audit campaigns.
- [ ] #5 Operator docs cover token configuration, local model endpoint, Verdaccio write isolation, audit container image, and evidence storage.
- [ ] #6 Operator docs state that v1 uses Prisma for DB access and pg-boss for jobs/events, and that Redis is intentionally not part of the deployment.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create README and docs for quickstart, architecture, threat model, developer workflow, security-admin workflow, operator configuration, prompt/pattern updates, re-audit campaigns, and evaluation replay.
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Docs are linked from CLI doctor/status output and web UI where relevant.
<!-- DOD:END -->
